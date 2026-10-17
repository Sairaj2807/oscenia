"""Invitation media: what staff and the client may upload, what content may name, and what a guest
(who has no login) can fetch."""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from media_samples import jpeg_bytes, mp3_bytes, mp4_bytes, png_bytes
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_events_public import stranger

from app.domain.audit.models import AuditEvent
from app.domain.events import media
from app.domain.events.models import EventMedia
from app.domain.masters.models import Role


@pytest.fixture
async def ev(client: AsyncClient, api: str) -> dict[str, Any]:
    made = (await client.post(f"{api}/events", json={"name": "Gala", "date": "2026-08-14"})).json()
    url = f"{api}/events/{made['id']}"
    await client.put(f"{url}/invite/template", json={"template_id": "gala"})
    key = (await client.get(f"{url}/client-link")).json()["token"]
    return {"id": made["id"], "no": made["event_no"], "url": url, "key": key}


async def up(
    client: AsyncClient, ev: dict[str, Any], data: bytes, name: str, mime: str, kind: str = "photo"
) -> dict[str, Any]:
    r = await client.post(
        f"{ev['url']}/media", params={"kind": kind}, files={"file": (name, data, mime)}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_a_photo_is_uploaded_saved_in_content_and_shown_to_a_guest_on_another_device(
    client: AsyncClient, api: str, ev: dict[str, Any]
) -> None:
    ref = await up(client, ev, png_bytes(), "cover.png", "image/png")
    assert uuid.UUID(ref["key"]) and ref["name"] == "cover.png" and ref["type"] == "image/png"

    cover = {"eyebrow": "", "title": "Gala", "subtitle": "", "image": ref}
    r = await client.put(f"{ev['url']}/invite/content/cover", json={"value": cover})
    assert r.status_code == 200
    assert r.json()["invite"]["content"]["cover"]["image"]["key"] == ref["key"]
    assert (await client.post(f"{ev['url']}/publish", json={})).status_code == 200

    page = (await stranger(client).get(f"{api}/public/invites/{ev['no']}")).json()
    assert page["invite"]["content"]["cover"]["image"]["key"] == ref["key"]

    got = await stranger(client).get(f"{api}/public/media/{ref['key']}")
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert got.content.startswith(b"\x89PNG")
    assert "public" in got.headers["cache-control"] and "immutable" in got.headers["cache-control"]
    assert got.headers["cross-origin-resource-policy"] == "cross-origin"
    assert got.headers["x-content-type-options"] == "nosniff"


async def test_video_and_music_can_be_seeked_with_range_requests(
    client: AsyncClient, api: str, ev: dict[str, Any]
) -> None:
    video = await up(client, ev, mp4_bytes(4096), "clip.mp4", "video/mp4", kind="video")
    song = await up(client, ev, mp3_bytes(), "song.mp3", "audio/mpeg", kind="music")
    anyone = stranger(client)

    part = await anyone.get(f"{api}/public/media/{video['key']}", headers={"Range": "bytes=0-99"})
    assert part.status_code == 206 and len(part.content) == 100
    assert part.headers["content-range"].startswith("bytes 0-99/")
    assert part.headers["accept-ranges"] == "bytes"
    assert (await anyone.get(f"{api}/public/media/{song['key']}")).status_code == 200


@pytest.mark.parametrize(
    ("data", "name", "mime", "kind"),
    [
        (b"not an image at all", "a.png", "image/png", "photo"),
        (mp4_bytes(), "a.png", "image/png", "photo"),
        (png_bytes(), "a.png", "image/png", "video"),
        (png_bytes(), "a.gif", "image/gif", "photo"),
        (png_bytes(), "a.png", "image/png", "attachment"),
        (b"", "empty.mp3", "audio/mpeg", "music"),
        (jpeg_bytes(), "wrong.mp3", "audio/mpeg", "music"),
    ],
)
async def test_the_wrong_kind_of_file_is_refused(
    client: AsyncClient, ev: dict[str, Any], data: bytes, name: str, mime: str, kind: str
) -> None:
    r = await client.post(
        f"{ev['url']}/media", params={"kind": kind}, files={"file": (name, data, mime)}
    )
    assert r.status_code == 422, r.text


async def test_content_can_only_name_the_events_own_uploads(
    client: AsyncClient, api: str, ev: dict[str, Any]
) -> None:
    mine = await up(client, ev, png_bytes(), "mine.png", "image/png")
    other = (
        await client.post(f"{api}/events", json={"name": "Other", "date": "2026-09-01"})
    ).json()
    other_ev = {"url": f"{api}/events/{other['id']}"}
    theirs = await up(client, other_ev, jpeg_bytes(), "theirs.jpg", "image/jpeg")

    forged = [
        {"key": "m-browser-local", "name": "x.png", "size": 5, "type": "image/png"},
        {"key": theirs["key"], "name": "x.png", "size": 5, "type": "image/png"},
        {"key": str(uuid.uuid4()), "name": "x.png", "size": 5, "type": "image/png"},
        {"key": "ab/cd/" + "0" * 64 + ".png", "name": "x.png", "size": 5, "type": "image/png"},
    ]
    for ref in forged:
        r = await client.put(
            f"{ev['url']}/invite/content/cover", json={"value": {"title": "T", "image": ref}}
        )
        assert r.status_code == 200
        assert r.json()["invite"]["content"]["cover"]["image"] is None, ref["key"]

    lying = {**mine, "name": "evil.exe", "size": 999999, "type": "application/x-evil"}
    r = await client.put(
        f"{ev['url']}/invite/content/gallery",
        json={"value": {"title": "", "photos": [forged[0], lying, forged[1]]}},
    )
    photos = r.json()["invite"]["content"]["gallery"]["photos"]
    assert photos == [mine], "forged entries leave the list; a kept one is as stored, not as sent"


async def test_the_client_uploads_with_the_edit_key_and_nothing_else(
    client: AsyncClient, api: str, ev: dict[str, Any], db: AsyncSession
) -> None:
    anyone = stranger(client)
    url = f"{api}/public/client/{ev['no']}/media"
    files = {"file": ("big.mp4", mp4_bytes(300 * 1024), "video/mp4")}  # over the 256 KB public cap

    for headers in ({}, {"X-Client-Key": "garbage"}):
        assert (
            await anyone.post(url, params={"kind": "video"}, files=files, headers=headers)
        ).status_code == 403

    r = await anyone.post(
        url, params={"kind": "video"}, files=files, headers={"X-Client-Key": ev["key"]}
    )
    assert r.status_code == 201, r.text
    ref = r.json()

    saved = await anyone.put(
        f"{api}/public/client/{ev['no']}/content/video",
        json={"value": {"kind": "upload", "file": ref, "url": "", "title": ""}},
        headers={"X-Client-Key": ev["key"]},
    )
    assert saved.status_code == 200
    assert saved.json()["invite"]["content"]["video"]["file"]["key"] == ref["key"]

    rows = (
        (await db.execute(select(AuditEvent).where(AuditEvent.action == "invitation.media")))
        .scalars()
        .all()
    )
    assert rows and rows[-1].actor_user_id is None and rows[-1].actor_label == "client link"


async def test_other_public_writes_are_still_capped_at_256_kb(
    client: AsyncClient, api: str, ev: dict[str, Any]
) -> None:
    r = await stranger(client).put(
        f"{api}/public/client/{ev['no']}/accent",
        content=b"x" * (300 * 1024),
        headers={"X-Client-Key": ev["key"], "content-type": "application/json"},
    )
    assert r.status_code == 413


async def test_an_unknown_or_malformed_id_is_one_404(client: AsyncClient, api: str) -> None:
    anyone = stranger(client)
    codes = {
        (await anyone.get(f"{api}/public/media/{i}")).status_code
        for i in (uuid.uuid4(), "nonsense", "../../etc/passwd", "ab" * 30)
    }
    assert codes == {404}


async def test_an_event_holds_only_so_many_uploads(
    client: AsyncClient, ev: dict[str, Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(media, "MAX_EVENT_FILES", 1)
    await up(client, ev, png_bytes(), "one.png", "image/png")
    r = await client.post(
        f"{ev['url']}/media", files={"file": ("two.png", png_bytes((9, 9)), "image/png")}
    )
    assert r.status_code == 409


async def test_template_artwork_is_uploaded_then_set_and_only_its_own(
    client: AsyncClient, client_for: Any, api: str, ev: dict[str, Any]
) -> None:
    t = f"{api}/invitation-templates"
    pm = await client_for(Role.PM)
    made = (await pm.post(t, json={"from_id": "royal"})).json()
    art = await pm.post(
        f"{t}/{made['id']}/art-upload", files={"file": ("bg.png", png_bytes(), "image/png")}
    )
    assert art.status_code == 201, art.text
    ok = await pm.put(f"{t}/{made['id']}/art/coverBg", json={"ref": art.json()})
    assert ok.status_code == 200 and ok.json()["art"]["coverBg"]["key"] == art.json()["key"]

    photo = await up(pm, ev, jpeg_bytes(), "p.jpg", "image/jpeg")
    r = await pm.put(f"{t}/{made['id']}/art/frame", json={"ref": photo})
    assert r.status_code == 422, "an event's photo is not template artwork"

    builtin = await pm.post(
        f"{t}/royal/art-upload", files={"file": ("bg.png", png_bytes(), "image/png")}
    )
    assert builtin.status_code == 409

    sales = await client_for(Role.SALES)
    denied = await sales.post(
        f"{t}/{made['id']}/art-upload", files={"file": ("bg.png", png_bytes(), "image/png")}
    )
    assert denied.status_code == 403


async def test_uploads_nobody_used_are_swept_but_used_ones_stay(
    client: AsyncClient, ev: dict[str, Any], db: AsyncSession
) -> None:
    used = await up(client, ev, png_bytes(), "used.png", "image/png")
    unused = await up(client, ev, jpeg_bytes(), "unused.jpg", "image/jpeg")
    await client.put(
        f"{ev['url']}/invite/content/cover", json={"value": {"title": "T", "image": used}}
    )
    eid = uuid.UUID(ev["id"])
    long_ago = datetime.now(UTC) - timedelta(days=30)
    for row in (await db.execute(select(EventMedia).where(EventMedia.event_id == eid))).scalars():
        row.created_at = long_ago
    await db.flush()

    gone = await media.sweep(db, event_id=eid, template_id=None, now=datetime.now(UTC))
    left = {str(r.id) for r in (await db.execute(select(EventMedia))).scalars()}
    assert gone == 1 and used["key"] in left and unused["key"] not in left

    fresh = await up(client, ev, mp3_bytes(), "new.mp3", "audio/mpeg", kind="music")
    row = await media.get_media(db, fresh["key"])
    assert row is not None
    # The app's clock is frozen in tests: judge "a day later" by the row's own stamp.
    soon = row.created_at + timedelta(days=1)
    assert await media.sweep(db, event_id=eid, template_id=None, now=soon) == 0
    assert await media.sweep(db, event_id=eid, template_id=None, now=soon + media.ORPHAN_AFTER) == 1
