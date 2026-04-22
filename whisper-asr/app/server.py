import json
import os
import shutil
import time
from pathlib import Path
from typing import Annotated

import ffmpeg
import numpy as np
import requests
import whisper
from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

try:
    from opencc import OpenCC
except ImportError:
    OpenCC = None

app = FastAPI()

app.add_middleware(CORSMiddleware, allow_origins=["*"])

download_size_cache = {}
TRANSCRIPTS_DIR = Path(os.getenv("TRANSCRIPTS_DIR", "/data/transcripts"))
DEFAULT_LANGUAGE = os.getenv("DEFAULT_LANGUAGE", "zh")
DEFAULT_MODEL = os.getenv("DEFAULT_MODEL", "medium")
UPLOADS_DIR = Path(os.getenv("UPLOADS_DIR", "/data/uploads"))
WAVS_DIR = Path(os.getenv("WAVS_DIR", "/data/wavs"))
HOST_ROOT = Path(os.getenv("HOST_ROOT", "/hostdocker"))
OPENCC_T2S = OpenCC("t2s") if OpenCC is not None else None

FS_ROOTS = {
    "host": HOST_ROOT,
    "uploads": UPLOADS_DIR,
    "wavs": WAVS_DIR,
    "transcripts": TRANSCRIPTS_DIR,
}

AUDIO_EXTENSIONS = {
    ".mp3",
    ".mp4",
    ".m4a",
    ".wav",
    ".aac",
    ".flac",
    ".ogg",
    ".opus",
    ".webm",
    ".mov",
    ".mkv",
}


def contains_cjk(text: str) -> bool:
    return any("\u4e00" <= char <= "\u9fff" for char in text or "")


def to_simplified_chinese(text: str) -> str:
    value = (text or "").strip()
    if not value or OPENCC_T2S is None or not contains_cjk(value):
        return value
    return OPENCC_T2S.convert(value)


def normalize_transcript_texts(result: dict):
    if result.get("text"):
        result["text"] = to_simplified_chinese(str(result["text"]))

    segments = result.get("segments") or []
    if isinstance(segments, list):
        for segment in segments:
            if segment.get("text"):
                segment["text"] = to_simplified_chinese(str(segment["text"]))
    return result


@app.get("/size")
def download_size(model: str):
    url = whisper._MODELS[model]
    if url in download_size_cache:
        return download_size_cache[url]
    res = requests.head(url)
    size = int(res.headers.get("Content-Length"))
    download_size_cache[url] = size
    return size


@app.get("/models")
def models():
    available = {}
    root = Path(
        os.getenv("XDG_CACHE_HOME", os.path.join(os.path.expanduser("~"), ".cache"))
    ) / "whisper"
    for model in whisper.available_models():
        available[model] = (root / f"{model}.pt").exists()
        for other, url in whisper._MODELS.items():
            if url == whisper._MODELS[model] and (root / f"{other}.pt").exists():
                available[model] = True
    return {"default_model": DEFAULT_MODEL, "models": available}


@app.get("/api/roots")
def get_roots():
    available_roots = [
        {"key": key, "path": str(path), "label": key.title()}
        for key, path in FS_ROOTS.items()
        if path.exists()
    ]
    return {
        "default_model": DEFAULT_MODEL,
        "roots": available_roots,
    }


@app.get("/api/fs/list")
def fs_list(path: str = Query("")):
    target = resolve_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if target.is_file():
        target = target.parent

    entries = []
    for entry in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        stat = entry.stat()
        entries.append(
            {
                "name": entry.name,
                "path": str(entry),
                "is_dir": entry.is_dir(),
                "size": stat.st_size,
                "mtime": int(stat.st_mtime),
                "suffix": entry.suffix.lower(),
            }
        )

    return {
        "path": str(target),
        "parent": str(target.parent) if target != target.parent and is_allowed_path(target.parent) else None,
        "entries": entries,
    }


