# -*- encoding: utf-8 -*-
"""
设置管理路由

提供应用设置的查询、保存以及 Whisper 容器状态管理接口。
"""

import os
import subprocess
from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from loguru import logger
from pydantic import BaseModel, Field

from ..constants import ARIA2_DEFAULTS, DEFAULT_SETTINGS, DOWNLOAD_DEFAULTS
from ..settings import settings

router = APIRouter(prefix="/api/settings", tags=["设置管理"])


# ============================================================================
# 请求/响应模型
# ============================================================================


class SettingsUpdate(BaseModel):
    """设置更新请求模型（支持部分更新）"""

    cookie: Optional[str] = None
    userAgent: Optional[str] = None
    downloadPath: Optional[str] = None
    maxRetries: Optional[int] = Field(None, ge=0, le=10)
    maxConcurrency: Optional[int] = Field(None, ge=1, le=10)
    windowWidth: Optional[int] = Field(None, ge=800, le=3840)
    windowHeight: Optional[int] = Field(None, ge=600, le=2160)
    enableIncrementalFetch: Optional[bool] = None
    aria2Host: Optional[str] = None
    aria2Port: Optional[int] = Field(None, ge=1, le=65535)
    aria2Secret: Optional[str] = None
    webdavEnabled: Optional[bool] = None
    webdavUrl: Optional[str] = None
    webdavUsername: Optional[str] = None
    webdavPassword: Optional[str] = None
    webdavBasePath: Optional[str] = None
    webdavUploadDownloads: Optional[bool] = None
    webdavUploadTransformed: Optional[bool] = None
    subtitleLanguage: Optional[str] = None
    subtitleMode: Optional[str] = None
    subtitlePrompt: Optional[str] = None
    subtitleLocalWhisperUrl: Optional[str] = None
    subtitleLocalModel: Optional[str] = None
    subtitleWordTimestamps: Optional[bool] = None
    subtitleAutoGenerateOnUpload: Optional[bool] = None
    subtitleAutoBurnAfterGenerate: Optional[bool] = None


class SettingsResponse(BaseModel):
    """设置响应模型"""

    cookie: str = ""
    userAgent: str = ""
    downloadPath: str = ""
    maxRetries: int = DOWNLOAD_DEFAULTS["MAX_RETRIES"]
    maxConcurrency: int = DOWNLOAD_DEFAULTS["MAX_CONCURRENCY"]
    windowWidth: int = DEFAULT_SETTINGS["windowWidth"]
    windowHeight: int = DEFAULT_SETTINGS["windowHeight"]
    enableIncrementalFetch: bool = True
    aria2Host: str = ARIA2_DEFAULTS["HOST"]
    aria2Port: int = ARIA2_DEFAULTS["PORT"]
    aria2Secret: str = ""
    webdavEnabled: bool = False
    webdavUrl: str = ""
    webdavUsername: str = ""
    webdavPassword: str = ""
    webdavBasePath: str = ""
    webdavUploadDownloads: bool = False
    webdavUploadTransformed: bool = False
    subtitleLanguage: str = DEFAULT_SETTINGS["subtitleLanguage"]
    subtitleMode: str = DEFAULT_SETTINGS["subtitleMode"]
    subtitlePrompt: str = DEFAULT_SETTINGS["subtitlePrompt"]
    subtitleLocalWhisperUrl: str = DEFAULT_SETTINGS["subtitleLocalWhisperUrl"]
    subtitleLocalModel: str = DEFAULT_SETTINGS["subtitleLocalModel"]
    subtitleWordTimestamps: bool = DEFAULT_SETTINGS["subtitleWordTimestamps"]
    subtitleAutoGenerateOnUpload: bool = DEFAULT_SETTINGS["subtitleAutoGenerateOnUpload"]
    subtitleAutoBurnAfterGenerate: bool = DEFAULT_SETTINGS["subtitleAutoBurnAfterGenerate"]


class FirstRunResponse(BaseModel):
    """首次运行检查响应"""

    is_first_run: bool


class SaveResponse(BaseModel):
    """保存响应"""

    status: str
    message: str


class WhisperStatusResponse(BaseModel):
    desired_model: str
    current_model: Optional[str] = None
    container_name: str
    container_running: bool
    container_health: Optional[str] = None
    api_reachable: bool
    ready: bool
    downloading: bool
    message: str


