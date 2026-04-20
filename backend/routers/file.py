"""
文件操作路由

提供文件夹打开、文件存在检查、配置文件读取和媒体文件流接口。
"""

import mimetypes
import os
import platform
import shlex
import shutil
import subprocess
import tempfile
from datetime import datetime
from typing import Any, Dict, Optional

import requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from loguru import logger
from pydantic import BaseModel

from ..constants import DOWNLOAD_DIR
from ..lib.webdav_client import WebDAVClient
from ..settings import settings

router = APIRouter(prefix="/api/file", tags=["文件操作"])

# 允许的媒体文件扩展名
ALLOWED_MEDIA_EXTENSIONS = {".mp4", ".webm", ".jpg", ".jpeg", ".png", ".gif", ".webp"}
ALLOWED_VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"}



# ============================================================================
# 请求/响应模型
# ============================================================================


class OpenFolderRequest(BaseModel):
    """打开文件夹请求"""

    folder_path: str


class CheckFileExistsRequest(BaseModel):
    """检查文件存在请求"""

    file_path: str


class ReadConfigFileRequest(BaseModel):
    """读取配置文件请求"""

    file_path: str


class OpenFolderResponse(BaseModel):
    """打开文件夹响应"""

    success: bool


class CheckFileExistsResponse(BaseModel):
    """检查文件存在响应"""

    exists: bool


class ReadConfigFileResponse(BaseModel):
    """读取配置文件响应"""

    content: str


class FindLocalFileResponse(BaseModel):
    """查找本地文件响应"""

    found: bool
    video_path: Optional[str] = None
    images: Optional[list[str]] = None


class VideoFileItem(BaseModel):
    """视频文件条目"""

    path: str
    name: str
    size: int
    mtime: int


class ListVideosResponse(BaseModel):
    """视频列表响应"""

    files: list[VideoFileItem]


class TransformVideoRequest(BaseModel):
    """视频转码请求"""

    file_path: str
    ffmpeg_args: str = ""
    generate_subtitles: bool = False
    subtitle_language: Optional[str] = None
    subtitle_prompt: Optional[str] = None


class TransformVideoResponse(BaseModel):
    """视频转码响应"""

    success: bool
    output_path: Optional[str] = None
    subtitle_path: Optional[str] = None
    subtitle_json_path: Optional[str] = None
    subtitle_wav_path: Optional[str] = None
    error: Optional[str] = None


class GenerateSubtitleRequest(BaseModel):
    """视频字幕生成请求"""

    file_path: str
    subtitle_language: Optional[str] = None
    subtitle_prompt: Optional[str] = None


class GenerateSubtitleResponse(BaseModel):
    """视频字幕生成响应"""

    success: bool
    subtitle_path: Optional[str] = None
    subtitle_json_path: Optional[str] = None
    subtitle_wav_path: Optional[str] = None
    error: Optional[str] = None


class SubtitleCueItem(BaseModel):
    index: int
    start: str
    end: str
    text: str


class SubtitleFileRequest(BaseModel):
    file_path: str


class SaveSubtitleFileRequest(BaseModel):
    file_path: str
    cues: list[SubtitleCueItem]


class SubtitleFileResponse(BaseModel):
    success: bool
    file_path: Optional[str] = None
    cues: list[SubtitleCueItem] = []
    error: Optional[str] = None


class BurnSubtitleRequest(BaseModel):
    video_path: str
    subtitle_path: str
    font_name: str = "Noto Sans CJK SC"
    font_size: int = 18
    margin_v: int = 24
    outline: int = 2
    shadow: int = 0
    primary_color: str = "&H00FFFFFF"
    outline_color: str = "&H00000000"
    alignment: int = 2


class BurnSubtitleResponse(BaseModel):
    success: bool
    output_path: Optional[str] = None
    error: Optional[str] = None


class SubtitleApiTestResponse(BaseModel):
    success: bool
    detail: Optional[str] = None


class WebDAVConfigPayload(BaseModel):
    webdav_url: str
    webdav_username: str = ""
    webdav_password: str = ""
    webdav_base_path: str = ""


class UploadWebDAVRequest(WebDAVConfigPayload):
    """上传到 WebDAV 请求"""

    file_path: str
    category: str = "download"
    remote_dir: Optional[str] = None


class UploadWebDAVResponse(BaseModel):
    """上传到 WebDAV 响应"""

    success: bool
    remote_path: Optional[str] = None
    error: Optional[str] = None


class CopyLocalRequest(BaseModel):
    """复制到本地目录请求"""

    file_path: str
    target_dir: str


class CopyLocalResponse(BaseModel):
    """复制到本地目录响应"""

    success: bool
    output_path: Optional[str] = None
    error: Optional[str] = None


class VideoInfoRequest(BaseModel):
    """视频信息请求"""

    file_path: str


class VideoInfoResponse(BaseModel):
    """视频信息响应"""

    success: bool
    info: Dict[str, Any]
    error: Optional[str] = None


class WebDAVTestResponse(BaseModel):
    success: bool
    error: Optional[str] = None


class WebDAVListRequest(WebDAVConfigPayload):
    remote_dir: str = ""


