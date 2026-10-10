from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..kinds import AUDIO_EXTENSIONS, IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, detect_kind, is_media_path

USER_FOLDERS = ("Desktop", "Documents", "Downloads", "Movies", "Music", "Pictures")
PACKAGE_SUFFIXES = (".app", ".bundle", ".framework", ".photoslibrary", ".fcpbundle", ".imovielibrary", ".pkg")


@dataclass
class FsError(Exception):
    code: str
    message: str
    status: int

    def as_dict(self) -> dict[str, str]:
        return {"error": self.code, "message": self.message}


def resolve_path(raw: str | None) -> str:
    if raw is None or raw.strip() == "":
        raise FsError("bad_request", "A path is required", 400)
    path = os.path.expanduser(raw.strip())
    if not os.path.isabs(path):
        raise FsError("bad_request", "Path must be absolute", 400)
    return os.path.normpath(path)


def _is_hidden(path: str) -> bool:
    return any(part.startswith(".") for part in Path(path).parts)


def visible_path(raw: str | None) -> str:
    path = resolve_path(raw)
    if _is_hidden(path) or _is_hidden(os.path.realpath(path)):
        raise FsError("hidden", f"Hidden paths are not allowed: {path}", 403)
    return path


def places(comfy_dirs: dict[str, str]) -> dict[str, Any]:
    home = str(Path.home())
    user_places = [{"label": "Home", "path": home}]
    for name in USER_FOLDERS:
        candidate = os.path.join(home, name)
        if os.path.isdir(candidate):
            user_places.append({"label": name, "path": candidate})

    return {
        "home": home,
        "start": comfy_dirs["input"],
        "places": user_places,
        "volumes": _volumes(),
        "comfy": comfy_dirs,
        "kinds": {
            "image": sorted(IMAGE_EXTENSIONS),
            "video": sorted(VIDEO_EXTENSIONS),
            "audio": sorted(AUDIO_EXTENSIONS),
        },
    }


def list_directory(
    raw_path: str | None,
    kinds: set[str] | None = None,
) -> dict[str, Any]:
    path = visible_path(raw_path)
    wanted = kinds or {"image", "video", "audio"}

    try:
        folder_stat = os.stat(path)
        if not os.path.isdir(path):
            raise FsError("not_a_directory", f"Not a folder: {path}", 400)
        with os.scandir(path) as iterator:
            raw_entries = list(iterator)
    except FsError:
        raise
    except FileNotFoundError:
        raise FsError("not_found", f"Folder not found: {path}", 404)
    except PermissionError:
        raise FsError("permission_denied", f"Permission denied: {path}", 403)
    except NotADirectoryError:
        raise FsError("not_a_directory", f"Not a folder: {path}", 400)
    except OSError as error:
        raise FsError("io_error", f"Could not read {path}: {error.strerror or error}", 500)

    entries: list[dict[str, Any]] = []
    skipped = 0
    for entry in raw_entries:
        if entry.name.startswith("."):
            continue
        item = _entry_payload(entry, wanted)
        if item is None:
            skipped += 1
        else:
            entries.append(item)

    entries.sort(key=lambda item: (item["type"] != "dir", _natural_key(item["name"])))

    parent = os.path.dirname(path)
    return {
        "path": path,
        "parent": parent if parent != path else None,
        "mtime": folder_stat.st_mtime,
        "entries": entries,
        "skipped": skipped,
    }


def file_for_streaming(raw_path: str | None) -> str:
    path = visible_path(raw_path)
    if not is_media_path(path) or not is_media_path(os.path.realpath(path)):
        raise FsError("not_media", f"Not an image, video or audio file: {path}", 403)
    if not os.path.exists(path):
        raise FsError("not_found", f"File not found: {path}", 404)
    if not os.path.isfile(path):
        raise FsError("not_a_file", f"Not a file: {path}", 400)
    if not os.access(path, os.R_OK):
        raise FsError("permission_denied", f"Permission denied: {path}", 403)
    return path


def _entry_payload(entry: os.DirEntry[str], wanted: set[str]) -> dict[str, Any] | None:
    try:
        is_dir = entry.is_dir() and not entry.name.lower().endswith(PACKAGE_SUFFIXES)
        stat = entry.stat()
    except OSError:
        return None

    if is_dir:
        return {"type": "dir", "name": entry.name, "path": entry.path, "mtime": stat.st_mtime}

    kind = detect_kind(entry.name)
    if kind not in wanted:
        return None
    return {
        "type": "file",
        "name": entry.name,
        "path": entry.path,
        "kind": kind,
        "size": stat.st_size,
        "mtime": stat.st_mtime,
    }


def _volumes() -> list[dict[str, str]]:
    roots = ["/Volumes"] if sys.platform == "darwin" else ["/mnt", "/media"]
    volumes: list[dict[str, str]] = []
    for root in roots:
        try:
            children = sorted(os.scandir(root), key=lambda child: child.name.lower())
        except OSError:
            continue
        for child in children:
            if child.name.startswith("."):
                continue
            try:
                if child.is_dir():
                    volumes.append({"label": child.name, "path": child.path})
            except OSError:
                continue
    return volumes


def _natural_key(value: str) -> list[Any]:
    return [(0, int(token)) if token.isdigit() else (1, token.lower()) for token in re.split(r"(\d+)", value) if token]
