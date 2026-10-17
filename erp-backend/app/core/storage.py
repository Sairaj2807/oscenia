"""File storage behind an interface: finance attachments and invitation media.

Local disk on the VPS for now. The interface exists so that moving to S3 or R2 later changes
this one module and no rows: ``storage_key`` is opaque to every caller, and files reach a
browser only through ``serve()`` behind a signed URL, which an object store would answer
with a redirect to its own pre-signed URL instead.

What is enforced here rather than trusted from the client:

* **The kind's own rules.** Each ``FileKind`` lists the types it accepts, the extensions each
  may carry, and its size limit — the prototype's ``mediaStore.js`` limits, now checked by
  the server: photo ≤ 15 MB, video ≤ 200 MB, music ≤ 20 MB.
* **The declared type, the extension and the bytes must agree.** The first bytes are sniffed
  for the format's signature, so a renamed executable is refused whatever it claims to be.
  **No SVG**, in any kind: it is a document that can carry script, not an image.
* **Images are re-encoded.** Decoded and saved afresh by Pillow, which drops EXIF (including
  GPS), refuses anything that is not really an image, and caps the longest side.
* **Size is measured while streaming**, not taken from ``Content-Length``, and the upload is
  spooled to disk rather than held in memory — a 200 MB video must not cost 200 MB of RAM.
* **The stored name is a hash** of the content, never the uploaded filename, which is
  attacker-controlled. Uploading the same file twice is free and idempotent.
"""

from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
import time
import zipfile
from codecs import BOM_UTF16_BE, BOM_UTF16_LE
from collections.abc import Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, Protocol

from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.responses import FileResponse, Response

from app.core.config import get_settings
from app.core.errors import Invalid, NotFound
from app.core.signing import sign, verify

MB = 1024 * 1024
CHUNK = 64 * 1024
DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
#: A Word document is a zip; refuse one that would unpack to more than this (a zip bomb).
MAX_DOCX_UNPACKED = 50 * MB
NUL = bytes(1)

#: Refuse images whose pixel count could exhaust memory when decoded ("decompression bombs").
MAX_IMAGE_PIXELS = 50_000_000
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


@dataclass(frozen=True, slots=True)
class FileKind:
    name: str
    max_bytes: int
    #: MIME type -> the extensions a file of that type may have (first is the stored one).
    types: dict[str, tuple[str, ...]]
    #: Longest side in pixels after re-encoding; ``None`` for kinds that are not images.
    image_max_side: int | None = None
    #: Extra MIME aliases browsers send for the same format, mapped to the canonical type.
    aliases: dict[str, str] = field(default_factory=dict)

    def canonical(self, content_type: str) -> str:
        return self.aliases.get(content_type, content_type)


_IMAGES = {"image/jpeg": (".jpg", ".jpeg"), "image/png": (".png",), "image/webp": (".webp",)}
#: Non-standard names some browsers and phones still send for JPEG.
_IMAGE_ALIASES = {"image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg"}

ATTACHMENT = FileKind(
    "attachment",
    max_bytes=0,  # from settings.max_upload_bytes, so an operator can change it
    types={
        "application/pdf": (".pdf",),
        **_IMAGES,
        "text/csv": (".csv",),
        "text/plain": (".txt",),
    },
    aliases={**_IMAGE_ALIASES, "application/csv": "text/csv", "text/x-csv": "text/csv"},
)
#: Chat attachments: the same types as ``ATTACHMENT``, but a photo someone sends in a chat is
#: re-encoded like any other image — a phone's picture carries GPS in its EXIF, and a channel
#: of colleagues (or a client) should not receive where it was taken. Re-encoding applies to
#: the image types only; a PDF or a CSV passes through untouched.
CHAT_FILE = FileKind(
    "chat",
    max_bytes=0,
    types=ATTACHMENT.types,
    image_max_side=2560,
    aliases=ATTACHMENT.aliases,
)
#: A file on a workspace task (W2): PDF, JPG, PNG or Word, up to 10 MB. Pictures are re-encoded
#: like chat's (a phone's photo carries GPS in its EXIF, and a task is read by colleagues).
TASK_FILE = FileKind(
    "task",
    max_bytes=10 * MB,
    types={
        "application/pdf": (".pdf",),
        "image/jpeg": (".jpg", ".jpeg"),
        "image/png": (".png",),
        DOCX: (".docx",),
    },
    image_max_side=2560,
    aliases=_IMAGE_ALIASES,
)
#: A drawn signature on a delivery order: a PNG from a canvas, small, and re-encoded like any image.
SIGNATURE = FileKind(
    "signature",
    max_bytes=1 * MB,
    types={"image/png": (".png",)},
    image_max_side=1000,
)
PHOTO = FileKind(
    "photo", max_bytes=15 * MB, types=_IMAGES, image_max_side=2560, aliases=_IMAGE_ALIASES
)
ARTWORK = FileKind(
    "artwork", max_bytes=15 * MB, types=_IMAGES, image_max_side=3000, aliases=_IMAGE_ALIASES
)
VIDEO = FileKind(
    "video",
    max_bytes=200 * MB,
    types={"video/mp4": (".mp4",), "video/quicktime": (".mov",), "video/webm": (".webm",)},
)
MUSIC = FileKind(
    "music",
    max_bytes=20 * MB,
    types={"audio/mpeg": (".mp3",), "audio/mp4": (".m4a",)},
    aliases={"audio/mp3": "audio/mpeg", "audio/x-m4a": "audio/mp4", "audio/aac": "audio/mp4"},
)