class WebDAVDirectoryItem(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int = 0


class WebDAVListResponse(BaseModel):
    success: bool
    entries: list[WebDAVDirectoryItem]
    error: Optional[str] = None


class LocalListRequest(BaseModel):
    path: str = "/root"


class LocalEntryItem(BaseModel):
    name: str
    path: str
    is_dir: bool
    size: int = 0


class LocalListResponse(BaseModel):
    success: bool
    entries: list[LocalEntryItem]
    error: Optional[str] = None


class CreateDirectoryRequest(BaseModel):
    target_dir: str
    name: str


class RenamePathRequest(BaseModel):
    path: str
    new_name: str


class DeletePathRequest(BaseModel):
    path: str


class GenericPathResponse(BaseModel):
    success: bool
    path: Optional[str] = None
    error: Optional[str] = None


class WebDAVCreateDirectoryRequest(WebDAVConfigPayload, CreateDirectoryRequest):
    pass


class WebDAVRenamePathRequest(WebDAVConfigPayload, RenamePathRequest):
    pass


class WebDAVDeletePathRequest(WebDAVConfigPayload, DeletePathRequest):
    pass




def _get_download_dir() -> str:
    return os.path.abspath(settings.get("downloadPath", DOWNLOAD_DIR))


def _is_safe_path(download_dir: str, path: str) -> bool:
    abs_path = os.path.abspath(path)
    return abs_path.startswith(download_dir)


def _build_transformed_filename(file_name: str) -> str:
    base, ext = os.path.splitext(file_name)
    return f"{base}_tr{ext or '.mp4'}"


def _build_burned_filename(file_name: str) -> str:
    base, ext = os.path.splitext(file_name)
    return f"{base}_sub{ext or '.mp4'}"


def _build_subtitle_filename(file_name: str, ext: str = ".srt") -> str:
    base, _ = os.path.splitext(file_name)
    return f"{base}{ext}"


def _build_transformed_dir(download_dir: str) -> str:
    now = datetime.now()
    dir_path = os.path.join(
        download_dir,
        "transformed",
        now.strftime("%Y"),
        now.strftime("%m"),
        now.strftime("%d"),
    )
    os.makedirs(dir_path, exist_ok=True)
    return dir_path


def _build_day_parts() -> tuple[str, str, str]:
    now = datetime.now()
    return now.strftime("%Y"), now.strftime("%m"), now.strftime("%d")


def _build_dated_path(base_dir: str, file_name: str) -> str:
    year, month, day = _build_day_parts()
    dated_dir = os.path.join(base_dir, year, month, day)
    os.makedirs(dated_dir, exist_ok=True)
    return os.path.join(dated_dir, file_name)


def _relative_to_download_dir(download_dir: str, abs_path: str) -> str:
    return os.path.relpath(abs_path, download_dir).replace("\\", "/")


def _is_webdav_enabled_for(category: str) -> bool:
    if not settings.get("webdavEnabled", False):
        return False
    if category == "transform":
        return settings.get("webdavUploadTransformed", False)
    return settings.get("webdavUploadDownloads", False)


def _create_webdav_client_from_settings() -> WebDAVClient:
    return WebDAVClient(
        base_url=settings.get("webdavUrl", ""),
        username=settings.get("webdavUsername", ""),
        password=settings.get("webdavPassword", ""),
        base_path=settings.get("webdavBasePath", ""),
    )


def _create_webdav_client_from_payload(payload: WebDAVConfigPayload) -> WebDAVClient:
    return WebDAVClient(
        base_url=payload.webdav_url,
        username=payload.webdav_username,
        password=payload.webdav_password,
        base_path=payload.webdav_base_path,
    )


def _upload_to_webdav(
    abs_path: str,
    category: str,
    remote_dir: Optional[str] = None,
    client: Optional[WebDAVClient] = None,
) -> str:
    download_dir = _get_download_dir()
    if remote_dir is not None:
        year, month, day = _build_day_parts()
        rel_path = "/".join(
            part
            for part in [
                remote_dir.strip("/"),
                year,
                month,
                day,
                os.path.basename(abs_path),
            ]
            if part
        )
    else:
        rel_path = _relative_to_download_dir(download_dir, abs_path)
    active_client = client or _create_webdav_client_from_settings()
    return active_client.upload_file(abs_path, rel_path)


def _normalize_local_whisper_url(base_url: str) -> str:
    cleaned = base_url.strip().rstrip("/")
    if not cleaned:
        raise HTTPException(status_code=400, detail="本地 Whisper 地址不能为空")
    return cleaned


def _normalize_local_whisper_models_url(base_url: str) -> str:
    return f"{_normalize_local_whisper_url(base_url)}/models"


def _format_srt_timestamp(seconds: float) -> str:
    total_ms = max(int(round(seconds * 1000)), 0)
    hours = total_ms // 3600000
    minutes = (total_ms % 3600000) // 60000
    secs = (total_ms % 60000) // 1000
    millis = total_ms % 1000
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def _build_srt_content(transcript: Dict[str, Any]) -> str:
    segments = transcript.get("segments") or []
    lines: list[str] = []

    for idx, segment in enumerate(segments, start=1):
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        start = float(segment.get("start", 0) or 0)
        end = float(segment.get("end", start) or start)
        lines.extend(
            [
                str(idx),
                f"{_format_srt_timestamp(start)} --> {_format_srt_timestamp(end)}",
                text,
                "",
            ]
        )

    if lines:
        return "\n".join(lines).strip() + "\n"

    text = str(transcript.get("text", "")).strip()
    if not text:
        return ""

    return "\n".join(
        [
            "1",
            "00:00:00,000 --> 00:00:10,000",
            text,
            "",
        ]
    )


def _parse_srt_timestamp(timestamp: str) -> int:
    try:
        time_part, millis_part = timestamp.strip().split(",")
        hours_str, minutes_str, seconds_str = time_part.split(":")
        return (
            int(hours_str) * 3600000
            + int(minutes_str) * 60000
            + int(seconds_str) * 1000
            + int(millis_part)
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"SRT 时间格式错误: {timestamp}") from e


def _normalize_srt_timestamp(timestamp: str) -> str:
    return _format_srt_timestamp(_parse_srt_timestamp(timestamp) / 1000)


def _parse_srt_content(content: str) -> list[Dict[str, Any]]:
    normalized = content.replace("\r\n", "\n").strip()
    if not normalized:
        return []

    blocks = [block.strip() for block in normalized.split("\n\n") if block.strip()]
    cues: list[Dict[str, Any]] = []

    for fallback_index, block in enumerate(blocks, start=1):
        lines = [line.rstrip() for line in block.split("\n") if line.strip()]
        if len(lines) < 2:
            continue

        cursor = 0
        index = fallback_index
        if "-->" not in lines[0]:
            try:
                index = int(lines[0].strip())
                cursor = 1
            except ValueError:
                cursor = 0

        if cursor >= len(lines) or "-->" not in lines[cursor]:
            raise HTTPException(status_code=400, detail="SRT 内容格式错误，缺少时间轴")

        start_raw, end_raw = [part.strip() for part in lines[cursor].split("-->", 1)]
        text = "\n".join(lines[cursor + 1 :]).strip()
        cues.append(
            {
                "index": index,
                "start": _normalize_srt_timestamp(start_raw),
                "end": _normalize_srt_timestamp(end_raw),
                "text": text,
            }
        )

    return cues


def _build_srt_from_cues(cues: list[SubtitleCueItem]) -> str:
    lines: list[str] = []

    ordered_cues = sorted(cues, key=lambda cue: _parse_srt_timestamp(cue.start))
    for idx, cue in enumerate(ordered_cues, start=1):
        start = _normalize_srt_timestamp(cue.start)
        end = _normalize_srt_timestamp(cue.end)
        if _parse_srt_timestamp(end) <= _parse_srt_timestamp(start):
            raise HTTPException(status_code=400, detail=f"字幕第 {idx} 条结束时间必须大于开始时间")
        text = cue.text.strip()
        lines.extend(
            [
                str(idx),
                f"{start} --> {end}",
                text,
                "",
            ]
        )

    return "\n".join(lines).strip() + ("\n" if lines else "")


def _generate_subtitles(
    source_video_path: str,
    output_video_path: str,
    language: Optional[str] = None,
    prompt: Optional[str] = None,
) -> tuple[str, str, str]:
    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="未检测到 ffmpeg，请先安装并加入 PATH")

    whisper_url = settings.get("subtitleLocalWhisperUrl", "").strip()
    model = settings.get("subtitleLocalModel", "").strip()
    word_timestamps = bool(settings.get("subtitleWordTimestamps", True))
    effective_language = (language or settings.get("subtitleLanguage", "") or "").strip()
    effective_prompt = (prompt or settings.get("subtitlePrompt", "") or "").strip()
    if not whisper_url:
        raise HTTPException(status_code=400, detail="未配置本地 Whisper 地址")
    if not model:
        raise HTTPException(status_code=400, detail="未配置本地 Whisper 模型")

    wav_output_path = os.path.join(
        os.path.dirname(output_video_path),
        _build_subtitle_filename(os.path.basename(output_video_path), ".wav"),
    )

    extract_command = [
        ffmpeg_path,
        "-i",
        source_video_path,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        "-y",
        wav_output_path,
    ]

    logger.info(f"开始提取字幕音轨: {' '.join(extract_command)}")

    try:
        extract_result = subprocess.run(
            extract_command,
            capture_output=True,
            text=True,
            check=False,
        )
        if extract_result.returncode != 0:
            error_msg = (extract_result.stderr or extract_result.stdout or "").strip()
            raise HTTPException(
                status_code=500,
                detail=f"提取音频失败: {error_msg or 'ffmpeg 执行失败'}",
            )

        request_url = f"{_normalize_local_whisper_url(whisper_url)}/transcribe"
        data: list[tuple[str, str]] = [("model", model), ("task", "transcribe")]
        if effective_language:
            data.append(("language", effective_language))
        if effective_prompt:
            data.append(("initial_prompt", effective_prompt))
        data.append(("word_timestamps", "true" if word_timestamps else "false"))

        with open(wav_output_path, "rb") as f:
            files = {"file": (os.path.basename(wav_output_path), f, "audio/wav")}
            response = requests.post(request_url, data=data, files=files, timeout=600)

        if response.status_code >= 400:
            detail = response.text.strip() or f"HTTP {response.status_code}"
            raise HTTPException(status_code=500, detail=f"本地 Whisper 字幕生成失败: {detail}")

        try:
            transcript = response.json()
        except ValueError as e:
            raise HTTPException(status_code=500, detail=f"本地 Whisper 返回的不是 JSON: {e}")

        srt_content = _build_srt_content(transcript)
        if not srt_content.strip():
            raise HTTPException(status_code=500, detail="本地 Whisper 未返回有效文本")

        subtitle_path = os.path.join(
            os.path.dirname(output_video_path),
            _build_subtitle_filename(os.path.basename(output_video_path), ".srt"),
        )
        subtitle_json_path = os.path.join(
            os.path.dirname(output_video_path),
            _build_subtitle_filename(os.path.basename(output_video_path), ".json"),
        )

        with open(subtitle_path, "w", encoding="utf-8") as f:
            f.write(srt_content)
        with open(subtitle_json_path, "w", encoding="utf-8") as f:
            import ujson as json

            json.dump(transcript, f, ensure_ascii=False, indent=2)

        return subtitle_path, subtitle_json_path, wav_output_path
    except requests.RequestException as e:
        raise HTTPException(status_code=500, detail=f"本地 Whisper 请求失败: {e}")


