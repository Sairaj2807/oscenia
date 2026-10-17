"""HMAC signatures for things handed to a browser that the server must later trust.

Short-lived file URLs today; invitation QR codes next. One primitive, so there is one
place to get constant-time comparison and domain separation right:

* **Domain separation.** Every signature covers a ``purpose`` (``file``, ``qr``, …) as well
  as its fields, so a signature minted for one use can never be replayed as another.
* **Unambiguous framing.** Fields are joined with a separator that may not appear inside
  them, so ``("ab", "c")`` and ``("a", "bc")`` cannot sign the same bytes.
* **Its own key.** ``SIGNING_SECRET`` is separate from ``JWT_SECRET``, so either can be
  rotated without the other. Rotating it invalidates every outstanding signed URL and QR.
"""

from __future__ import annotations

import base64
import hashlib
import hmac

from app.core.config import get_settings

_SEP = "\x1f"  # ASCII unit separator: never part of a key, id or timestamp


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def sign(purpose: str, *fields: str, length: int = 32) -> str:
    """A URL-safe signature over ``purpose`` and ``fields``.

    ``length`` truncates the MAC in bytes. 32 is the full SHA-256; 16 (128 bits) is still far
    beyond guessing and keeps a QR code small enough to scan from a phone screen.
    """
    if not 16 <= length <= 32:
        raise ValueError("signature length must be 16-32 bytes")
    for part in (purpose, *fields):
        if _SEP in part:
            raise ValueError("signed fields may not contain the separator")
    message = _SEP.join((purpose, *fields)).encode()
    digest = hmac.new(get_settings().signing_secret.encode(), message, hashlib.sha256).digest()
    return _b64(digest[:length])


def verify(signature: str, purpose: str, *fields: str, length: int = 32) -> bool:
    """Constant-time check. False rather than raising, for anything malformed."""
    try:
        expected = sign(purpose, *fields, length=length)
    except ValueError:
        return False
    return hmac.compare_digest(expected.encode(), signature.encode())
