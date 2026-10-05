from __future__ import annotations

import asyncio
from typing import Any, Callable, TypeVar

from aiohttp import web

from .fs import FsError, file_for_streaming, list_directory, places
from .probe import probe_many
from .thumbs import DEFAULT_BUCKETS, MediaCache

PREFIX = "/aala-media/fs"
MAX_PROBE_PATHS = 500
WORKER_LIMIT = 8

T = TypeVar("T")
_semaphore: asyncio.Semaphore | None = None
_inflight: dict[tuple[Any, ...], asyncio.Task[Any]] = {}
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}


async def _run_blocking(func: Callable[..., T], *args: Any, **kwargs: Any) -> T:
    global _semaphore
    if _semaphore is None:
        _semaphore = asyncio.Semaphore(WORKER_LIMIT)
    async with _semaphore:
        return await asyncio.to_thread(func, *args, **kwargs)


async def _run_shared(key: tuple[Any, ...], func: Callable[..., T], *args: Any) -> T:
    task = _inflight.get(key)
    if task is None:
        task = asyncio.ensure_future(_run_blocking(func, *args))
        _inflight[key] = task
        task.add_done_callback(lambda _: _inflight.pop(key, None))
    return await asyncio.shield(task)


def _number(raw: str | None, default: float, parse: Callable[[str], float]) -> float:
    if raw is None or raw == "":
        return default
    try:
        value = parse(raw)
    except ValueError:
        raise FsError("bad_request", f"Invalid number: {raw}", 400)
    if not value == value or value in (float("inf"), float("-inf")):
        raise FsError("bad_request", f"Invalid number: {raw}", 400)
    return value


def _error_response(error: FsError) -> web.Response:
    return web.json_response(error.as_dict(), status=error.status)


def _parse_kinds(raw: str | None) -> set[str] | None:
    if not raw:
        return None
    kinds = {kind.strip() for kind in raw.split(",") if kind.strip()}
    return kinds & {"image", "video", "audio"} or None


def create_routes(comfy_dirs: Callable[[], dict[str, str]], cache: MediaCache) -> web.RouteTableDef:
    routes = web.RouteTableDef()

    @routes.get(f"{PREFIX}/places")
    async def get_places(request: web.Request) -> web.Response:
        return web.json_response(await _run_blocking(places, comfy_dirs()))

    @routes.get(f"{PREFIX}/list")
    async def get_list(request: web.Request) -> web.Response:
        query = request.rel_url.query
        try:
            result = await _run_blocking(
                list_directory,
                query.get("path"),
                kinds=_parse_kinds(query.get("kinds")),
                hidden=query.get("hidden") in ("1", "true"),
            )
        except FsError as error:
            return _error_response(error)
        return web.json_response(result)

    @routes.post(f"{PREFIX}/probe")
    async def post_probe(request: web.Request) -> web.Response:
        try:
            body = await request.json()
        except ValueError:
            return _error_response(FsError("bad_request", "Body must be JSON", 400))
        paths = body.get("paths") if isinstance(body, dict) else None
        if not isinstance(paths, list) or not all(isinstance(path, str) for path in paths):
            return _error_response(FsError("bad_request", "paths must be a list of strings", 400))
        if len(paths) > MAX_PROBE_PATHS:
            return _error_response(FsError("bad_request", f"At most {MAX_PROBE_PATHS} paths per request", 400))
        return web.json_response(await _run_blocking(probe_many, paths))

    @routes.get(f"{PREFIX}/file")
    async def get_file(request: web.Request) -> web.StreamResponse:
        try:
            path = await _run_blocking(file_for_streaming, request.rel_url.query.get("path"))
        except FsError as error:
            return _error_response(error)
        return web.FileResponse(path)

    @routes.get(f"{PREFIX}/thumb")
    async def get_thumb(request: web.Request) -> web.StreamResponse:
        query = request.rel_url.query
        try:
            size = int(_number(query.get("size"), 256, int))
            path = query.get("path")
            target = await _run_shared(("thumb", path, size), cache.thumb, path, size)
        except FsError as error:
            return _error_response(error)
        return web.FileResponse(target, headers={**IMMUTABLE, "Content-Type": "image/webp"})

    @routes.get(f"{PREFIX}/frame")
    async def get_frame(request: web.Request) -> web.StreamResponse:
        query = request.rel_url.query
        try:
            seconds = _number(query.get("t"), 0.0, float)
            size = int(_number(query.get("size"), 1024, int))
            path = query.get("path")
            target = await _run_shared(("frame", path, seconds, size), cache.frame, path, seconds, size)
        except FsError as error:
            return _error_response(error)
        return web.FileResponse(target, headers={**IMMUTABLE, "Content-Type": "image/webp"})

    @routes.get(f"{PREFIX}/peaks")
    async def get_peaks(request: web.Request) -> web.Response:
        query = request.rel_url.query
        try:
            buckets = int(_number(query.get("buckets"), DEFAULT_BUCKETS, int))
            path = query.get("path")
            payload = await _run_shared(("peaks", path, buckets), cache.peaks, path, buckets)
        except FsError as error:
            return _error_response(error)
        return web.json_response(payload)

    return routes