def _resolve_video_path(file_path: str) -> tuple[str, str]:
    download_dir = _get_download_dir()
    input_path = os.path.abspath(os.path.join(download_dir, file_path))

    if not _is_safe_path(download_dir, input_path):
        raise HTTPException(status_code=400, detail="文件路径不安全")

    if not os.path.exists(input_path) or not os.path.isfile(input_path):
        raise HTTPException(status_code=404, detail="视频文件不存在")

    ext = os.path.splitext(input_path)[1].lower()
    if ext not in ALLOWED_VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的视频格式")

    return download_dir, input_path


def _resolve_subtitle_path(file_path: str) -> tuple[str, str]:
    download_dir = _get_download_dir()
    subtitle_path = os.path.abspath(os.path.join(download_dir, file_path))

    if not _is_safe_path(download_dir, subtitle_path):
        raise HTTPException(status_code=400, detail="文件路径不安全")
    if not os.path.exists(subtitle_path) or not os.path.isfile(subtitle_path):
        raise HTTPException(status_code=404, detail="字幕文件不存在")
    if os.path.splitext(subtitle_path)[1].lower() != ".srt":
        raise HTTPException(status_code=400, detail="仅支持编辑 .srt 字幕文件")

    return download_dir, subtitle_path


def _escape_subtitle_filter_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    return (
        normalized.replace(":", r"\:")
        .replace("'", r"\'")
        .replace(",", r"\,")
        .replace("[", r"\[")
        .replace("]", r"\]")
    )


