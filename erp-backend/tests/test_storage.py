"""Generalised storage: invitation media kinds, content sniffing, image re-encoding and
short-lived signed URLs."""

from __future__ import annotations

import io
from collections.abc import Iterator
from pathlib import Path

import pytest
from httpx import AsyncClient
from PIL import Image

from app.core import storage as storage_mod
from app.core.errors import Invalid
from app.core.signing import sign, verify
from app.core.storage import (
    ARTWORK,
    ATTACHMENT,
    MUSIC,
    PHOTO,
    VIDEO,
    LocalDiskStorage,
    check_signed,
    set_storage,
    signed_file_path,
)

MP4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2" + b"\x00" * 64
MOV = b"\x00\x00\x00\x14ftypqt  \x00\x00\x02\x00qt  " + b"\x00" * 64
WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 64
MP3 = b"ID3\x04\x00\x00\x00\x00\x00\x00" + b"\x00" * 64
M4A = b"\x00\x00\x00\x18ftypM4A \x00\x00\x02\x00M4A isom" + b"\x00" * 64


def image_bytes(fmt: str = "JPEG", size: tuple[int, int] = (64, 48), **save: object) -> bytes:
    out = io.BytesIO()
    mode = "RGBA" if fmt == "PNG" else "RGB"
    Image.new(mode, size, (200, 40, 40)).save(out, fmt, **save)
    return out.getvalue()


@pytest.fixture
def disk(tmp_path: Path) -> Iterator[LocalDiskStorage]:
    backend = LocalDiskStorage(tmp_path)
    set_storage(backend)
    yield backend
    set_storage(None)


# ---------------------------------------------------------------------------
# Signing
# ---------------------------------------------------------------------------


def test_a_signature_verifies_and_any_change_breaks_it() -> None:
    sig = sign("file", "ab/cd/key.jpg", "1900000000")
    assert verify(sig, "file", "ab/cd/key.jpg", "1900000000")
    assert not verify(sig, "file", "ab/cd/key.jpg", "1900000001")
    assert not verify(sig, "qr", "ab/cd/key.jpg", "1900000000"), "purposes do not mix"


def test_fields_cannot_be_reframed() -> None:
    assert sign("p", "ab", "c") != sign("p", "a", "bc")
    with pytest.raises(ValueError):
        sign("p", "a\x1fb")


def test_a_short_signature_is_still_checked() -> None:
    sig = sign("qr", "EV-01", "G-001", length=16)
    assert len(sig) == 22
    assert verify(sig, "qr", "EV-01", "G-001", length=16)
    tampered = sig[:-1] + ("A" if sig[-1] != "A" else "B")
    assert not verify(tampered, "qr", "EV-01", "G-001", length=16)


def test_garbage_does_not_raise() -> None:
    assert not verify("", "file", "x")
    assert not verify("not-a-sig", "file", "x\x1f")


# ---------------------------------------------------------------------------
# Kinds, types and sniffing
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("kind", "data", "content_type", "name"),
    [
        (VIDEO, MP4, "video/mp4", "clip.mp4"),
        (VIDEO, MOV, "video/quicktime", "clip.MOV"),
        (VIDEO, WEBM, "video/webm", "clip.webm"),
        (MUSIC, MP3, "audio/mpeg", "song.mp3"),
        (MUSIC, MP3, "audio/mp3", "song.mp3"),
        (MUSIC, M4A, "audio/x-m4a", "song.m4a"),
        (ATTACHMENT, b"%PDF-1.4\n%%EOF\n", "application/pdf", "receipt.pdf"),
        (ATTACHMENT, b"date,amount\n2026-10-05,1000\n", "text/csv", "cash.csv"),
    ],
)
def test_each_kind_accepts_its_own_formats(
    disk: LocalDiskStorage, kind, data: bytes, content_type: str, name: str
) -> None:
    stored = disk.save(io.BytesIO(data), kind=kind, content_type=content_type, filename=name)
    assert stored.byte_size == len(data)
    assert disk.open(stored.storage_key).read() == data