@app.get("/api/fs/preview")
def fs_preview(path: str):
    target = resolve_path(path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Only files can be previewed")

    suffix = target.suffix.lower()
    if suffix in {".txt", ".json", ".log", ".srt", ".vtt", ".tsv", ".md"}:
        return {
            "type": "text",
            "path": str(target),
            "content": target.read_text(encoding="utf-8", errors="replace")[:200000],
        }
    if suffix in {".wav", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".webm", ".mp4", ".mov", ".mkv"}:
        return {
            "type": "media",
            "path": str(target),
            "url": f"/api/fs/download?path={requests.utils.quote(str(target), safe='')}",
        }
    return {"type": "info", "path": str(target), "message": "Preview not supported for this file type."}


@app.get("/api/outputs/recent")
def recent_outputs(limit: int = Query(12, ge=1, le=50)):
    items = []
    for root_key, root in [("transcripts", TRANSCRIPTS_DIR), ("wavs", WAVS_DIR), ("uploads", UPLOADS_DIR)]:
        if not root.exists():
            continue
        for entry in root.iterdir():
            if entry.is_file():
                stat = entry.stat()
                items.append(
                    {
                        "root": root_key,
                        "name": entry.name,
                        "path": str(entry),
                        "size": stat.st_size,
                        "mtime": int(stat.st_mtime),
                        "suffix": entry.suffix.lower(),
                    }
                )
    items.sort(key=lambda item: item["mtime"], reverse=True)
    return {"items": items[:limit]}


@app.post("/api/fs/action")
def fs_action(payload: dict):
    action = payload.get("action")
    source = resolve_path(payload.get("source", ""))

    if action == "rename":
        new_name = payload.get("new_name")
        if not new_name or "/" in new_name:
            raise HTTPException(status_code=400, detail="Invalid new name")
        destination = resolve_destination(source.parent / new_name)
        source.rename(destination)
        return {"ok": True, "path": str(destination)}

    if action == "delete":
        if source.is_dir():
            shutil.rmtree(source)
        else:
            source.unlink(missing_ok=False)
        return {"ok": True}

    destination = resolve_destination(payload.get("destination", ""))
    if action == "copy":
        if source.is_dir():
            shutil.copytree(source, destination, dirs_exist_ok=True)
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
        return {"ok": True, "path": str(destination)}

    if action == "move":
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(source), str(destination))
        return {"ok": True, "path": str(destination)}

    raise HTTPException(status_code=400, detail="Unsupported action")


@app.get("/api/fs/download")
def fs_download(path: str):
    target = resolve_path(path)
    if not target.is_file():
        raise HTTPException(status_code=400, detail="Only files can be downloaded")
    return FileResponse(target)


@app.post("/api/transcribe-path")
def transcribe_path(
    path: Annotated[str, Form()],
    task: Annotated[str, Form()] = "transcribe",
    model: Annotated[str, Form()] = DEFAULT_MODEL,
    initial_prompt: Annotated[str, Form()] = None,
    word_timestamps: Annotated[bool, Form()] = False,
    language: Annotated[str, Form()] = None,
):
    source_path = resolve_path(path)
    return run_transcription(
        original_name=source_path.name,
        source_path=source_path,
        task=task,
        model=model,
        initial_prompt=initial_prompt,
        word_timestamps=word_timestamps,
        language=language,
    )


@app.post("/transcribe")
def transcribe(
    file: Annotated[UploadFile, File()],
    task: Annotated[str, Form()] = "transcribe",
    model: Annotated[str, Form()] = DEFAULT_MODEL,
    initial_prompt: Annotated[str, Form()] = None,
    word_timestamps: Annotated[bool, Form()] = False,
    language: Annotated[str, Form()] = None,
):
    file_bytes = file.file.read()
    source_path = persist_upload(file.filename, file_bytes)
    return run_transcription(
        original_name=file.filename or source_path.name,
        source_path=source_path,
        task=task,
        model=model,
        initial_prompt=initial_prompt,
        word_timestamps=word_timestamps,
        language=language,
    )


