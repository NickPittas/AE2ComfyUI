"""AE bridge ComfyUI custom nodes.

Drop this package (or a symlink) into ComfyUI's `custom_nodes/` directory.
"""

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

# Node classes are registered lazily so the package still imports (and routes
# still work) when torch is unavailable, e.g. in plain test environments.
try:
    from .nodes import FromAE, FromAEVideo, ToAE, ToAEVideo

    NODE_CLASS_MAPPINGS = {
        "FromAE": FromAE,
        "FromAEVideo": FromAEVideo,
        "ToAE": ToAE,
        "ToAEVideo": ToAEVideo,
    }
    NODE_DISPLAY_NAME_MAPPINGS = {
        "FromAE": "AE Bridge: From AE",
        "FromAEVideo": "AE Bridge: From AE Video",
        "ToAE": "AE Bridge: To AE",
        "ToAEVideo": "AE Bridge: To AE Video",
    }
except Exception:  # torch missing outside ComfyUI; routes still register below
    pass

# Serve the frontend extension at custom_nodes/ae_bridge/web/ae_bridge.js.
WEB_DIRECTORY = "web"

__all__ = [
    "NODE_CLASS_MAPPINGS",
    "NODE_DISPLAY_NAME_MAPPINGS",
    "WEB_DIRECTORY",
]


def _register_routes() -> None:
    """Register /ae_bridge/* routes on ComfyUI's PromptServer, best effort."""
    try:
        from server import PromptServer  # type: ignore
        from . import routes, workflow_registry
        routes.add_routes(PromptServer.instance)
        workflow_registry.add_routes(PromptServer.instance)
    except Exception:
        # Outside ComfyUI or routes already registered; non-fatal.
        pass


_register_routes()