KINDS: dict[str, FileKind] = {
    k.name: k for k in (ATTACHMENT, CHAT_FILE, TASK_FILE, SIGNATURE, PHOTO, ARTWORK, VIDEO, MUSIC)
}

#: Every stored extension's type, so a content-addressed key can be served with the right one.
_TYPE_FOR_EXT = {exts[0]: mime for kind in KINDS.values() for mime, exts in kind.types.items()}


def _limit(kind: FileKind) -> int:
    return kind.max_bytes or get_settings().max_upload_bytes


def sniff(head: bytes) -> str | None:
    """The format the first bytes announce, as a MIME type; ``None`` if unrecognised."""
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    if head.startswith(b"%PDF-"):
        return "application/pdf"
    if head.startswith(b"PK\x03\x04"):
        return "application/zip"  # a Word document is one (checked inside, see ``_check_docx``)
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return "video/webm"
    if head[4:8] == b"ftyp":
        brand = head[8:12]
        if brand == b"qt  ":
            return "video/quicktime"
        if brand in (b"M4A ", b"M4B "):
            return "audio/mp4"
        return "video/mp4"
    if head.startswith(b"ID3") or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    return None


def _agrees(declared: str, sniffed: str | None, head: bytes) -> bool:
    if declared in ("text/csv", "text/plain"):
        # No signature to sniff. Excel and Notepad write UTF-8, Windows-1252 or UTF-16 with a
        # byte-order mark, and finance staff export all three; accept those. Anything else
        # with a NUL byte is binary pretending to be text.
        if head[:2] in (BOM_UTF16_LE, BOM_UTF16_BE):
            return True
        return sniffed is None and NUL not in head
    if declared == DOCX:
        return sniffed == "application/zip"
    if declared == "audio/mp4":
        return sniffed in ("audio/mp4", "video/mp4")  # many encoders write a generic brand
    return sniffed == declared


def _check_docx(path: Path) -> None:
    """A real Word document: a zip with the two parts every one has, that does not unpack to
    something enormous. A zip with a .docx name is not enough."""
    try:
        with zipfile.ZipFile(path) as archive:
            names = set(archive.namelist())
            if "[Content_Types].xml" not in names or "word/document.xml" not in names:
                raise Invalid("That file is not a Word document.")
            if sum(info.file_size for info in archive.infolist()) > MAX_DOCX_UNPACKED:
                raise Invalid("That document unpacks to something too large.")
    except zipfile.BadZipFile as exc:
        raise Invalid("That file is not a Word document.") from exc


@dataclass(slots=True)
class Stored:
    storage_key: str
    sha256: str
    byte_size: int
    content_type: str


@dataclass(frozen=True, slots=True)
class StoredFile:
    """One file in the store, as the sweeper sees it."""

    storage_key: str
    byte_size: int
    #: When the content was last stored or re-used (seconds since the epoch).
    modified: float


#: The shape of a key this module makes: ``ab/cd/<sha256>.<ext>``. The sweeper only ever considers
#: a file with this shape, so anything else someone put in the directory is never touched.
_KEY_SHAPE = re.compile(r"^[0-9a-f]{2}/[0-9a-f]{2}/[0-9a-f]{64}\.[a-z0-9]{1,8}$")
#: The ``ab`` and ``ab/cd`` fan-out directories a key lives in.
_FANOUT_SHAPE = re.compile(r"^[0-9a-f]{2}(/[0-9a-f]{2})?$")
#: An unfinished upload is a dot-file with this prefix (see ``LocalDiskStorage.save``).
_TEMP_PREFIX = ".upload-"