def run_transcription(
    *,
    original_name: str,
    source_path: Path,
    task: str,
    model: str,
    initial_prompt: str | None,
    word_timestamps: bool,
    language: str | None,
):
    wav_path = convert_to_wav(source_path)
    np_array = load_wav_audio(wav_path)
    normalized_prompt = normalize_optional_text(initial_prompt)
    normalized_language = normalize_language(language)
    whisper_instance = whisper.load_model(model)
    result = whisper_instance.transcribe(
        audio=np_array,
        verbose=True,
        task=task,
        initial_prompt=normalized_prompt,
        word_timestamps=word_timestamps,
        language=normalized_language,
    )

    if result.get("text") and not result.get("segments"):
        result["segments"] = [
            {
                "id": 0,
                "seek": 0,
                "start": 0.0,
                "end": 0.0,
                "text": result["text"],
                "tokens": [],
                "temperature": 0.0,
                "avg_logprob": 0.0,
                "compression_ratio": 0.0,
                "no_speech_prob": 0.0,
            }
        ]

    result = normalize_transcript_texts(result)

    persist_transcription_result(
        original_name,
        {
            "request": {
                "filename": original_name,
                "source_path": str(source_path),
                "wav_path": str(wav_path),
                "task": task,
                "model": model,
                "initial_prompt": normalized_prompt,
                "word_timestamps": word_timestamps,
                "language": normalized_language,
                "raw_language": language,
            },
            "response": result,
        },
    )
    return result


if os.path.exists("/static"):
    print("Serving static files from /static")
    app.mount("/", StaticFiles(directory="/static", html=True), name="static")


def persist_upload(filename: str | None, file_bytes: bytes):
    UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = os.path.basename(filename or "upload")
    timestamp = int(time.time())
    path = UPLOADS_DIR / f"{timestamp}_{safe_name}"
    with open(path, "wb") as f:
        f.write(file_bytes)
    return path


def convert_to_wav(source_path: Path):
    WAVS_DIR.mkdir(parents=True, exist_ok=True)
    stem = source_path.stem
    wav_path = WAVS_DIR / f"{stem}.wav"

    if source_path.resolve() == wav_path.resolve():
        return source_path

    try:
        (
            ffmpeg.input(str(source_path))
            .output(str(wav_path), format="wav", acodec="pcm_s16le", ac=1, ar=16000)
            .overwrite_output()
            .run(cmd=["ffmpeg"], capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as exc:
        detail = exc.stderr.decode("utf-8", errors="replace") if exc.stderr else str(exc)
        raise HTTPException(status_code=500, detail=f"ffmpeg wav 转换失败: {detail}") from exc

    return wav_path


def load_wav_audio(wav_path: Path):
    try:
        out, _ = (
            ffmpeg.input(str(wav_path), threads=0)
            .output("-", format="s16le", acodec="pcm_s16le", ac=1, ar=16000)
            .run(cmd=["ffmpeg"], capture_stdout=True, capture_stderr=True)
        )
    except ffmpeg.Error as e:
        raise RuntimeError(f"Failed to load audio: {e.stderr.decode()}") from e
    return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0


def persist_transcription_result(filename: str | None, payload: dict):
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    safe_name = os.path.basename(filename or "upload")
    stem, _ = os.path.splitext(safe_name)
    timestamp = int(time.time())
    prefix = f"{timestamp}_{stem}"

    json_path = TRANSCRIPTS_DIR / f"{prefix}.json"
    txt_path = TRANSCRIPTS_DIR / f"{prefix}.txt"

    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    with open(txt_path, "w", encoding="utf-8") as f:
        f.write(payload.get("response", {}).get("text", "") or "")


def normalize_optional_text(value: str | None):
    if value in (None, "", "undefined", "null"):
        return None
    return value


def normalize_language(value: str | None):
    cleaned = normalize_optional_text(value)
    if cleaned is None:
        return DEFAULT_LANGUAGE
    return cleaned


def is_allowed_path(path: Path):
    try:
        resolved = path.resolve()
    except FileNotFoundError:
        resolved = path.parent.resolve() / path.name
    return any(resolved == root or root in resolved.parents for root in FS_ROOTS.values())


def resolve_path(path: str):
    if not path:
        return HOST_ROOT
    target = Path(path).resolve()
    if not is_allowed_path(target):
        raise HTTPException(status_code=403, detail="Path outside allowed roots")
    return target


def resolve_destination(path: str | Path):
    target = Path(path).resolve() if not isinstance(path, Path) else path.resolve()
    if not is_allowed_path(target):
        raise HTTPException(status_code=403, detail="Destination outside allowed roots")
    return target
