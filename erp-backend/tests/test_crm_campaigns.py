"""The contact list across events, and marketing campaigns made from it.

Nothing is sent: a campaign is a record with a fixed audience. What these tests hold to is what the
rules promise: the server (not the screen) decides who is in the audience, from consent that was
given; the audience does not change after the fact; and a person who is erased or who unsubscribes
is not messaged and does not linger in a campaign.
"""

from __future__ import annotations

import csv
import io
import re
import uuid
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_guests import make_event

from app.core import rbac
from app.domain.audit.models import AuditEvent
from app.domain.crm.models import Campaign, CampaignRecipient
from app.domain.events.models import Guest, RsvpAnswer
from app.domain.events.rules import norm_phone
from app.domain.masters.models import Role

pytestmark = pytest.mark.phase1

WHEN = datetime(2026, 7, 1, 10, 0, tzinfo=UTC)
LATER = datetime(2026, 8, 1, 10, 0, tzinfo=UTC)

#: The keys the contact list uses for the people in ``pool``.
ANTON = "p:628123456789" + "0"
BUDI = "p:62811111111"
CITRA = "e:citra@x.test"
DEWI = "p:62822222222"
EKO = "p:62833333333"


async def _guest(
    db: AsyncSession, event_id: str, name: str, phone: str = "", email: str = "", **kw: Any
) -> Guest:
    consent = kw.pop("consent", False)
    row = Guest(
        event_id=uuid.UUID(event_id),
        name=name,
        phone=phone,
        phone_norm=norm_phone(phone),
        email=email,
        rsvp=kw.pop("rsvp", RsvpAnswer.ATTENDING),
        consent=consent,
        consent_at=kw.pop("consent_at", WHEN if consent else None),
        responded_at=kw.pop("responded_at", WHEN),
        created_at=WHEN,
        **kw,
    )
    db.add(row)
    await db.flush()
    return row


@pytest.fixture
async def pool(client: AsyncClient, api: str, db: AsyncSession) -> dict[str, Any]:
    """Two events and the people who came to them.

    Anton is at both (a different phone format the second time, and he left the box unticked then);
    Budi never agreed; Citra gave only an email; Dewi gave only a phone; Eko is at the second event;
    Faisal left no way to reach him.
    """
    gala = await make_event(client, api, name="Gala")
    launch = await make_event(client, api, name="Launch", date="2026-12-11")
    guests = {
        "anton1": await _guest(db, gala["id"], "Anton", "0812 3456 7890", consent=True),
        "budi": await _guest(db, gala["id"], "Budi", "0811111111"),
        "citra": await _guest(db, gala["id"], "Citra", "", "citra@x.test", consent=True),
        "dewi": await _guest(
            db, gala["id"], "Dewi", "0822222222", consent=True, checked_in_at=WHEN
        ),
        "anton2": await _guest(
            db,
            launch["id"],
            "Anton S",
            "+62 812-3456-7890",
            "anton@x.test",
            responded_at=LATER,
        ),  # fmt: skip
        "eko": await _guest(db, launch["id"], "Eko", "0833333333", consent=True),
        "faisal": await _guest(db, launch["id"], "Faisal"),
    }
    return {"gala": gala, "launch": launch, **guests}


async def _contacts(client: AsyncClient, api: str, **params: Any) -> list[dict[str, Any]]:
    r = await client.get(f"{api}/crm/contacts", params=params)
    assert r.status_code == 200, r.text
    return r.json()


async def _make(
    client: AsyncClient, api: str, keys: list[str], channel: str = "whatsapp", **extra: Any
) -> Any:
    return await client.post(
        f"{api}/crm/campaigns",
        json={"name": "Thank you", "channel": channel, "message": "Hello!", "keys": keys, **extra},
    )


async def _campaign(client: AsyncClient, api: str, keys: list[str], **kw: Any) -> dict[str, Any]:
    r = await _make(client, api, keys, **kw)
    assert r.status_code == 201, r.text
    return r.json()


# --- the contact list ------------------------------------------------------------------------


