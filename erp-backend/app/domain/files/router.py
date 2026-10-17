"""Serve stored files through short-lived signed URLs.

No bearer token here, deliberately: ``<img>``, ``<video>`` and ``<audio>`` tags cannot send
one, and invitation media is shown to guests who have no account. The signature is the
credential — it covers the storage key and an expiry, and is minted only by endpoints that
have already checked the caller may see the file (``app.core.storage.signed_file_path``).
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from starlette.responses import Response

from app.core.storage import check_signed, get_storage

router = APIRouter(tags=["files"])


@router.get("/files/{storage_key:path}")
async def serve_file(
    storage_key: str, exp: int = Query(...), sig: str = Query(..., max_length=64)
) -> Response:
    """Expired, forged and unknown links all answer 404, so none can be told apart."""
    check_signed(storage_key, exp, sig)
    return get_storage().serve(storage_key)
