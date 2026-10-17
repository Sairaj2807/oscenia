"""The contact list across events, and marketing campaigns made from it.

A campaign here is a record: who was meant to be reached, with what message, and who has been
reached. The system sends nothing (there is no sending provider). Each recipient gets a link that
opens the message ready in WhatsApp or the mail app, a person presses send, then marks it done; the
list can also be exported as a CSV.

The rules that matter, and where they are kept:

* **The server decides the audience.** A request names contacts by key; the server pools the guests
  again, keeps those with marketing consent and a way to reach them on the chosen channel, and
  refuses a campaign that would reach nobody. Whatever a screen sent about consent is not read.
* **The audience is a snapshot.** It is fixed when the campaign is made, with the consent each
  person had then. It is never rewritten. What can change afterwards is only whether a recipient
  was marked reached, unsubscribed since, or erased.
* **Erasure and unsubscribing win.** Erasing a guest blanks every recipient row merged from them.
  An unsubscribe clears consent on the guests, and flags the person in campaigns they have not yet
  been reached by, so they are not messaged; the snapshot of their old consent is left as it was.
"""

from __future__ import annotations

import csv
import hashlib
import io
import re
import uuid
from collections.abc import Mapping
from datetime import datetime
from typing import Any
from urllib.parse import quote

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.domain.audit.service import record_audit
from app.domain.crm import contacts as contact_rules
from app.domain.crm.models import Campaign, CampaignRecipient
from app.domain.crm.schemas import CampaignDetail, CampaignOut, GuestContactOut, RecipientOut
from app.domain.events import rules as event_rules
from app.domain.events.models import Event, Guest
from app.domain.masters.models import User

_KEY = re.compile(r"^(p:\d{6,32}|e:[^\s@]+@[^\s@]+\.[^\s@]+)$")
#: A spreadsheet reads a cell starting with one of these as a formula, whatever it was meant to be.
_FORMULA_STARTS = ("=", "+", "-", "@", "\t", "\r")


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value is not None else None


# --- the contact list -------------------------------------------------------------------------


async def _pool(
    session: AsyncSession,
) -> tuple[list[dict[str, Any]], dict[str, list[uuid.UUID]], dict[str, str]]:
    """Every guest who still has personal data, merged into contacts.

    Returns the contacts, the guests each was merged from (by key), and each event's number by id.
    """
    rows = (
        await session.execute(
            select(Guest, Event)
            .join(Event, Event.id == Guest.event_id)
            .where(Guest.erased_at.is_(None))
        )
    ).all()
    guests: list[dict[str, Any]] = []
    events: dict[str, dict[str, Any]] = {}
    members: dict[str, list[uuid.UUID]] = {}
    for guest, event in rows:
        events[str(event.id)] = {
            "id": str(event.id),
            "name": event.name,
            "date": event.date.isoformat(),
        }
        guests.append(
            {
                "eventId": str(event.id),
                "name": guest.name,
                "phone": guest.phone,
                "email": guest.email,
                "rsvp": guest.rsvp.value if guest.rsvp else None,
                "walkIn": guest.walk_in,
                "checkedInAt": _iso(guest.checked_in_at),
                "respondedAt": _iso(guest.responded_at),
                "consent": guest.consent,
                "consentAt": _iso(guest.consent_at),
            }
        )
        key = contact_rules.contact_key(guest.phone, guest.email)
        if key is not None:
            members.setdefault(key, []).append(guest.id)
    merged = contact_rules.merge_contacts(guests, list(events.values()))
    numbers = {str(event.id): event.event_no for _, event in rows}
    return merged, members, numbers


def _out(contact: dict[str, Any], numbers: dict[str, str]) -> GuestContactOut:
    return GuestContactOut.model_validate(
        {
            "key": contact["key"],
            "name": contact["name"],
            "phone": contact["phone"],
            "email": contact["email"],
            "events": [
                {
                    "event_id": numbers.get(e["eventId"], e["eventId"]),
                    "name": e["name"],
                    "date": e["date"],
                    "rsvp": e["rsvp"],
                    "came": e["came"],
                }
                for e in contact["events"]
            ],
            "consent": contact["consent"],
            "consent_at": contact["consentAt"],
            "consent_source": contact["consentSource"],
        }
    )


