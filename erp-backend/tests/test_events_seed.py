"""The demo events load as the prototype has them — the same counts its checks assert."""

from __future__ import annotations

from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import DEMO_TODAY, FrozenClock
from app.domain.ar.models import Client
from app.domain.ledger.numbering import next_document_no
from app.domain.masters.models import Role, User
from app.seed.events import seed_events

NOW = FrozenClock(DEMO_TODAY).now()


async def _seed(db: AsyncSession) -> None:
    db.add(Client(client_no=await next_document_no(db, "client"), name="Aurora Bank"))
    await db.flush()
    ceo = (await db.execute(select(User).where(User.role == Role.CEO))).scalars().first()
    assert ceo is not None
    report = await seed_events(db, created_by=ceo, now=NOW)
    assert (report.events, report.guests, report.scans) == (3, 62, 37)
    again = await seed_events(db, created_by=ceo, now=NOW)
    assert again.events == 0, "idempotent"


async def _event(client: AsyncClient, api: str, no: str) -> dict:
    return next(e for e in (await client.get(f"{api}/events")).json() if e["event_no"] == no)


async def test_the_demo_events(db: AsyncSession, client: AsyncClient, api: str) -> None:
    await _seed(db)
    gala = await _event(client, api, "EV-01")
    assert gala["status"] == "Published" and gala["rsvp_open"] and gala["client_id"] is not None
    detail = (await client.get(f"{api}/events/{gala['id']}")).json()
    assert detail["invite"]["published"]["template_id"] == "gala"
    assert not detail["invite"]["has_unpublished_changes"]
    assert [q["key"] for q in detail["questions"]] == ["Q-1", "Q-2", "Q-3"]
    assert (
        await client.post(f"{api}/events/{gala['id']}/questions", json={"type": "text"})
    ).json()["key"] == "Q-4", "seeded keys are never reissued"
    wishes = (await client.get(f"{api}/events/{gala['id']}/wishes")).json()
    assert len(wishes) == 3 and all(w["state"] == "shown" for w in wishes)

    meridian = await _event(client, api, "EV-02")
    assert not meridian["rsvp_open"], "the past launch is closed"
    grid = (await client.get(f"{api}/events/{meridian['id']}/report")).json()["grid"]
    cells = ("rsvp_came", "rsvp_no_show", "no_rsvp_came", "no_rsvp_no_show")
    assert [len(grid[k]) for k in cells] == [16, 4, 5, 6]

    wedding = await _event(client, api, "EV-03")
    assert wedding["status"] == "Draft" and wedding["client_id"] is None

    new = (await client.post(f"{api}/events", json={"name": "Next", "date": "2026-12-01"})).json()
    assert new["event_no"] == "EV-04", "numbering continues after the seed"


async def test_a_seeded_guests_card_checks_in(
    db: AsyncSession, client: AsyncClient, api: str
) -> None:
    await _seed(db)
    gala = await _event(client, api, "EV-01")
    url = f"{api}/events/{gala['id']}"
    guest = next(g for g in (await client.get(f"{url}/guests")).json() if not g["checked_in_at"])
    r = await client.post(f"{url}/scans", json={"qr": guest["qr"]})
    assert r.status_code == 201 and r.json()["first_arrival"]