@pytest.mark.parametrize(
    ("kind", "data", "content_type", "name", "why"),
    [
        (PHOTO, b"<svg xmlns='http://www.w3.org/2000/svg'/>", "image/svg+xml", "a.svg", "no SVG"),
        (PHOTO, image_bytes(), "image/jpeg", "photo.exe", "extension must match"),
        (PHOTO, b"MZ\x90\x00" + b"\x00" * 64, "image/jpeg", "photo.jpg", "bytes must match"),
        (VIDEO, image_bytes(), "video/mp4", "clip.mp4", "a JPEG is not a video"),
        (MUSIC, MP4, "audio/mpeg", "song.mp3", "an MP4 is not an MP3"),
        (VIDEO, MP4, "video/x-msvideo", "clip.avi", "type not on the list"),
        (ATTACHMENT, b"\x00\x01binary", "text/plain", "notes.txt", "text must be text"),
    ],
)
def test_mismatches_are_refused(
    disk: LocalDiskStorage, kind, data: bytes, content_type: str, name: str, why: str
) -> None:
    with pytest.raises(Invalid):
        disk.save(io.BytesIO(data), kind=kind, content_type=content_type, filename=name)


@pytest.mark.parametrize(
    ("data", "content_type", "name"),
    [
        (image_bytes(), "image/jpg", "receipt.jpg"),  # non-standard but common
        (image_bytes(), "image/jpeg", "receipt"),  # a bare name from a phone
        ("tanggal;jumlah\nKas kecil — Rp 5.000\n".encode("cp1252"), "text/csv", "kas.csv"),
        ("date,amount\n2026-10-05,1000\n".encode("utf-16"), "text/csv", "unicode.csv"),
        (b"\xef\xbb\xbfdate,amount\n", "application/csv", "bom.csv"),
    ],
)
def test_the_files_finance_staff_actually_export_are_accepted(
    disk: LocalDiskStorage, data: bytes, content_type: str, name: str
) -> None:
    stored = disk.save(io.BytesIO(data), kind=ATTACHMENT, content_type=content_type,
                       filename=name)
    assert disk.open(stored.storage_key).read() == data


def test_a_text_file_must_not_be_a_disguised_binary(disk: LocalDiskStorage) -> None:
    with pytest.raises(Invalid):
        disk.save(io.BytesIO(b"%PDF-1.4\n"), kind=ATTACHMENT, content_type="text/plain",
                  filename="notes.txt")


