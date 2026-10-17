"""Small real files for the upload tests: a PNG and a JPEG made by Pillow, and stand-ins for
video and music that carry the right first bytes (the store checks the signature, not playback)."""

from __future__ import annotations

import io

from PIL import Image


def png_bytes(size: tuple[int, int] = (8, 8)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(out, "PNG")
    return out.getvalue()


def jpeg_bytes(size: tuple[int, int] = (8, 8)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", size, (30, 30, 200)).save(out, "JPEG")
    return out.getvalue()


def mp4_bytes(extra: int = 2048) -> bytes:
    """An ISO base-media header (``ftyp``) and filler: enough to pass the signature check."""
    return b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + bytes(range(256)) * (extra // 256)


def mp3_bytes() -> bytes:
    return b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\xff\xfb\x90\x00" * 256