def _normalize_ass_color(color: str, fallback: str) -> str:
    value = (color or "").strip()
    if not value:
        return fallback
    if value.startswith("&H"):
        return value.upper()
    if value.startswith("#"):
        hex_color = value[1:].upper()
        if len(hex_color) == 6:
            rr, gg, bb = hex_color[0:2], hex_color[2:4], hex_color[4:6]
            return f"&H00{bb}{gg}{rr}"
    return fallback




# ============================================================================
# 路由定义
# ============================================================================


@router.post("/open-folder", response_model=OpenFolderResponse)
def open_folder(request: OpenFolderRequest) -> Dict[str, bool]:
    """
    打开文件夹

    在系统文件管理器中打开指定的文件夹。
    """
    folder_path = request.folder_path
    logger.info(f"打开文件夹: {folder_path}")

    try:
        # 确保路径存在
        if not os.path.exists(folder_path):
            logger.error(f"文件夹不存在: {folder_path}")
            return {"success": False}

        # 如果是文件路径，获取其所在目录
        if os.path.isfile(folder_path):
            folder_path = os.path.dirname(folder_path)

        system = platform.system()

        if system == "Windows":
            # Windows: 使用 os.startfile
            normalized_path = os.path.abspath(folder_path).replace("/", "\\")
            os.startfile(normalized_path)
        elif system == "Darwin":
            # macOS: 使用 open
            subprocess.Popen(["open", folder_path])
        else:
            # Linux: 使用 xdg-open
            subprocess.Popen(["xdg-open", folder_path])

        logger.info(f"✓ 已打开文件夹: {folder_path}")
        return {"success": True}

    except Exception as e:
        logger.error(f"✗ 打开文件夹失败: {e}")
        return {"success": False}


@router.post("/check-exists", response_model=CheckFileExistsResponse)
def check_file_exists(request: CheckFileExistsRequest) -> Dict[str, bool]:
    """
    检查文件是否存在

    - file_path: 文件路径
    """

    file_path = request.file_path

    try:
        # 安全检查：确保文件路径在下载目录内
        download_dir = os.path.abspath(settings.get("downloadPath", DOWNLOAD_DIR))
        abs_path = os.path.abspath(file_path)

        if not abs_path.startswith(download_dir):
            return {"exists": False}

        return {"exists": os.path.exists(abs_path) and os.path.isfile(abs_path)}

    except Exception as e:
        logger.error(f"检查文件存在失败: {e}")
        return {"exists": False}


@router.post("/read-config", response_model=ReadConfigFileResponse)
def read_config_file(request: ReadConfigFileRequest) -> Dict[str, str]:
    """
    读取配置文件内容

    - file_path: 配置文件路径（必须在下载目录内，且为 .txt 文件）
    """

    file_path = request.file_path

    try:
        logger.info(f"开始读取配置文件: {file_path}")

        # 安全检查：确保文件路径在下载目录内
        download_dir = os.path.abspath(settings.get("downloadPath", DOWNLOAD_DIR))
        abs_path = os.path.abspath(file_path)

        if not abs_path.startswith(download_dir) or not abs_path.endswith(".txt"):
            logger.error(f"文件路径不安全: {abs_path}")
            raise HTTPException(status_code=400, detail="文件路径不安全")

        if not os.path.exists(abs_path):
            logger.error(f"配置文件不存在: {abs_path}")
            raise HTTPException(status_code=404, detail=f"配置文件不存在: {abs_path}")

        with open(abs_path, "r", encoding="utf-8") as f:
            content = f.read()
            logger.info(f"配置文件读取成功，内容长度: {len(content)} 字符")
            return {"content": content}

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"读取配置文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/find-local/{work_id}", response_model=FindLocalFileResponse)
def find_local_file(work_id: str) -> Dict[str, Any]:
    """
    根据作品 ID 查找本地已下载的文件

    - work_id: 作品 ID

    返回:
    - found: 是否找到
    - video_path: 视频文件的相对路径（相对于下载目录）
    - images: 图片文件的相对路径列表
    """
    try:
        download_dir = os.path.abspath(settings.get("downloadPath", DOWNLOAD_DIR))

        video_matches: list[str] = []
        image_matches: list[str] = []

        for root, _, files in os.walk(download_dir):
            for name in files:
                if not name.startswith(f"{work_id}_"):
                    continue
                abs_path = os.path.join(root, name)
                ext = os.path.splitext(name)[1].lower()
                if ext in ALLOWED_VIDEO_EXTENSIONS:
                    video_matches.append(abs_path)
                elif ext in {".jpg", ".jpeg", ".png", ".webp"}:
                    image_matches.append(abs_path)

        if video_matches:
            video_matches.sort()
            return {
                "found": True,
                "video_path": _relative_to_download_dir(download_dir, video_matches[0]),
                "images": None,
            }

        if image_matches:
            image_matches.sort()
            return {
                "found": True,
                "video_path": None,
                "images": [
                    _relative_to_download_dir(download_dir, path)
                    for path in image_matches
                ],
            }

        return {"found": False, "video_path": None, "images": None}

    except Exception as e:
        logger.error(f"查找本地文件失败: {e}")
        return {"found": False, "video_path": None, "images": None}