async def test_guests_are_merged_by_phone_and_those_with_no_way_to_reach_them_are_left_out(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    contacts = await _contacts(client, api)
    assert [c["name"] for c in contacts] == ["Anton S", "Budi", "Citra", "Dewi", "Eko"]
    by_key = {c["key"]: c for c in contacts}
    anton = by_key[ANTON]
    assert anton["phone"] == "+62 812-3456-7890" and anton["email"] == "anton@x.test"
    assert [e["name"] for e in anton["events"]] == ["Gala", "Launch"]
    assert {e["event_id"] for e in anton["events"]} == {
        pool["gala"]["event_no"], pool["launch"]["event_no"]
    }  # fmt: skip
    assert by_key[CITRA]["phone"] == "" and by_key[CITRA]["email"] == "citra@x.test"
    assert not any(c["name"] == "Faisal" for c in contacts)


async def test_consent_given_once_is_kept_when_a_later_rsvp_leaves_the_box_unticked(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    by_key = {c["key"]: c for c in await _contacts(client, api)}
    assert by_key[ANTON]["consent"] is True and by_key[ANTON]["consent_source"] == "Gala"
    assert by_key[BUDI]["consent"] is False and by_key[BUDI]["consent_at"] is None


async def test_the_list_can_be_narrowed_by_event_attendance_consent_and_text(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    gala = pool["gala"]["event_no"]
    names = lambda items: [c["name"] for c in items]  # noqa: E731
    assert names(await _contacts(client, api, event=gala)) == ["Anton S", "Budi", "Citra", "Dewi"]
    assert names(await _contacts(client, api, event=gala, attended=True)) == ["Dewi"]
    assert names(await _contacts(client, api, attended=True)) == ["Dewi"]
    assert names(await _contacts(client, api, consented=True)) == [
        "Anton S",
        "Citra",
        "Dewi",
        "Eko",
    ]
    assert names(await _contacts(client, api, q="0833")) == ["Eko"]
    assert names(await _contacts(client, api, q="CITRA@")) == ["Citra"]
    assert await _contacts(client, api, event="EVT-NOPE") == []


# --- making a campaign -----------------------------------------------------------------------


async def test_a_whatsapp_campaign_reaches_those_who_agreed_and_have_a_phone(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [ANTON, BUDI, CITRA, DEWI, EKO])
    assert re.fullmatch(r"CMP-\d{4}", made["campaign_no"]) and made["channel"] == "whatsapp"
    # Five ticked; Budi never agreed; Citra agreed but has no phone to WhatsApp.
    assert (made["requested_count"], made["skipped_count"], made["unreachable_count"]) == (5, 1, 1)
    assert made["recipient_count"] == 3 and made["sent_count"] == 0
    assert [r["name"] for r in made["recipients"]] == ["Anton S", "Dewi", "Eko"]
    assert [r["position"] for r in made["recipients"]] == [1, 2, 3]
    first = made["recipients"][0]
    assert first["status"] == "pending" and first["consent_at"] is not None
    assert first["consent_source"] == "Gala"
    assert (
        first["link"].startswith("https://wa.me/628123456789") and "text=Hello%21" in first["link"]
    )


async def test_an_email_campaign_reaches_those_who_agreed_and_have_an_email(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [ANTON, BUDI, CITRA, DEWI, EKO], channel="email")
    assert [r["name"] for r in made["recipients"]] == ["Anton S", "Citra"]
    assert made["unreachable_count"] == 2, "Dewi and Eko agreed but gave no email"
    link = made["recipients"][1]["link"]
    assert link.startswith("mailto:citra%40x.test?subject=Thank%20you&body=Hello%21")


@pytest.mark.parametrize(
    "keys",
    [[BUDI], ["p:60000000000"], ["e:nobody@x.test"], [BUDI, "p:60000000000"]],
)
async def test_a_campaign_that_would_reach_nobody_is_refused(
    client: AsyncClient, api: str, pool: dict[str, Any], keys: list[str]
) -> None:
    r = await _make(client, api, keys)
    assert r.status_code == 422 and "Nobody would receive" in r.text
    assert (await client.get(f"{api}/crm/campaigns")).json() == []


async def test_a_campaign_to_people_who_agreed_but_cannot_be_reached_on_the_channel_is_refused(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    r = await _make(client, api, [CITRA], channel="whatsapp")
    assert r.status_code == 422 and "reached by whatsapp" in r.text


@pytest.mark.parametrize(
    "body",
    [
        {"name": "  ", "channel": "whatsapp", "keys": ["p:1"]},
        {"name": "x", "channel": "sms", "keys": ["p:1"]},
        {"name": "x", "channel": "whatsapp", "keys": []},
        {"name": "x", "channel": "whatsapp", "keys": ["p:" + str(i) for i in range(5001)]},
        {"name": "x", "channel": "whatsapp", "keys": ["p:1"], "message": "x" * 2001},
        # The screen's idea of who agreed is not read: an unknown field is refused outright.
        {"name": "x", "channel": "whatsapp", "keys": ["p:1"], "consent": True},
        {"name": "x", "channel": "whatsapp", "keys": ["p:1"], "recipients": [{"name": "Eve"}]},
    ],
)
async def test_a_malformed_campaign_request_is_refused(
    client: AsyncClient, api: str, pool: dict[str, Any], body: dict[str, Any]
) -> None:
    assert (await client.post(f"{api}/crm/campaigns", json=body)).status_code == 422


async def test_campaigns_are_numbered_in_order_and_listed_newest_first(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    one = await _campaign(client, api, [DEWI])
    two = await _campaign(client, api, [DEWI, EKO])
    # A sequence is not rolled back with a transaction, so only the format and the order are fixed.
    assert re.fullmatch(r"CMP-\d{4}", one["campaign_no"])
    assert int(two["campaign_no"][4:]) == int(one["campaign_no"][4:]) + 1
    listed = (await client.get(f"{api}/crm/campaigns")).json()
    assert [c["campaign_no"] for c in listed] == [two["campaign_no"], one["campaign_no"]]
    assert [c["recipient_count"] for c in listed] == [2, 1]
    assert listed[0]["created_by"] and "recipients" not in listed[0]


async def test_making_a_campaign_is_audited_with_counts_and_no_contact_details(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    made = await _campaign(client, api, [ANTON, BUDI, DEWI])
    row = (
        await db.execute(
            select(AuditEvent).where(
                AuditEvent.entity_id == made["id"], AuditEvent.action == "crm.campaign.create"
            )
        )
    ).scalar_one()
    assert row.detail == {
        "campaign_no": made["campaign_no"], "channel": "whatsapp",
        "requested": 3, "skipped": 1, "unreachable": 0,
    }  # fmt: skip
    assert "0812" not in str(row.detail) and "anton@" not in str(row.detail)


# --- the audience is a snapshot --------------------------------------------------------------


async def test_the_audience_does_not_change_when_the_guests_do(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI])
    before = (await client.get(f"{api}/crm/campaigns/{made['id']}")).json()

    # Afterwards the guests change in every way short of erasure, and somebody new agrees.
    pool["dewi"].name = "Dewi Renamed"
    pool["dewi"].phone = "0899999999"
    pool["dewi"].phone_norm = "62899999999"
    pool["dewi"].consent = False
    pool["dewi"].consent_at = None
    await _guest(db, pool["gala"]["id"], "Newcomer", "0877777777", consent=True)
    await db.flush()

    after = (await client.get(f"{api}/crm/campaigns/{made['id']}")).json()
    assert after["recipients"] == before["recipients"], "the snapshot is what it was"
    assert after["recipient_count"] == 2
    rows = (await db.execute(select(CampaignRecipient).where(
        CampaignRecipient.campaign_id == uuid.UUID(made["id"])
    ))).scalars().all()  # fmt: skip
    assert {r.name for r in rows} == {"Anton S", "Dewi"}
    assert all(r.consent_at is not None for r in rows), "the consent they had is kept"


# --- unsubscribing ---------------------------------------------------------------------------


async def test_an_unsubscribe_clears_consent_and_flags_the_person_in_unsent_campaigns(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI])
    first = made["recipients"][0]
    done = await client.post(f"{api}/crm/campaigns/{made['id']}/recipients/{first['id']}/mark-sent")
    assert done.status_code == 200  # Anton was already reached

    r = await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": ANTON})
    assert r.status_code == 200 and r.json() == {"guests": 1, "pending_recipients": 0}
    r = await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": DEWI})
    assert r.json() == {"guests": 1, "pending_recipients": 1}

    by_key = {c["key"]: c for c in await _contacts(client, api)}
    assert by_key[DEWI]["consent"] is False and by_key[DEWI]["consent_at"] is None
    assert by_key[ANTON]["consent"] is False
    await db.refresh(pool["dewi"])
    assert pool["dewi"].consent is False and pool["dewi"].consent_at is None

    detail = (await client.get(f"{api}/crm/campaigns/{made['id']}")).json()
    anton, dewi = detail["recipients"]
    assert anton["status"] == "sent", "somebody already reached stays reached"
    assert dewi["status"] == "unsubscribed" and dewi["link"] is None
    assert dewi["consent_at"] is not None, "what they agreed to then is a fact, and is kept"

    refused = await client.post(
        f"{api}/crm/campaigns/{made['id']}/recipients/{dewi['id']}/mark-sent"
    )
    assert refused.status_code == 409 and "unsubscribed" in refused.text
    again = await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": DEWI})
    assert again.status_code == 200 and again.json()["guests"] == 0, "saying it twice is harmless"
    assert (await _make(client, api, [DEWI])).status_code == 422, "no later campaign reaches them"


@pytest.mark.parametrize("key", ["", "nonsense", "p:12", "x:123456789", "e:not-an-email"])
async def test_an_unsubscribe_needs_a_real_contact_key(
    client: AsyncClient, api: str, pool: dict[str, Any], key: str
) -> None:
    assert (
        await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": key})
    ).status_code == 422


async def test_unsubscribing_somebody_who_is_not_a_contact_is_a_404(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    r = await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": "p:60000000000"})
    assert r.status_code == 404


async def test_an_unsubscribe_is_audited_without_the_phone_or_email(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": CITRA})
    rows = (
        await db.execute(select(AuditEvent).where(AuditEvent.action == "crm.contact.unsubscribe"))
    ).scalars().all()  # fmt: skip
    assert len(rows) == 1 and rows[0].detail == {"guests": 1, "pending_recipients": 0}
    assert "citra" not in str([rows[0].entity_id, rows[0].detail])


# --- erasing a guest -------------------------------------------------------------------------


async def test_erasing_a_guest_blanks_them_in_every_campaign_made_from_them(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI, EKO])
    other = await _campaign(client, api, [ANTON])

    # Anton is one person merged from two guests; erasing either one forgets him.
    erased = await client.post(
        f"{api}/events/{pool['launch']['id']}/guests/{pool['anton2'].id}/erase"
    )
    assert erased.status_code == 200, erased.text

    for campaign in (made, other):
        detail = (await client.get(f"{api}/crm/campaigns/{campaign['id']}")).json()
        anton = detail["recipients"][0]
        assert anton["erased"] is True and anton["status"] == "erased"
        assert (anton["name"], anton["phone"], anton["email"]) == ("", "", "")
        assert anton["link"] is None
    detail = (await client.get(f"{api}/crm/campaigns/{made['id']}")).json()
    assert [r["name"] for r in detail["recipients"]] == ["", "Dewi", "Eko"], "others are untouched"
    assert detail["recipient_count"] == 3, "the count of who was meant to be reached is a fact"

    row = (
        await db.execute(
            select(CampaignRecipient)
            .where(CampaignRecipient.campaign_id == uuid.UUID(made["id"]))
            .order_by(CampaignRecipient.position)
        )
    ).scalars().first()  # fmt: skip
    assert row is not None and row.contact_key is None and row.source_guest_ids == []
    assert row.erased_at is not None

    audit = (
        await db.execute(select(AuditEvent).where(AuditEvent.action == "guest.erase"))
    ).scalar_one()
    assert audit.detail and audit.detail["campaign_recipients_cleared"] == 2

    gone = await client.post(
        f"{api}/crm/campaigns/{made['id']}/recipients/{detail['recipients'][0]['id']}/mark-sent"
    )
    assert gone.status_code == 409 and "erased" in gone.text


async def test_an_erased_guest_is_not_in_the_contact_list_or_a_new_campaign(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    await client.post(f"{api}/events/{pool['launch']['id']}/guests/{pool['eko'].id}/erase")
    assert EKO not in {c["key"] for c in await _contacts(client, api)}
    assert (await _make(client, api, [EKO])).status_code == 422


# --- marking people reached ------------------------------------------------------------------


async def test_a_recipient_is_marked_reached_once(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI])
    first = made["recipients"][0]
    url = f"{api}/crm/campaigns/{made['id']}/recipients/{first['id']}/mark-sent"
    r = await client.post(url)
    assert r.status_code == 200 and r.json()["status"] == "sent" and r.json()["link"] is None
    assert (await client.post(url)).status_code == 409
    listed = (await client.get(f"{api}/crm/campaigns")).json()[0]
    assert listed["sent_count"] == 1 and listed["recipient_count"] == 2
    ghost = f"{api}/crm/campaigns/{made['id']}/recipients/{uuid.uuid4()}/mark-sent"
    assert (await client.post(ghost)).status_code == 404


async def test_a_recipient_of_another_campaign_cannot_be_marked_through_this_one(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    one = await _campaign(client, api, [DEWI])
    two = await _campaign(client, api, [EKO])
    stray = two["recipients"][0]["id"]
    r = await client.post(f"{api}/crm/campaigns/{one['id']}/recipients/{stray}/mark-sent")
    assert r.status_code == 404


async def test_mark_everyone_reached_leaves_out_the_unsubscribed(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI, EKO])
    await client.post(f"{api}/crm/contacts/unsubscribe", json={"key": EKO})
    r = await client.post(f"{api}/crm/campaigns/{made['id']}/mark-sent")
    assert r.status_code == 200
    assert [x["status"] for x in r.json()["recipients"]] == ["sent", "sent", "unsubscribed"]
    assert r.json()["sent_count"] == 2
    assert (await client.post(f"{api}/crm/campaigns/{uuid.uuid4()}/mark-sent")).status_code == 404


# --- the CSV ---------------------------------------------------------------------------------


async def test_the_export_is_a_csv_with_one_row_per_recipient(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [ANTON, DEWI])
    await client.post(
        f"{api}/crm/campaigns/{made['id']}/recipients/{made['recipients'][1]['id']}/mark-sent"
    )
    r = await client.get(f"{api}/crm/campaigns/{made['id']}/export")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/csv")
    assert r.headers["content-disposition"] == f'attachment; filename="{made["campaign_no"]}.csv"'
    rows = list(csv.reader(io.StringIO(r.text)))
    assert rows[0] == [
        "Name", "Phone", "Email", "Status", "Reached at", "Consent given", "Consent source",
    ]  # fmt: skip
    assert [row[0] for row in rows[1:]] == ["Anton S", "Dewi"]
    assert [row[3] for row in rows[1:]] == ["pending", "sent"]
    assert rows[2][4] != "" and rows[1][4] == ""
    assert (await client.get(f"{api}/crm/campaigns/{uuid.uuid4()}/export")).status_code == 404


async def test_the_export_writes_a_formula_as_text_and_quotes_what_needs_quoting(
    client: AsyncClient, api: str, db: AsyncSession, pool: dict[str, Any]
) -> None:
    evil = await _guest(
        db, pool["gala"]["id"], '=HYPERLINK("http://evil.test","click")', "0841111111", consent=True
    )
    comma = await _guest(db, pool["gala"]["id"], 'Gunawan, "Bud" S.', "0842222222", consent=True)
    plus = await _guest(db, pool["gala"]["id"], "+1 mallory", "0843333333", consent=True)
    keys = [f"p:{g.phone_norm}" for g in (evil, comma, plus)]
    made = await _campaign(client, api, keys)
    text = (await client.get(f"{api}/crm/campaigns/{made['id']}/export")).text
    parsed = {row[0] for row in csv.reader(io.StringIO(text))}
    assert '\'=HYPERLINK("http://evil.test","click")' in parsed, "a formula becomes text"
    assert "'+1 mallory" in parsed
    assert 'Gunawan, "Bud" S.' in parsed, "commas and quotes survive a round trip"
    assert not any(cell.startswith(("=", "+", "-", "@")) for cell in parsed - {"Name"})


async def test_an_erased_recipient_is_blank_in_the_export(
    client: AsyncClient, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [DEWI, EKO])
    await client.post(f"{api}/events/{pool['gala']['id']}/guests/{pool['dewi'].id}/erase")
    text = (await client.get(f"{api}/crm/campaigns/{made['id']}/export")).text
    rows = list(csv.reader(io.StringIO(text)))
    assert rows[1][:4] == ["", "", "", "erased"]
    assert "Dewi" not in text and "0822222222" not in text


# --- who may ---------------------------------------------------------------------------------


def test_the_permission_is_known_and_held_by_the_ceo_and_sales_only() -> None:
    assert "manage_campaigns" in rbac.ACTIONS
    holders = {role for role in Role if rbac.can_do(role, "manage_campaigns")}
    assert holders == {Role.CEO, Role.SALES}


async def test_finance_may_read_campaigns_but_not_make_or_mark_them(
    client: AsyncClient, client_for: Any, api: str, pool: dict[str, Any]
) -> None:
    made = await _campaign(client, api, [DEWI])
    recipient = made["recipients"][0]["id"]
    other = await client_for(Role.FINANCE)
    assert (await other.get(f"{api}/crm/contacts")).status_code == 200
    assert (await other.get(f"{api}/crm/campaigns")).status_code == 200
    assert (await other.get(f"{api}/crm/campaigns/{made['id']}")).status_code == 200
    assert (await other.get(f"{api}/crm/campaigns/{made['id']}/export")).status_code == 200
    for call in (
        other.post(
            f"{api}/crm/campaigns",
            json={"name": "x", "channel": "email", "keys": [CITRA]},
        ),
        other.post(f"{api}/crm/campaigns/{made['id']}/recipients/{recipient}/mark-sent"),
        other.post(f"{api}/crm/campaigns/{made['id']}/mark-sent"),
        other.post(f"{api}/crm/contacts/unsubscribe", json={"key": DEWI}),
    ):
        r = await call
        assert r.status_code == 403 and r.json()["action"] == "manage_campaigns", r.text


async def test_sales_may_run_campaigns_and_the_warehouse_may_not_even_read_them(
    client: AsyncClient, client_for: Any, api: str, pool: dict[str, Any]
) -> None:
    sales = await client_for(Role.SALES)
    assert (await _make(sales, api, [DEWI])).status_code == 201
    warehouse = await client_for(Role.WAREHOUSE)
    for call in (
        warehouse.get(f"{api}/crm/contacts"),
        warehouse.get(f"{api}/crm/campaigns"),
        warehouse.get(f"{api}/crm/campaigns/{uuid.uuid4()}"),
        warehouse.get(f"{api}/crm/campaigns/{uuid.uuid4()}/export"),
    ):
        assert (await call).status_code == 403


async def test_the_campaign_tables_hold_only_what_was_made(
    client: AsyncClient, api: str, pool: dict[str, Any], db: AsyncSession
) -> None:
    await _campaign(client, api, [ANTON, DEWI])
    rows = (await db.execute(select(Campaign))).scalars().all()
    assert len(rows) == 1 and rows[0].requested_count == 2