async def list_contacts(
    session: AsyncSession,
    *,
    event_no: str | None = None,
    attended: bool = False,
    consented: bool = False,
    q: str | None = None,
) -> list[GuestContactOut]:
    contacts, _members, numbers = await _pool(session)
    by_number = {number: event_id for event_id, number in numbers.items()}
    wanted = by_number.get(event_no) if event_no else None
    if event_no and wanted is None:
        return []
    needle = (q or "").strip().lower()

    def keep(contact: dict[str, Any]) -> bool:
        if wanted is not None:
            if not any(
                e["eventId"] == wanted and (not attended or e["came"]) for e in contact["events"]
            ):
                return False
        elif attended and not any(e["came"] for e in contact["events"]):
            return False
        if consented and not contact["consent"]:
            return False
        haystack = (contact["name"].lower(), contact["phone"], contact["email"].lower())
        return not needle or any(needle in part for part in haystack)

    return [_out(c, numbers) for c in contacts if keep(c)]


# --- making a campaign ------------------------------------------------------------------------


def _reachable(contact: Mapping[str, Any], channel: str) -> bool:
    if channel == "whatsapp":
        return len(event_rules.norm_phone(contact["phone"])) >= event_rules.MIN_PHONE_DIGITS
    return event_rules.is_email(contact["email"])


async def create_campaign(
    session: AsyncSession,
    *,
    user: User,
    name: str,
    channel: str,
    message: str,
    keys: list[str],
    now: datetime,
) -> Campaign:
    """Fix an audience and record the campaign. See the module notes for what the server decides."""
    title = " ".join(name.split())
    if not title:
        raise Invalid("A campaign needs a name.")
    contacts, members, _numbers = await _pool(session)
    consenting, skipped = contact_rules.campaign_audience(contacts, set(keys))
    reach = [c for c in consenting if _reachable(c, channel)]
    if not reach:
        why = (
            "nobody ticked agreed to marketing messages"
            if not consenting
            else f"none of the people who agreed can be reached by {channel}"
        )
        raise Invalid(f"Nobody would receive this campaign: {why}.")

    number = (await session.execute(func.nextval("campaign_no_seq"))).scalar_one()
    campaign = Campaign(
        campaign_no=f"CMP-{number:04d}",
        name=title,
        channel=channel,
        message=message.strip(),
        created_by=user.id,
        created_at=now,
        requested_count=len(consenting) + len(skipped),
        skipped_count=len(skipped),
        unreachable_count=len(consenting) - len(reach),
    )
    session.add(campaign)
    await session.flush()
    for position, contact in enumerate(reach, start=1):
        session.add(
            CampaignRecipient(
                campaign_id=campaign.id,
                position=position,
                name=contact["name"],
                phone=contact["phone"],
                email=contact["email"],
                contact_key=contact["key"],
                source_guest_ids=members.get(contact["key"], []),
                consent_at=datetime.fromisoformat(contact["consentAt"])
                if contact["consentAt"]
                else None,
                consent_source=contact["consentSource"],
            )
        )
    await session.flush()
    return campaign


# --- reading ----------------------------------------------------------------------------------


def _status(row: CampaignRecipient) -> str:
    if row.erased_at is not None:
        return "erased"
    if row.sent_at is not None:
        return "sent"
    if row.unsubscribed_at is not None:
        return "unsubscribed"
    return "pending"


def _link(campaign: Campaign, row: CampaignRecipient) -> str | None:
    """The link that opens this message ready to send, while the person is still to be reached."""
    if _status(row) != "pending":
        return None
    # ``{name}`` in the message is filled in per person; the stored message stays the template.
    text = quote(campaign.message.replace("{name}", row.name))
    if campaign.channel == "whatsapp":
        digits = event_rules.norm_phone(row.phone)
        return f"https://wa.me/{digits}?text={text}" if digits else None
    if not event_rules.is_email(row.email):
        return None
    return f"mailto:{quote(row.email)}?subject={quote(campaign.name)}&body={text}"