def test_the_kind_size_limit_is_measured_while_reading(
    disk: LocalDiskStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    small = storage_mod.FileKind("tiny", max_bytes=100, types={"video/mp4": (".mp4",)})
    with pytest.raises(Invalid, match="larger than"):
        disk.save(io.BytesIO(MP4 + b"\x00" * 200), kind=small, content_type="video/mp4",
                  filename="big.mp4")
    assert not list(disk.root.rglob(".upload-*")), "the partial upload is cleaned up"


def test_the_limits_match_the_prototype() -> None:
    mb = 1024 * 1024
    assert (PHOTO.max_bytes, VIDEO.max_bytes, MUSIC.max_bytes) == (15 * mb, 200 * mb, 20 * mb)


# ---------------------------------------------------------------------------
# Images
# ---------------------------------------------------------------------------


def test_photos_are_shrunk_to_the_cap(disk: LocalDiskStorage) -> None:
    big = image_bytes(size=(4000, 3000))
    stored = disk.save(io.BytesIO(big), kind=PHOTO, content_type="image/jpeg", filename="a.jpg")
    with Image.open(disk.open(stored.storage_key)) as img:
        assert max(img.size) == 2560 and img.size == (2560, 1920)


def test_exif_is_stripped(disk: LocalDiskStorage) -> None:
    exif = Image.Exif()
    exif[0x8825] = {2: (6.0, 10.0, 0.0)}  # GPSInfo: where the photo was taken
    exif[0x010F] = "PhoneMaker"
    data = image_bytes(exif=exif.tobytes())
    assert Image.open(io.BytesIO(data)).getexif()

    stored = disk.save(io.BytesIO(data), kind=PHOTO, content_type="image/jpeg", filename="a.jpg")
    with Image.open(disk.open(stored.storage_key)) as img:
        assert not img.getexif(), "no location or device data survives"


def test_transparent_artwork_stays_transparent(disk: LocalDiskStorage) -> None:
    stored = disk.save(
        io.BytesIO(image_bytes("PNG")), kind=ARTWORK, content_type="image/png", filename="f.png"
    )
    with Image.open(disk.open(stored.storage_key)) as img:
        assert img.format == "PNG" and img.mode == "RGBA"


def test_a_palette_image_can_be_saved_as_webp(disk: LocalDiskStorage) -> None:
    out = io.BytesIO()
    Image.new("P", (32, 32)).save(out, "WEBP")
    stored = disk.save(io.BytesIO(out.getvalue()), kind=PHOTO, content_type="image/webp",
                       filename="p.webp")
    assert stored.storage_key.endswith(".webp")


def test_a_truncated_image_is_refused(disk: LocalDiskStorage) -> None:
    with pytest.raises(Invalid, match="readable image"):
        disk.save(io.BytesIO(image_bytes()[:40]), kind=PHOTO, content_type="image/jpeg",
                  filename="a.jpg")


def test_a_decompression_bomb_is_refused_before_decoding(
    disk: LocalDiskStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(storage_mod, "MAX_IMAGE_PIXELS", 1000)
    with pytest.raises(Invalid, match="too large in pixels"):
        disk.save(io.BytesIO(image_bytes(size=(100, 100))), kind=PHOTO,
                  content_type="image/jpeg", filename="a.jpg")


def test_finance_evidence_is_kept_byte_for_byte(disk: LocalDiskStorage) -> None:
    """A receipt is evidence: attachments are never re-encoded."""
    data = image_bytes(size=(4000, 3000))
    stored = disk.save(io.BytesIO(data), kind=ATTACHMENT, content_type="image/jpeg",
                       filename="receipt.jpg")
    assert disk.open(stored.storage_key).read() == data


def test_the_same_upload_twice_is_one_file(disk: LocalDiskStorage) -> None:
    first = disk.save(io.BytesIO(MP4), kind=VIDEO, content_type="video/mp4", filename="a.mp4")
    second = disk.save(io.BytesIO(MP4), kind=VIDEO, content_type="video/mp4", filename="b.mp4")
    assert first.storage_key == second.storage_key


def test_a_key_cannot_escape_the_root(disk: LocalDiskStorage) -> None:
    with pytest.raises(Invalid):
        disk.open("../../etc/passwd")


# ---------------------------------------------------------------------------
# Signed URLs over HTTP
# ---------------------------------------------------------------------------


async def test_a_signed_url_serves_the_file_without_a_login(
    disk: LocalDiskStorage, anon_client: AsyncClient
) -> None:
    stored = disk.save(io.BytesIO(image_bytes()), kind=PHOTO, content_type="image/jpeg",
                       filename="cover.jpg")
    response = await anon_client.get(signed_file_path(stored.storage_key))
    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.headers["x-content-type-options"] == "nosniff"


async def test_video_can_seek(disk: LocalDiskStorage, anon_client: AsyncClient) -> None:
    stored = disk.save(io.BytesIO(MP4), kind=VIDEO, content_type="video/mp4", filename="a.mp4")
    response = await anon_client.get(
        signed_file_path(stored.storage_key), headers={"Range": "bytes=4-11"}
    )
    assert response.status_code == 206
    assert response.content == b"ftypisom"


async def test_a_tampered_or_expired_url_is_a_404(
    disk: LocalDiskStorage, anon_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    stored = disk.save(io.BytesIO(MP4), kind=VIDEO, content_type="video/mp4", filename="a.mp4")
    url = signed_file_path(stored.storage_key, ttl_seconds=60)

    other = disk.save(io.BytesIO(WEBM), kind=VIDEO, content_type="video/webm", filename="b.webm")
    swapped = url.replace(stored.storage_key, other.storage_key)
    assert (await anon_client.get(swapped)).status_code == 404, "the key is signed"

    stretched = url.replace("exp=", "exp=9")
    assert (await anon_client.get(stretched)).status_code == 404, "the expiry is signed"

    monkeypatch.setattr(storage_mod.time, "time", lambda: 4_000_000_000.0)
    assert (await anon_client.get(url)).status_code == 404, "and it expires"


def test_check_signed_refuses_an_expired_link() -> None:
    from app.core.errors import NotFound

    with pytest.raises(NotFound):
        check_signed("ab/cd/x.jpg", 1, sign("file", "ab/cd/x.jpg", "1"))


async def test_finance_attachments_still_upload_and_download(
    disk: LocalDiskStorage, client: AsyncClient, api: str
) -> None:
    pdf = b"%PDF-1.4\n%%EOF\n"
    uploaded = await client.post(
        f"{api}/attachments", files={"file": ("r.pdf", io.BytesIO(pdf), "application/pdf")}
    )
    assert uploaded.status_code == 201, uploaded.text
    downloaded = await client.get(f"{api}/attachments/{uploaded.json()['id']}")
    assert downloaded.content == pdf
