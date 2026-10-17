"""One contact list from every event's guests, and who a campaign reaches.

A port of ``guestContacts`` and ``campaignAudience`` from the prototype's ``lib/crm.js`` (BRD 5.1),
tested against the prototype's own answers (``tests/fixtures/crm_relations_matrix.json``).

Guests are pooled across events and de-duplicated by **phone**, the identity reminders and WhatsApp
use. Email only groups guests who gave no phone: a couple or an office sharing one inbox are
different people and must stay separate contacts. Consent is kept if the person ever gave it:
ticking the box on one RSVP and leaving it unticked on a later one is not a withdrawal. Withdrawing
is an explicit unsubscribe, which clears consent on the guests themselves.

A guest with neither phone nor email cannot be reached and is left out; so is an erased guest, whose
phone and email are blank by then.
"""

from __future__ import annotations

from collections.abc import Collection, Iterable, Mapping, Sequence
from typing import Any

from app.domain.events.rules import norm_email, norm_phone


def contact_key(phone: str | None, email: str | None) -> str | None:
    """``p:<normalised phone>``, else ``e:<normalised email>``, else nothing to reach them by."""
    phone_norm = norm_phone(phone)
    if phone_norm:
        return f"p:{phone_norm}"
    email_norm = norm_email(email)
    if email_norm:
        return f"e:{email_norm}"
    return None


def _answered_at(guest: Mapping[str, Any]) -> str:
    return guest.get("respondedAt") or guest.get("checkedInAt") or ""


def merge_contacts(
    guests: Iterable[Mapping[str, Any]], events: Sequence[Mapping[str, Any]]
) -> list[dict[str, Any]]:
    """Pool ``guests`` into one list of contacts, by name.

    Guests are dicts: ``eventId``, ``name``, ``phone``, ``email``, ``rsvp``, ``walkIn``,
    ``checkedInAt``, ``respondedAt``, ``consent``, ``consentAt`` (times as ISO strings, so the
    "latest" is the larger string). ``events`` are ``{id, name, date}``.
    """
    by_event = {e["id"]: e for e in events}
    by_key: dict[str, dict[str, Any]] = {}
    # Oldest answer first, so a later name or number wins; sorted() is stable like the prototype's.
    for guest in sorted(guests, key=_answered_at):
        key = contact_key(guest.get("phone"), guest.get("email"))
        if key is None:
            continue
        event = by_event.get(guest["eventId"])
        contact = by_key.get(key)
        if contact is None:
            contact = {
                "key": key,
                "name": guest["name"],
                "phone": guest.get("phone") or "",
                "email": "",
                "events": [],
                "consent": False,
                "consentAt": None,
                "consentSource": None,
            }
            by_key[key] = contact
        contact["name"] = guest["name"]
        contact["phone"] = guest.get("phone") or contact["phone"]
        contact["email"] = guest.get("email") or contact["email"]
        rsvp = "Walk-in" if guest.get("walkIn") else guest.get("rsvp") or "No response"
        contact["events"].append(
            {
                "eventId": guest["eventId"],
                "name": event["name"] if event else guest["eventId"],
                "date": event["date"] if event else "",
                "rsvp": rsvp,
                "came": bool(guest.get("checkedInAt")),
            }
        )
        consent_at = guest.get("consentAt")
        if guest.get("consent") and (not contact["consentAt"] or consent_at > contact["consentAt"]):
            contact["consent"] = True
            contact["consentAt"] = consent_at
            contact["consentSource"] = event["name"] if event else guest["eventId"]
    # Lower case before upper on a tie, as a locale-aware compare does.
    return sorted(by_key.values(), key=lambda c: (c["name"].casefold(), c["name"].swapcase()))


def campaign_audience(
    contacts: Iterable[Mapping[str, Any]], selected_keys: Collection[str]
) -> tuple[list[Mapping[str, Any]], list[Mapping[str, Any]]]:
    """Who a campaign reaches: the ticked contacts who gave marketing consent.

    Returns ``(recipients, skipped)``. A ticked contact without consent is skipped, never messaged,
    and counted so the sender is told. A key that matches nobody is ignored.
    """
    keys = set(selected_keys)
    picked = [c for c in contacts if c["key"] in keys]
    return [c for c in picked if c["consent"]], [c for c in picked if not c["consent"]]