@router.get("/videos", response_model=ListVideosResponse)
def list_downloaded_videos() -> Dict[str, list[Dict[str, Any]]]:
    """
    获取下载目录中的视频文件列表（递归）。
    """
    try:
        download_dir = _get_download_dir()
        if not os.path.exists(download_dir):
            return {"files": []}

        files: list[Dict[str, Any]] = []
        for root, _, names in os.walk(download_dir):
            for name in names:
                ext = os.path.splitext(name)[1].lower()
                if ext not in ALLOWED_VIDEO_EXTENSIONS:
                    continue

                abs_path = os.path.join(root, name)
                stat = os.stat(abs_path)
                files.append(
                    {
                        "path": os.path.relpath(abs_path, download_dir),
                        "name": name,
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                    }
                )

        files.sort(key=lambda item: item["mtime"], reverse=True)
        return {"files": files}

    except Exception as e:
        logger.error(f"获取视频列表失败: {e}")
        raise HTTPException(status_code=500, detail="获取视频列表失败")


@router.post("/transform", response_model=TransformVideoResponse)
def transform_video(request: TransformVideoRequest) -> Dict[str, Any]:
    """
    使用 ffmpeg 对已下载视频做转码处理。

    ffmpeg_args 为附加参数，不需要包含 -i 和输出文件。
    """
    download_dir, input_path = _resolve_video_path(request.file_path)

    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="未检测到 ffmpeg，请先安装并加入 PATH")

    output_name = _build_transformed_filename(os.path.basename(input_path))
    output_path = os.path.join(_build_transformed_dir(download_dir), output_name)

    try:
        extra_args = shlex.split(request.ffmpeg_args.strip()) if request.ffmpeg_args else []
    except ValueError as e:
        raise HTTPException(status_code=400, detail=f"ffmpeg 参数格式错误: {e}")

    for arg in extra_args:
        if arg == "-i":
            raise HTTPException(status_code=400, detail="ffmpeg 参数中不允许包含 -i")

    command = [ffmpeg_path, "-i", input_path, *extra_args, "-y", output_path]
    logger.info(f"开始视频转码: {' '.join(command)}")

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        output_lines: list[str] = []

        if process.stdout is not None:
            for line in process.stdout:
                line = line.rstrip()
                if not line:
                    continue
                output_lines.append(line)
                logger.info(f"[ffmpeg] {line}")

        return_code = process.wait()

        if return_code != 0:
            error_msg = "\n".join(output_lines[-20:]) or "ffmpeg 执行失败"
            logger.error(f"视频转码失败: {error_msg}")
            raise HTTPException(status_code=500, detail=error_msg)

        rel_path = os.path.relpath(output_path, download_dir)
        subtitle_rel_path: Optional[str] = None
        subtitle_json_rel_path: Optional[str] = None
        subtitle_wav_rel_path: Optional[str] = None
        logger.info(f"✓ 视频转码完成: {rel_path}")

        if request.generate_subtitles:
            subtitle_path, subtitle_json_path, subtitle_wav_path = _generate_subtitles(
                source_video_path=output_path,
                output_video_path=output_path,
                language=request.subtitle_language,
                prompt=request.subtitle_prompt,
            )
            subtitle_rel_path = os.path.relpath(subtitle_path, download_dir)
            subtitle_json_rel_path = os.path.relpath(subtitle_json_path, download_dir)
            subtitle_wav_rel_path = os.path.relpath(subtitle_wav_path, download_dir)
            logger.info(f"✓ 字幕生成完成: {subtitle_rel_path}")

        if _is_webdav_enabled_for("transform"):
            try:
                remote_path = _upload_to_webdav(output_path, "transform")
                logger.info(f"✓ 转码文件已上传到 WebDAV: {remote_path}")
                if subtitle_rel_path:
                    subtitle_remote_path = _upload_to_webdav(
                        os.path.join(download_dir, subtitle_rel_path),
                        "transform",
                    )
                    logger.info(f"✓ 字幕文件已上传到 WebDAV: {subtitle_remote_path}")
                if subtitle_json_rel_path:
                    subtitle_json_remote_path = _upload_to_webdav(
                        os.path.join(download_dir, subtitle_json_rel_path),
                        "transform",
                    )
                    logger.info(
                        f"✓ 字幕 JSON 已上传到 WebDAV: {subtitle_json_remote_path}"
                    )
                if subtitle_wav_rel_path:
                    subtitle_wav_remote_path = _upload_to_webdav(
                        os.path.join(download_dir, subtitle_wav_rel_path),
                        "transform",
                    )
                    logger.info(f"✓ 字幕 WAV 已上传到 WebDAV: {subtitle_wav_remote_path}")
            except Exception as e:
                logger.error(f"✗ 转码文件上传 WebDAV 失败: {e}")

        return {
            "success": True,
            "output_path": rel_path,
            "subtitle_path": subtitle_rel_path,
            "subtitle_json_path": subtitle_json_rel_path,
            "subtitle_wav_path": subtitle_wav_rel_path,
            "error": None,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"视频转码异常: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/subtitles", response_model=GenerateSubtitleResponse)
