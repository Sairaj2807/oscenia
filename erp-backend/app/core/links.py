"""Signed, revocable link tokens and QR payloads: guest links, client edit links, check-in.

**Signed, not stored.** Staff copy a guest's personal link again and again — on the guest
list, into a WhatsApp message, for the client to send themselves — so the link must be
re-creatable on demand. A token stored only as a hash can be shown once. These tokens are
instead an HMAC over who they are for, so the server can mint the same link any number
of times and nothing secret sits in the database.

**Revoked by version.** Each token carries the version number stored on its row
(``guests.link_version``, ``events.edit_link_version`` — added with the events tables).
Revoking means bumping the number: every link and QR minted under the old version stops
verifying at once, and the next copy uses the new one. The caller compares
``claim.version`` with the row; this module only proves the token was minted by us.

**Scoped.** A token can be signed over extra fields it does not carry — a guest token over
its event id — so a valid token for one event cannot be replayed against another.

**Expiring where it makes sense.** The client edit link expires (``ttl_seconds``); a guest's
invitation link lives as long as the event, so it does not.

Format: ``<subject>.<version>[.<expires>].<mac>``, e.g. ``G-014.1.Xk3…`` — URL-safe, with a
128-bit MAC so it stays short in a link and a QR code. The prototype's guessable
``OSCENIA:EV-01:G-001`` QR payload becomes ``OSC1:EV-01:G-001:1:<mac>``.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass

from app.core.signing import sign, verify

MAC_BYTES = 16

#: Subjects and scopes are ids such as ``G-014``, ``EV-01`` or a UUID — never a separator.
_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

QR_PREFIX = "OSC1"


@dataclass(frozen=True, slots=True)
class Claim:
    subject: str
    version: int
    expires: int | None = None


def _number(text: str) -> bool:
    """ASCII digits only — ``str.isdigit`` also accepts characters such as superscripts."""
    return text.isascii() and text.isdecimal()


def _check_ids(*values: str) -> None:
    for value in values:
        if not _ID.match(value):
            raise ValueError(f"not a link-safe id: {value!r}")


def issue(
    purpose: str,
    subject: str,
    version: int,
    *,
    scope: tuple[str, ...] = (),
    ttl_seconds: int | None = None,
    now: int | None = None,
) -> str:
    """Mint a token for ``subject`` at ``version``. Deterministic unless it expires."""
    _check_ids(subject, *scope)
    if version < 1:
        raise ValueError("versions start at 1")
    parts = [subject, str(version)]
    if ttl_seconds is not None:
        parts.append(str((now if now is not None else int(time.time())) + ttl_seconds))
    mac = sign(f"link:{purpose}", *scope, *parts, length=MAC_BYTES)
    return ".".join([*parts, mac])


def read(
    purpose: str,
    token: str,
    *,
    scope: tuple[str, ...] = (),
    require_expiry: bool = False,
    now: int | None = None,
) -> Claim | None:
    """The claim inside a genuine, unexpired token; ``None`` for anything else.

    One answer for forged, expired, truncated and garbage, so a caller cannot be used to tell
    them apart. Checking ``claim.version`` against the row is the caller's job.

    ``require_expiry`` refuses a token minted without one — set it for purposes that must
    always expire (the client edit link), so a mistake at issue cannot make one immortal.
    """
    parts = token.split(".")
    if len(parts) not in (3, 4) or len(token) > 200:
        return None
    *fields, mac = parts
    subject, version_text = fields[0], fields[1]
    if not (_ID.match(subject) and _number(version_text)):
        return None
    if require_expiry and len(fields) != 3:
        return None
    if not all(_ID.match(s) for s in scope):
        return None
    if not verify(mac, f"link:{purpose}", *scope, *fields, length=MAC_BYTES):
        return None

    expires: int | None = None
    if len(fields) == 3:
        if not _number(fields[2]):
            return None
        expires = int(fields[2])
        if expires <= (now if now is not None else int(time.time())):
            return None
    return Claim(subject=subject, version=int(version_text), expires=expires)


# ---------------------------------------------------------------------------
# Check-in QR codes
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class QrClaim:
    event_id: str
    guest_id: str
    version: int


def qr_payload(event_id: str, guest_id: str, version: int) -> str:
    """What the guest's access card encodes. Tied to the guest's link version, so revoking
    their link also kills a screenshot of the old QR."""
    _check_ids(event_id, guest_id)
    mac = sign("qr", event_id, guest_id, str(version), length=MAC_BYTES)
    return f"{QR_PREFIX}:{event_id}:{guest_id}:{version}:{mac}"


def parse_qr(payload: str) -> QrClaim | None:
    """The scanned code's claim if we signed it; ``None`` for anything else, including the
    prototype's unsigned ``OSCENIA:…`` codes."""
    parts = payload.strip().split(":")
    if len(parts) != 5 or parts[0] != QR_PREFIX:
        return None
    _, event_id, guest_id, version_text, mac = parts
    if not (_ID.match(event_id) and _ID.match(guest_id) and _number(version_text)):
        return None
    if not verify(mac, "qr", event_id, guest_id, version_text, length=MAC_BYTES):
        return None
    return QrClaim(event_id=event_id, guest_id=guest_id, version=int(version_text))