# ============================================================================
# 路由定义
# ============================================================================


@router.get("", response_model=SettingsResponse)
def get_settings() -> Dict[str, Any]:
    """获取当前应用设置"""
    return settings.data


@router.post("", response_model=SaveResponse)
def save_settings(request: SettingsUpdate) -> Dict[str, str]:
    """
    保存应用设置（支持部分更新）

    只需要提供要更新的字段，未提供的字段保持不变。
    """
    try:
        # 过滤掉 None 值，只传递需要更新的字段
        settings_update = request.model_dump(exclude_none=True)

        if not settings_update:
            return {"status": "success", "message": "没有需要更新的设置"}

        settings.save(settings_update)
        return {"status": "success", "message": "设置已保存"}

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"保存设置失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/first-run", response_model=FirstRunResponse)
def is_first_run_check() -> Dict[str, bool]:
    """检查是否首次运行"""
    return {"is_first_run": settings.is_first_run}


def _get_whisper_container_name() -> str:
    return os.getenv("DOUYIN_WHISPER_CONTAINER_NAME", "whisper-asr-webui")


def _run_docker_command(args: list[str]) -> str:
    result = subprocess.run(
        ["docker", *args],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError((result.stderr or result.stdout or "docker command failed").strip())
    return result.stdout.strip()


def _read_whisper_current_model() -> Optional[str]:
    whisper_url = settings.get("subtitleLocalWhisperUrl", "").strip().rstrip("/")
    if not whisper_url:
        return None

    import requests

    models_url = whisper_url + "/models"
    response = requests.get(models_url, timeout=10)
    response.raise_for_status()
    payload = response.json()
    if isinstance(payload, dict):
        current = str(payload.get("default_model") or "").strip()
        if current:
            return current
    return None


@router.get("/whisper-status", response_model=WhisperStatusResponse)
def get_whisper_status() -> Dict[str, Any]:
    container_name = _get_whisper_container_name()
    desired_model = settings.get("subtitleLocalModel", DEFAULT_SETTINGS["subtitleLocalModel"])

    container_running = False
    container_health: Optional[str] = None
    api_reachable = False
    current_model: Optional[str] = None

    try:
        inspect_raw = _run_docker_command(
            ["inspect", container_name, "--format", "{{.State.Running}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}"]
        )
        running_raw, health_raw = (inspect_raw.split("|", 1) + ["none"])[:2]
        container_running = running_raw.strip().lower() == "true"
        container_health = None if health_raw == "none" else health_raw
    except Exception as e:
        return {
            "desired_model": desired_model,
            "current_model": None,
            "container_name": container_name,
            "container_running": False,
            "container_health": None,
            "api_reachable": False,
            "ready": False,
            "downloading": False,
            "message": f"无法读取 Whisper 容器状态: {e}",
        }

    if container_running:
        try:
            current_model = _read_whisper_current_model()
            api_reachable = True
        except Exception:
            api_reachable = False

    downloading = container_running and not api_reachable
    ready = api_reachable and bool(current_model)
    if ready and current_model == desired_model:
        message = f"Whisper 已就绪，当前模型为 {current_model}"
    elif ready and current_model != desired_model:
        message = f"Whisper 已运行，但当前模型为 {current_model}，目标模型为 {desired_model}，需要重启应用新模型"
    elif downloading:
        message = f"Whisper 容器已启动，正在下载或加载模型 {desired_model}"
    else:
        message = "Whisper 尚未就绪"

    return {
        "desired_model": desired_model,
        "current_model": current_model,
        "container_name": container_name,
        "container_running": container_running,
        "container_health": container_health,
        "api_reachable": api_reachable,
        "ready": ready,
        "downloading": downloading,
        "message": message,
    }


@router.post("/whisper-restart", response_model=SaveResponse)
def restart_whisper_container() -> Dict[str, str]:
    container_name = _get_whisper_container_name()
    try:
        _run_docker_command(["restart", container_name])
        logger.success(f"✓ Whisper 容器已重启: {container_name}")
        return {"status": "success", "message": "Whisper 容器已重启，正在加载新模型"}
    except Exception as e:
        logger.error(f"重启 Whisper 容器失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))
