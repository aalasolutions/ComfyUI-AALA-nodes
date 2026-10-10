from __future__ import annotations

import asyncio
import os

import folder_paths
from comfy_api.latest import ComfyExtension, io
from server import PromptServer

from .aala_media.nodes.list_splitter import ListSplitter
from .aala_media.nodes.media_manager import MediaManager
from .aala_media.nodes.video_components import GetVideoComponents
from .aala_media.server.routes import create_routes
from .aala_media.server.thumbs import MediaCache

WEB_DIRECTORY = "./web/dist"


def _comfy_dirs() -> dict[str, str]:
    return {
        "input": folder_paths.get_input_directory(),
        "output": folder_paths.get_output_directory(),
        "temp": folder_paths.get_temp_directory(),
    }


class AalaMediaExtension(ComfyExtension):
    async def on_load(self) -> None:
        cache = MediaCache(os.path.join(folder_paths.get_user_directory(), "aala-media", "cache"))
        server_routes = PromptServer.instance.routes
        for route in create_routes(_comfy_dirs, cache):
            server_routes.route(route.method, route.path)(route.handler)
        asyncio.get_running_loop().run_in_executor(None, cache.evict)

    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        return [MediaManager, ListSplitter, GetVideoComponents]


async def comfy_entrypoint() -> AalaMediaExtension:
    return AalaMediaExtension()
