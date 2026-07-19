"""Model conversion.

`.glb` / `.gltf` load directly in the browser (three GLTFLoader) — no backend
needed. `.blend` is not a web format; converting it requires Blender running
headless to export glTF, e.g.:

    blender --background input.blend \\
        --python-expr "import bpy; bpy.ops.export_scene.gltf(filepath='out.glb')"

This module scaffolds that pipeline; wire the actual Blender invocation where the
TODO is once a Blender install is available on the backend.
"""
from __future__ import annotations

import shutil

from fastapi import UploadFile
from fastapi.responses import JSONResponse


def blender_available() -> bool:
    return shutil.which("blender") is not None


async def blend_to_glb(file: UploadFile):
    if not blender_available():
        return JSONResponse(
            status_code=501,
            content={
                "status": "blender_not_available",
                "note": "install Blender and put `blender` on PATH to enable .blend -> .glb",
            },
        )
    # TODO: save the upload to a temp file, run Blender headless to export .glb,
    # then return the resulting file (FileResponse).
    return JSONResponse(
        status_code=501,
        content={
            "status": "not_implemented",
            "note": "conversion pipeline scaffolded; wire the Blender export here",
        },
    )