def generate_subtitles(request: GenerateSubtitleRequest) -> Dict[str, Any]:
    """
    为已下载视频单独生成字幕，不做转码。
    """
    download_dir, input_path = _resolve_video_path(request.file_path)

    try:
        subtitle_path, subtitle_json_path, subtitle_wav_path = _generate_subtitles(
            source_video_path=input_path,
            output_video_path=input_path,
            language=request.subtitle_language,
            prompt=request.subtitle_prompt,
        )
        subtitle_rel_path = os.path.relpath(subtitle_path, download_dir)
        subtitle_json_rel_path = os.path.relpath(subtitle_json_path, download_dir)
        subtitle_wav_rel_path = os.path.relpath(subtitle_wav_path, download_dir)
        logger.info(f"✓ 独立字幕生成完成: {subtitle_rel_path}")

        if _is_webdav_enabled_for("transform"):
            try:
                subtitle_remote_path = _upload_to_webdav(subtitle_path, "transform")
                logger.info(f"✓ 字幕文件已上传到 WebDAV: {subtitle_remote_path}")
                subtitle_json_remote_path = _upload_to_webdav(
                    subtitle_json_path,
                    "transform",
                )
                logger.info(f"✓ 字幕 JSON 已上传到 WebDAV: {subtitle_json_remote_path}")
                subtitle_wav_remote_path = _upload_to_webdav(
                    subtitle_wav_path,
                    "transform",
                )
                logger.info(f"✓ 字幕 WAV 已上传到 WebDAV: {subtitle_wav_remote_path}")
            except Exception as e:
                logger.error(f"✗ 字幕文件上传 WebDAV 失败: {e}")

        return {
            "success": True,
            "subtitle_path": subtitle_rel_path,
            "subtitle_json_path": subtitle_json_rel_path,
            "subtitle_wav_path": subtitle_wav_rel_path,
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"独立字幕生成异常: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/subtitle/test-api", response_model=SubtitleApiTestResponse)
def test_subtitle_api() -> Dict[str, Any]:
    whisper_url = settings.get("subtitleLocalWhisperUrl", "").strip()
    if not whisper_url:
        raise HTTPException(status_code=400, detail="未配置本地 Whisper 地址")
    models_url = _normalize_local_whisper_models_url(whisper_url)

    try:
        response = requests.get(models_url, timeout=30)
        if response.status_code >= 400:
            detail = response.text.strip() or f"HTTP {response.status_code}"
            return {"success": False, "detail": detail}
        return {"success": True, "detail": "本地 Whisper 连接成功"}
    except requests.RequestException as e:
        return {"success": False, "detail": str(e)}


@router.post("/subtitle/read", response_model=SubtitleFileResponse)
def read_subtitle_file(request: SubtitleFileRequest) -> Dict[str, Any]:
    download_dir, subtitle_path = _resolve_subtitle_path(request.file_path)

    try:
        with open(subtitle_path, "r", encoding="utf-8-sig") as f:
            content = f.read()
        cues = _parse_srt_content(content)
        return {
            "success": True,
            "file_path": _relative_to_download_dir(download_dir, subtitle_path),
            "cues": cues,
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"读取字幕文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/subtitle/save", response_model=SubtitleFileResponse)
def save_subtitle_file(request: SaveSubtitleFileRequest) -> Dict[str, Any]:
    download_dir, subtitle_path = _resolve_subtitle_path(request.file_path)

    try:
        content = _build_srt_from_cues(request.cues)
        with open(subtitle_path, "w", encoding="utf-8") as f:
            f.write(content)
        logger.info(f"✓ 字幕文件已保存: {subtitle_path}")
        return {
            "success": True,
            "file_path": _relative_to_download_dir(download_dir, subtitle_path),
            "cues": _parse_srt_content(content),
            "error": None,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"保存字幕文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/subtitle/burn", response_model=BurnSubtitleResponse)
def burn_subtitle_into_video(request: BurnSubtitleRequest) -> Dict[str, Any]:
    download_dir, input_video_path = _resolve_video_path(request.video_path)
    _, subtitle_path = _resolve_subtitle_path(request.subtitle_path)

    ffmpeg_path = shutil.which("ffmpeg")
    if not ffmpeg_path:
        raise HTTPException(status_code=500, detail="未检测到 ffmpeg，请先安装并加入 PATH")

    output_path = os.path.join(
        os.path.dirname(input_video_path),
        _build_burned_filename(os.path.basename(input_video_path)),
    )

    style_parts = [
        f"FontName={request.font_name.strip() or 'Noto Sans CJK SC'}",
        f"FontSize={request.font_size}",
        f"PrimaryColour={_normalize_ass_color(request.primary_color, '&H00FFFFFF')}",
        f"OutlineColour={_normalize_ass_color(request.outline_color, '&H00000000')}",
        "BorderStyle=1",
        f"Outline={request.outline}",
        f"Shadow={request.shadow}",
        f"MarginV={request.margin_v}",
        f"Alignment={request.alignment}",
    ]
    subtitle_filter = (
        f"subtitles='{_escape_subtitle_filter_path(subtitle_path)}':"
        f"force_style='{','.join(style_parts)}'"
    )

    command = [
        ffmpeg_path,
        "-i",
        input_video_path,
        "-vf",
        subtitle_filter,
        "-c:a",
        "copy",
        "-y",
        output_path,
    ]
    logger.info(f"开始烧录内嵌字幕: {' '.join(command)}")

    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        output_lines: list[str] = []

        if process.stdout is not None:
            for line in process.stdout:
                line = line.rstrip()
                if not line:
                    continue
                output_lines.append(line)
                logger.info(f"[ffmpeg-sub] {line}")

        return_code = process.wait()
        if return_code != 0:
            error_msg = "\n".join(output_lines[-20:]) or "ffmpeg 执行失败"
            raise HTTPException(status_code=500, detail=error_msg)

        rel_path = _relative_to_download_dir(download_dir, output_path)
        logger.info(f"✓ 内嵌字幕视频已生成: {rel_path}")

        if _is_webdav_enabled_for("transform"):
            try:
                remote_path = _upload_to_webdav(output_path, "transform")
                logger.info(f"✓ 内嵌字幕视频已上传到 WebDAV: {remote_path}")
            except Exception as e:
                logger.error(f"✗ 内嵌字幕视频上传 WebDAV 失败: {e}")

        return {"success": True, "output_path": rel_path, "error": None}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"烧录内嵌字幕异常: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/copy-local", response_model=CopyLocalResponse)
