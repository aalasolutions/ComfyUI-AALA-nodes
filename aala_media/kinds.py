IMAGE_EXTENSIONS = {
    "png",
    "jpg",
    "jpeg",
    "webp",
    "gif",
    "bmp",
    "tiff",
    "tif",
}

VIDEO_EXTENSIONS = {
    "mp4",
    "webm",
    "mov",
    "mkv",
    "avi",
    "m4v",
}

AUDIO_EXTENSIONS = {
    "mp3",
    "wav",
    "flac",
    "ogg",
    "m4a",
    "aac",
    "opus",
    "wma",
}

ALL_MEDIA_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS | AUDIO_EXTENSIONS


def detect_kind(path: str) -> str:
    if not path:
        return "unknown"

    suffix = path.rsplit(".", 1)[-1].lower() if "." in path else ""
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    if suffix in AUDIO_EXTENSIONS:
        return "audio"
    return "unknown"


def is_media_path(path: str) -> bool:
    return detect_kind(path) != "unknown"
