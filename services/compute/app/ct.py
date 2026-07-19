"""CT acquisition + reconstruction (planned).

A CT scan loops the projection engine over N gantry angles and reconstructs with
filtered back-projection (or an iterative solver). The engine / materials /
spectrum / phantom modules are designed to be reused unchanged — see the
architecture notes in engine.js and phantom.js on the web side.
"""
from __future__ import annotations

from typing import Any


def reconstruct(params: dict[str, Any]) -> dict:
    return {
        "status": "not_implemented",
        "note": (
            "CT mode planned: acquire project() over gantry angles, then "
            "filtered back-projection / iterative reconstruction"
        ),
    }