def copy_file_to_local(request: CopyLocalRequest) -> Dict[str, Any]:
    download_dir = _get_download_dir()
    abs_path = os.path.abspath(os.path.join(download_dir, request.file_path))

    if not _is_safe_path(download_dir, abs_path):
        raise HTTPException(status_code=400, detail="文件路径不安全")

    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        output_path = _build_dated_path(request.target_dir, os.path.basename(abs_path))
        shutil.copy2(abs_path, output_path)
        logger.info(f"✓ 文件已复制到本地目录: {output_path}")
        return {"success": True, "output_path": output_path, "error": None}
    except Exception as e:
        logger.error(f"✗ 本地复制失败: {e}")
        return {"success": False, "output_path": None, "error": str(e)}


@router.post("/local-list", response_model=LocalListResponse)
def list_local_entries(request: LocalListRequest) -> Dict[str, Any]:
    path = os.path.abspath(request.path or "/root")
    if not os.path.exists(path):
        return {"success": False, "entries": [], "error": "目录不存在"}
    if not os.path.isdir(path):
        return {"success": False, "entries": [], "error": "目标不是目录"}

    try:
        entries: list[Dict[str, Any]] = []
        for name in os.listdir(path):
            abs_path = os.path.join(path, name)
            try:
                stat = os.stat(abs_path)
            except OSError:
                continue
            entries.append(
                {
                    "name": name,
                    "path": abs_path,
                    "is_dir": os.path.isdir(abs_path),
                    "size": 0 if os.path.isdir(abs_path) else int(stat.st_size),
                }
            )
        entries.sort(key=lambda item: (not item["is_dir"], item["name"].lower()))
        return {"success": True, "entries": entries, "error": None}
    except Exception as e:
        logger.error(f"读取本地目录失败: {e}")
        return {"success": False, "entries": [], "error": str(e)}


