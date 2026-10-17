"""Signed, revocable link tokens and check-in QR payloads."""

from __future__ import annotations

import pytest

from app.core.links import Claim, QrClaim, issue, parse_qr, qr_payload, read

NOW = 1_900_000_000


def test_a_guest_link_round_trips_and_can_be_minted_again() -> None:
    token = issue("guest", "G-014", 1, scope=("EV-01",))
    assert read("guest", token, scope=("EV-01",)) == Claim("G-014", 1)
    assert issue("guest", "G-014", 1, scope=("EV-01",)) == token, (
        "staff can copy the same link again — nothing is stored"
    )
    assert len(token) < 40, "short enough for a WhatsApp message and a QR"


def test_revoking_is_bumping_the_version() -> None:
    old = issue("guest", "G-014", 1, scope=("EV-01",))
    new = issue("guest", "G-014", 2, scope=("EV-01",))
    assert old != new
    # The token still verifies, but carries version 1; the caller compares with the row (2).
    claim = read("guest", old, scope=("EV-01",))
    assert claim is not None and claim.version == 1


def test_a_token_cannot_be_replayed_on_another_event_or_purpose() -> None:
    token = issue("guest", "G-014", 1, scope=("EV-01",))
    assert read("guest", token, scope=("EV-02",)) is None
    assert read("client", token, scope=("EV-01",)) is None


@pytest.mark.parametrize(
    "tamper",
    [
        lambda t: t.replace("G-014", "G-015"),
        lambda t: t.replace(".1.", ".2."),
        lambda t: t[:-2] + ("AA" if not t.endswith("AA") else "BB"),
        lambda t: t.rsplit(".", 1)[0],
        lambda t: "",
        lambda t: "x" * 500,
        lambda t: "G-014.1.garbage.extra.parts",
    ],
)
def test_tampered_or_garbage_tokens_read_as_nothing(tamper) -> None:  # type: ignore[no-untyped-def]
    token = issue("guest", "G-014", 1, scope=("EV-01",))
    assert read("guest", tamper(token), scope=("EV-01",)) is None


def test_the_client_link_expires() -> None:
    token = issue("client", "EV-01", 3, ttl_seconds=30 * 86400, now=NOW)
    assert read("client", token, now=NOW + 29 * 86400) == Claim("EV-01", 3, NOW + 30 * 86400)
    assert read("client", token, now=NOW + 30 * 86400) is None


def test_the_expiry_cannot_be_stretched() -> None:
    token = issue("client", "EV-01", 3, ttl_seconds=60, now=NOW)
    subject, version, expires, mac = token.split(".")
    stretched = ".".join([subject, version, str(int(expires) + 10**6), mac])
    assert read("client", stretched, now=NOW) is None


def test_a_purpose_that_must_expire_refuses_an_immortal_token() -> None:
    immortal = issue("client", "EV-01", 3)
    assert read("client", immortal) is not None
    assert read("client", immortal, require_expiry=True) is None
    expiring = issue("client", "EV-01", 3, ttl_seconds=60, now=NOW)
    assert read("client", expiring, require_expiry=True, now=NOW) is not None


def test_non_ascii_digits_read_as_nothing() -> None:
    assert read("guest", "G-014.².AAAAAAAAAAAAAAAAAAAAAA") is None
    assert parse_qr("OSC1:EV-01:G-014:²:AAAAAAAAAAAAAAAAAAAAAA") is None


def test_ids_with_separators_are_refused_at_issue() -> None:
    with pytest.raises(ValueError):
        issue("guest", "G.014", 1)
    with pytest.raises(ValueError):
        issue("guest", "G-014", 0)


def test_a_qr_payload_round_trips() -> None:
    payload = qr_payload("EV-01", "G-014", 2)
    assert payload.startswith("OSC1:EV-01:G-014:2:")
    assert parse_qr(payload) == QrClaim("EV-01", "G-014", 2)


@pytest.mark.parametrize(
    "payload",
    [
        "OSCENIA:EV-01:G-014",  # the prototype's guessable code
        "OSC1:EV-01:G-015:2:" + "A" * 22,  # a guessed guest id
        "",
        "OSC1:EV-01:G-014:x:abc",
    ],
)
def test_unsigned_or_forged_qr_codes_are_refused(payload: str) -> None:
    assert parse_qr(payload) is None


def test_a_qr_cannot_be_moved_to_another_guest() -> None:
    mac = qr_payload("EV-01", "G-014", 1).rsplit(":", 1)[1]
    assert parse_qr(f"OSC1:EV-01:G-015:1:{mac}") is None
    assert parse_qr(f"OSC1:EV-02:G-014:1:{mac}") is None