async def _get(session: AsyncSession, campaign_id: uuid.UUID) -> Campaign:
    campaign = await session.get(Campaign, campaign_id)
    if campaign is None:
        raise NotFound(f"No campaign {campaign_id}.")
    return campaign


async def list_campaigns(session: AsyncSession) -> list[CampaignOut]:
    total = func.count(CampaignRecipient.id)
    reached = func.count(CampaignRecipient.id).filter(CampaignRecipient.sent_at.is_not(None))
    rows = (
        await session.execute(
            select(Campaign, User.full_name, total, reached)
            .outerjoin(User, User.id == Campaign.created_by)
            .outerjoin(CampaignRecipient, CampaignRecipient.campaign_id == Campaign.id)
            .group_by(Campaign.id, User.full_name)
            .order_by(Campaign.created_at.desc(), Campaign.campaign_no.desc())
        )
    ).all()
    return [_summary(c, author, n, sent) for c, author, n, sent in rows]


def _summary(campaign: Campaign, author: str | None, count: int, sent: int) -> CampaignOut:
    return CampaignOut.model_validate(
        {
            "id": campaign.id,
            "campaign_no": campaign.campaign_no,
            "name": campaign.name,
            "channel": campaign.channel,
            "message": campaign.message,
            "created_at": campaign.created_at,
            "created_by": author,
            "requested_count": campaign.requested_count,
            "skipped_count": campaign.skipped_count,
            "unreachable_count": campaign.unreachable_count,
            "recipient_count": count,
            "sent_count": sent,
        }
    )


async def _recipients(session: AsyncSession, campaign_id: uuid.UUID) -> list[CampaignRecipient]:
    return list(
        (
            await session.execute(
                select(CampaignRecipient)
                .where(CampaignRecipient.campaign_id == campaign_id)
                .order_by(CampaignRecipient.position)
            )
        ).scalars()
    )


async def detail(session: AsyncSession, campaign_id: uuid.UUID) -> CampaignDetail:
    campaign = await _get(session, campaign_id)
    rows = await _recipients(session, campaign_id)
    author = (
        await session.execute(select(User.full_name).where(User.id == campaign.created_by))
    ).scalar_one_or_none()
    recipients = [
        RecipientOut.model_validate(
            {
                "id": r.id,
                "position": r.position,
                "name": r.name,
                "phone": r.phone,
                "email": r.email,
                "consent_at": r.consent_at,
                "consent_source": r.consent_source,
                "sent_at": r.sent_at,
                "unsubscribed_at": r.unsubscribed_at,
                "erased": r.erased_at is not None,
                "status": _status(r),
                "link": _link(campaign, r),
            }
        )
        for r in rows
    ]
    summary = _summary(campaign, author, len(rows), sum(1 for r in rows if r.sent_at is not None))
    return CampaignDetail(**summary.model_dump(), recipients=recipients)


# --- marking people reached -------------------------------------------------------------------


async def mark_sent(
    session: AsyncSession,
    campaign_id: uuid.UUID,
    recipient_id: uuid.UUID,
    *,
    user: User,
    now: datetime,
) -> CampaignRecipient:
    row = await session.get(CampaignRecipient, recipient_id)
    if row is None or row.campaign_id != campaign_id:
        raise NotFound("There is no such recipient in this campaign.")
    status = _status(row)
    if status == "sent":
        raise Conflict("That recipient was already marked as reached.")
    if status in ("erased", "unsubscribed"):
        raise Conflict(f"That recipient is {status}; they are not to be messaged.")
    row.sent_at = now
    row.sent_by = user.id
    await session.flush()
    return row