class StorageBackend(Protocol):
    def iter_files(self) -> Iterator[StoredFile]: ...
    def remove_stale_temp(self, *, older_than_seconds: float) -> int: ...
    def prune_empty_dirs(self) -> int: ...
    def save(
        self, stream: BinaryIO, *, kind: FileKind, content_type: str, filename: str | None
    ) -> Stored: ...
    def open(self, storage_key: str) -> BinaryIO: ...
    def delete(self, storage_key: str) -> None: ...
    def serve(
        self, storage_key: str, *, download_name: str | None = None, public: bool = False
    ) -> Response: ...


def validate(kind: FileKind, content_type: str, filename: str | None) -> tuple[str, str]:
    """Check type and extension against the kind; return ``(canonical type, stored ext)``."""
    declared = kind.canonical(content_type)
    allowed = kind.types.get(declared)
    accepted = ", ".join(sorted({e.lstrip(".").upper() for v in kind.types.values() for e in v}))
    if allowed is None:
        raise Invalid(f"{content_type} is not an accepted file type. Accepted: {accepted}.")
    # A name with no extension at all is accepted — the type and the bytes still have to
    # agree — because phones and some upload widgets send bare names. A *wrong* one is not.
    ext = Path(filename or "").suffix.lower()
    if ext and ext not in allowed:
        raise Invalid(f"{filename!r} does not have an accepted extension. Accepted: {accepted}.")
    return declared, allowed[0]


def _reencode(path: Path, kind: FileKind, content_type: str) -> None:
    """Decode and re-save in place: drops metadata, applies the size cap, refuses fakes."""
    assert kind.image_max_side is not None
    try:
        with Image.open(path) as img:
            # Pillow only *warns* between 1x and 2x its pixel limit; refuse at 1x, before
            # decoding, so a crafted header cannot make us allocate gigabytes.
            if img.width * img.height > MAX_IMAGE_PIXELS:
                raise Invalid("That image is too large in pixels.")
            img.load()
            image = ImageOps.exif_transpose(img)
            image.thumbnail((kind.image_max_side, kind.image_max_side))
            out = io.BytesIO()
            if content_type == "image/jpeg":
                image.convert("RGB").save(out, "JPEG", quality=85, optimize=True)
            elif content_type == "image/png":
                image.save(out, "PNG", optimize=True)
            else:
                # WebP takes RGB(A); a palette or greyscale image must be converted first.
                if image.mode not in ("RGB", "RGBA"):
                    image = image.convert("RGBA" if "transparency" in image.info else "RGB")
                image.save(out, "WEBP", quality=85)
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError) as exc:
        raise Invalid("That file is not a readable image.") from exc
    path.write_bytes(out.getvalue())