@router.post("/local-mkdir", response_model=GenericPathResponse)
def create_local_directory(request: CreateDirectoryRequest) -> Dict[str, Any]:
    try:
        target_dir = os.path.abspath(request.target_dir)
        name = request.name.strip()
        if not name:
            raise ValueError("目录名不能为空")
        output_path = os.path.join(target_dir, name)
        os.makedirs(output_path, exist_ok=True)
        logger.info(f"✓ 本地目录已创建: {output_path}")
        return {"success": True, "path": output_path, "error": None}
    except Exception as e:
        logger.error(f"✗ 本地目录创建失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.post("/local-rename", response_model=GenericPathResponse)
def rename_local_path(request: RenamePathRequest) -> Dict[str, Any]:
    try:
        source_path = os.path.abspath(request.path)
        new_name = request.new_name.strip()
        if not new_name:
            raise ValueError("新名称不能为空")
        if not os.path.exists(source_path):
            raise FileNotFoundError("目标不存在")
        target_path = os.path.join(os.path.dirname(source_path), new_name)
        os.rename(source_path, target_path)
        logger.info(f"✓ 本地路径已重命名: {source_path} -> {target_path}")
        return {"success": True, "path": target_path, "error": None}
    except Exception as e:
        logger.error(f"✗ 本地重命名失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.post("/local-delete", response_model=GenericPathResponse)
def delete_local_path(request: DeletePathRequest) -> Dict[str, Any]:
    abs_path = os.path.abspath(request.path)

    if abs_path in {"/", ""}:
        raise HTTPException(status_code=400, detail="禁止删除根目录")

    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="本地路径不存在")

    try:
        if os.path.isdir(abs_path):
            shutil.rmtree(abs_path)
        else:
            os.remove(abs_path)
        logger.info(f"✓ 本地路径已删除: {abs_path}")
        return {"success": True, "path": abs_path, "error": None}
    except Exception as e:
        logger.error(f"✗ 本地删除失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.post("/video-info", response_model=VideoInfoResponse)
def get_video_info(request: VideoInfoRequest) -> Dict[str, Any]:
    download_dir = _get_download_dir()
    abs_path = os.path.abspath(os.path.join(download_dir, request.file_path))

    if not _is_safe_path(download_dir, abs_path):
        raise HTTPException(status_code=400, detail="文件路径不安全")

    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    ffprobe_path = shutil.which("ffprobe")
    if not ffprobe_path:
        raise HTTPException(status_code=500, detail="未检测到 ffprobe")

    command = [
        ffprobe_path,
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,bit_rate:stream=codec_name,width,height,r_frame_rate",
        "-of",
        "json",
        abs_path,
    ]

    try:
        result = subprocess.run(command, capture_output=True, text=True, check=False)
        if result.returncode != 0:
            raise RuntimeError(result.stderr.strip() or "ffprobe 执行失败")

        import json

        raw = json.loads(result.stdout or "{}")
        streams = raw.get("streams", [])
        video_stream = next((item for item in streams if item.get("width")), {})
        format_info = raw.get("format", {})
        info = {
            "name": os.path.basename(abs_path),
            "path": request.file_path,
            "duration": float(format_info.get("duration", 0) or 0),
            "size": int(float(format_info.get("size", 0) or 0)),
            "bit_rate": int(float(format_info.get("bit_rate", 0) or 0)),
            "codec": video_stream.get("codec_name", ""),
            "width": int(video_stream.get("width", 0) or 0),
            "height": int(video_stream.get("height", 0) or 0),
            "frame_rate": video_stream.get("r_frame_rate", ""),
        }
        return {"success": True, "info": info, "error": None}
    except Exception as e:
        logger.error(f"获取视频信息失败: {e}")
        return {"success": False, "info": {}, "error": str(e)}


@router.post("/upload-webdav", response_model=UploadWebDAVResponse)
def upload_file_to_webdav(request: UploadWebDAVRequest) -> Dict[str, Any]:
    download_dir = _get_download_dir()
    abs_path = os.path.abspath(os.path.join(download_dir, request.file_path))

    if not _is_safe_path(download_dir, abs_path):
        raise HTTPException(status_code=400, detail="文件路径不安全")

    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail="文件不存在")

    try:
        has_runtime_config = bool(request.webdav_url.strip())
        if has_runtime_config:
            client = _create_webdav_client_from_payload(request)
        else:
            if not settings.get("webdavEnabled", False):
                raise HTTPException(status_code=400, detail="WebDAV 未启用，且未提供当前连接配置")
            client = _create_webdav_client_from_settings()

        remote_path = _upload_to_webdav(
            abs_path,
            request.category,
            request.remote_dir,
            client=client,
        )
        logger.info(f"✓ 文件已上传到 WebDAV: {request.file_path}")
        return {"success": True, "remote_path": remote_path, "error": None}
    except Exception as e:
        logger.error(f"✗ WebDAV 上传失败: {e}")
        return {"success": False, "remote_path": None, "error": str(e)}


@router.post("/webdav/test", response_model=WebDAVTestResponse)
def test_webdav_connection(request: WebDAVConfigPayload) -> Dict[str, Any]:
    try:
        client = _create_webdav_client_from_payload(request)
        if not client.test_connection():
            raise RuntimeError("WebDAV 连接测试失败")
        return {"success": True, "error": None}
    except Exception as e:
        logger.error(f"WebDAV 测试连接失败: {e}")
        return {"success": False, "error": str(e)}


@router.post("/webdav/list", response_model=WebDAVListResponse)
def list_webdav_directories(request: WebDAVListRequest) -> Dict[str, Any]:
    try:
        client = _create_webdav_client_from_payload(request)
        entries = client.list_entries(request.remote_dir)
        return {"success": True, "entries": entries, "error": None}
    except Exception as e:
        logger.error(f"WebDAV 读取目录失败: {e}")
        return {"success": False, "entries": [], "error": str(e)}


@router.post("/webdav/mkdir", response_model=GenericPathResponse)
def create_webdav_directory(request: WebDAVCreateDirectoryRequest) -> Dict[str, Any]:
    try:
        client = _create_webdav_client_from_payload(request)
        name = request.name.strip()
        if not name:
            raise ValueError("目录名不能为空")
        target_dir = "/".join(
            part for part in [request.target_dir.strip("/"), name] if part
        )
        output_path = client.create_directory(target_dir)
        return {"success": True, "path": output_path, "error": None}
    except Exception as e:
        logger.error(f"WebDAV 创建目录失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.post("/webdav/rename", response_model=GenericPathResponse)
def rename_webdav_path(request: WebDAVRenamePathRequest) -> Dict[str, Any]:
    try:
        client = _create_webdav_client_from_payload(request)
        source_path = request.path.strip("/")
        new_name = request.new_name.strip()
        if not source_path:
            raise ValueError("原路径不能为空")
        if not new_name:
            raise ValueError("新名称不能为空")
        target_path = "/".join(
            part for part in [os.path.dirname(source_path).strip("/"), new_name] if part
        )
        output_path = client.rename_path(source_path, target_path)
        return {"success": True, "path": output_path, "error": None}
    except Exception as e:
        logger.error(f"WebDAV 重命名失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.post("/webdav/delete", response_model=GenericPathResponse)
def delete_webdav_path(request: WebDAVDeletePathRequest) -> Dict[str, Any]:
    if not request.path.strip("/"):
        raise HTTPException(status_code=400, detail="禁止删除 WebDAV 基准目录")

    try:
        client = _create_webdav_client_from_payload(request)
        output_path = client.delete_path(request.path)
        return {"success": True, "path": output_path, "error": None}
    except Exception as e:
        logger.error(f"WebDAV 删除失败: {e}")
        return {"success": False, "path": None, "error": str(e)}


@router.get("/media/{file_path:path}")
def serve_media(file_path: str):
    """
    提供媒体文件流服务

    - file_path: 相对于下载目录的文件路径

    支持 Range 请求，可用于视频播放进度拖动。
    """
    try:
        download_dir = os.path.abspath(settings.get("downloadPath", DOWNLOAD_DIR))
        abs_path = os.path.abspath(os.path.join(download_dir, file_path))

        # 安全检查：确保路径在下载目录内
        if not abs_path.startswith(download_dir):
            logger.warning(f"非法路径访问: {file_path}")
            raise HTTPException(status_code=403, detail="禁止访问")

        # 检查文件是否存在
        if not os.path.exists(abs_path) or not os.path.isfile(abs_path):
            raise HTTPException(status_code=404, detail="文件不存在")

        # 检查文件扩展名
        ext = os.path.splitext(abs_path)[1].lower()
        if ext not in ALLOWED_MEDIA_EXTENSIONS:
            raise HTTPException(status_code=403, detail="不支持的文件类型")

        # 获取 MIME 类型
        content_type = mimetypes.guess_type(abs_path)[0] or "application/octet-stream"

        # 使用 FileResponse，自动支持 Range 请求
        return FileResponse(
            path=abs_path,
            media_type=content_type,
            filename=os.path.basename(abs_path),
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"提供媒体文件失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