async def mark_all_sent(
    session: AsyncSession, campaign_id: uuid.UUID, *, user: User, now: datetime
) -> int:
    """Mark everyone still to be reached. Unsubscribed and erased people are left as they are."""
    await _get(session, campaign_id)
    done = await session.execute(
        update(CampaignRecipient)
        .where(
            CampaignRecipient.campaign_id == campaign_id,
            CampaignRecipient.sent_at.is_(None),
            CampaignRecipient.unsubscribed_at.is_(None),
            CampaignRecipient.erased_at.is_(None),
        )
        .values(sent_at=now, sent_by=user.id)
    )
    await session.flush()
    return int(getattr(done, "rowcount", 0) or 0)


# --- the CSV ----------------------------------------------------------------------------------


def _cell(value: object) -> str:
    """A CSV cell that a spreadsheet will show as text, never run as a formula."""
    text = "" if value is None else str(value)
    return f"'{text}" if text.startswith(_FORMULA_STARTS) else text


async def export_csv(session: AsyncSession, campaign_id: uuid.UUID) -> tuple[str, str]:
    """The recipient list as CSV, and a file name for it."""
    campaign = await _get(session, campaign_id)
    out = io.StringIO()
    writer = csv.writer(out, lineterminator="\r\n")
    writer.writerow(
        ["Name", "Phone", "Email", "Status", "Reached at", "Consent given", "Consent source"]
    )
    for row in await _recipients(session, campaign_id):
        writer.writerow(
            [
                _cell(row.name),
                _cell(row.phone),
                _cell(row.email),
                _status(row),
                _cell(_iso(row.sent_at)),
                _cell(_iso(row.consent_at)),
                _cell(row.consent_source),
            ]
        )
    return out.getvalue(), f"{campaign.campaign_no}.csv"


# --- unsubscribing and erasing ----------------------------------------------------------------


async def unsubscribe(
    session: AsyncSession, key: str, *, user: User, now: datetime
) -> tuple[int, int]:
    """Withdraw a contact's marketing consent, by explicit request.

    Clears consent on every guest the contact was merged from, and flags them in any campaign they
    have not been reached by yet. Returns ``(guests changed, pending recipients flagged)``.
    """
    if not _KEY.match(key):
        raise Invalid("That is not a contact key.")
    if key.startswith("p:"):
        match = Guest.phone_norm == key[2:]
    else:
        match = (Guest.phone_norm == "") & (func.lower(func.btrim(Guest.email)) == key[2:])
    guests = list(
        (await session.execute(select(Guest).where(match, Guest.erased_at.is_(None)))).scalars()
    )
    if not guests:
        raise NotFound("There is no contact with that key.")
    changed = 0
    for guest in guests:
        if guest.consent:
            guest.consent = False
            guest.consent_at = None  # the database keeps the two together
            changed += 1
    flagged = await session.execute(
        update(CampaignRecipient)
        .where(
            CampaignRecipient.contact_key == key,
            CampaignRecipient.sent_at.is_(None),
            CampaignRecipient.unsubscribed_at.is_(None),
            CampaignRecipient.erased_at.is_(None),
        )
        .values(unsubscribed_at=now)
    )
    pending = int(getattr(flagged, "rowcount", 0) or 0)
    await session.flush()
    # The audit row holds counts and a digest of the key, never the phone or email it stands for.
    await record_audit(
        session,
        actor=user,
        action="crm.contact.unsubscribe",
        entity_type="crm_contact",
        entity_id=hashlib.sha256(key.encode()).hexdigest()[:16],
        detail={"guests": changed, "pending_recipients": pending},
    )
    return changed, pending


async def scrub_guest(session: AsyncSession, guest_id: uuid.UUID, *, now: datetime) -> int:
    """A guest was erased: blank every campaign recipient that was merged from them.

    The whole row goes, not just the part that came from this guest, because a recipient merged
    from several guests is one person and that person asked to be forgotten. Returns how many were
    blanked.
    """
    done = await session.execute(
        update(CampaignRecipient)
        .where(
            CampaignRecipient.source_guest_ids.contains([guest_id]),
            CampaignRecipient.erased_at.is_(None),
        )
        .values(
            name="",
            phone="",
            email="",
            contact_key=None,
            source_guest_ids=[],
            erased_at=now,
        )
    )
    return int(getattr(done, "rowcount", 0) or 0)