class LocalDiskStorage:
    """Content-addressed files under a root directory.

    The key is derived from the SHA-256 of the stored content, fanned out two levels so a
    directory never accumulates hundreds of thousands of entries.
    """

    def __init__(self, root: str | Path | None = None) -> None:
        self.root = Path(root or get_settings().storage_dir).resolve()

    def _path(self, storage_key: str) -> Path:
        path = (self.root / storage_key).resolve()
        # Defence in depth: a key should never escape the root, and if one ever does we
        # want a refusal rather than a read or write outside it.
        if not path.is_relative_to(self.root):
            raise Invalid("Invalid storage key.")
        return path

    def save(
        self, stream: BinaryIO, *, kind: FileKind, content_type: str, filename: str | None
    ) -> Stored:
        declared, ext = validate(kind, content_type, filename)
        limit = _limit(kind)
        self.root.mkdir(parents=True, exist_ok=True)

        fd, tmp_name = tempfile.mkstemp(dir=self.root, prefix=".upload-")
        tmp = Path(tmp_name)
        try:
            size = 0
            head = b""
            with os.fdopen(fd, "wb") as out:
                while chunk := stream.read(CHUNK):
                    if not head:
                        head = chunk[:64]
                    size += len(chunk)
                    # Measured while reading, not taken from Content-Length, which is a claim.
                    if size > limit:
                        raise Invalid(f"That file is larger than the {limit // MB} MB limit.")
                    out.write(chunk)

            if size == 0:
                raise Invalid("That file is empty.")
            if not _agrees(declared, sniff(head), head):
                raise Invalid(f"That file's contents are not a {declared} file.")
            if declared == DOCX:
                _check_docx(tmp)
            # Only images are re-encoded: a kind that also takes PDFs (chat) sets a size cap
            # for its pictures, and a PDF must not be fed to an image decoder.
            if kind.image_max_side is not None and declared.startswith("image/"):
                _reencode(tmp, kind, declared)

            digest = hashlib.sha256()
            with tmp.open("rb") as written:
                while block := written.read(CHUNK):
                    digest.update(block)
            sha = digest.hexdigest()
            key = f"{sha[:2]}/{sha[2:4]}/{sha}{ext}"
            path = self._path(key)
            path.parent.mkdir(parents=True, exist_ok=True)
            stored_size = tmp.stat().st_size
            if path.exists():
                tmp.unlink()
                # Same content again: touch it, so the orphan sweep's age guard treats it as new.
                os.utime(path)
            else:
                tmp.replace(path)
            return Stored(storage_key=key, sha256=sha, byte_size=stored_size, content_type=declared)
        finally:
            tmp.unlink(missing_ok=True)

    def open(self, storage_key: str) -> BinaryIO:
        path = self._path(storage_key)
        if not path.exists():
            raise NotFound("That file is no longer in the store.")
        return path.open("rb")

    def delete(self, storage_key: str) -> None:
        self._path(storage_key).unlink(missing_ok=True)

    def iter_files(self) -> Iterator[StoredFile]:
        """Every stored file whose name has the shape of a key this store made."""
        if not self.root.exists():
            return
        for path in self.root.rglob("*"):
            if not path.is_file() or path.name.startswith(_TEMP_PREFIX):
                continue
            key = path.relative_to(self.root).as_posix()
            if not _KEY_SHAPE.match(key):
                continue
            try:
                info = path.stat()
            except OSError:  # removed while listing
                continue
            yield StoredFile(storage_key=key, byte_size=info.st_size, modified=info.st_mtime)

    def remove_stale_temp(self, *, older_than_seconds: float) -> int:
        """Delete unfinished uploads (a crash between writing and renaming leaves one). A recent
        one may belong to an upload in progress, so only those older than the given age go."""
        if not self.root.exists():
            return 0
        cutoff = time.time() - older_than_seconds
        removed = 0
        for path in self.root.glob(f"{_TEMP_PREFIX}*"):
            try:
                if path.is_file() and path.stat().st_mtime < cutoff:
                    path.unlink()
                    removed += 1
            except OSError:
                continue
        return removed

    def prune_empty_dirs(self) -> int:
        """Remove the empty ``ab/cd`` fan-out directories a sweep leaves behind (never the root)."""
        if not self.root.exists():
            return 0
        removed = 0
        for path in sorted(self.root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
            rel = path.relative_to(self.root).as_posix()
            if path.is_dir() and _FANOUT_SHAPE.match(rel):
                try:
                    path.rmdir()  # fails (and is skipped) unless it is empty
                    removed += 1
                except OSError:
                    continue
        return removed

    def serve(
        self, storage_key: str, *, download_name: str | None = None, public: bool = False
    ) -> Response:
        """Stream the file. ``FileResponse`` answers Range requests, so video can seek.

        ``public`` is for invitation media, whose URL (an unguessable id) any guest's browser
        and any shared cache may keep; everything else stays private to the signed-in user."""
        path = self._path(storage_key)
        if not path.exists():
            raise NotFound("That file is no longer in the store.")
        return FileResponse(
            path,
            media_type=_TYPE_FOR_EXT.get(path.suffix, "application/octet-stream"),
            filename=download_name,
            content_disposition_type="attachment" if download_name else "inline",
            headers={
                # Content-addressed: the bytes behind a key never change.
                "Cache-Control": (
                    "public, max-age=86400, immutable"
                    if public
                    else "private, max-age=3600, immutable"
                ),
                "X-Content-Type-Options": "nosniff",
                # The page and the API are on different origins; a guest's <img> must load.
                **({"Cross-Origin-Resource-Policy": "cross-origin"} if public else {}),
            },
        )


# ---------------------------------------------------------------------------
# Signed URLs
# ---------------------------------------------------------------------------


def signed_file_path(storage_key: str, *, ttl_seconds: int | None = None) -> str:
    """A path under the API prefix that serves ``storage_key`` until it expires.

    For ``<img>``, ``<video>`` and ``<audio>`` tags, which cannot send a bearer token. The
    signature covers the key and the expiry, so neither can be changed.
    """
    settings = get_settings()
    expires = int(time.time()) + (ttl_seconds or settings.file_url_seconds)
    sig = sign("file", storage_key, str(expires))
    return f"{settings.api_prefix}/files/{storage_key}?exp={expires}&sig={sig}"


def check_signed(storage_key: str, exp: int, sig: str) -> None:
    if exp < int(time.time()) or not verify(sig, "file", storage_key, str(exp)):
        # One answer for expired, forged and malformed: none of them is the caller's business.
        raise NotFound("That file link has expired or is not valid.")


_backend: StorageBackend | None = None


def get_storage() -> StorageBackend:
    global _backend
    if _backend is None:
        _backend = LocalDiskStorage()
    return _backend


def set_storage(backend: StorageBackend | None) -> None:
    """Swap the backend — used by tests, and by whatever replaces local disk."""
    global _backend
    _backend = backend
