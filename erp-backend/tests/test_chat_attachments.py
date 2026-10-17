"""Chat backend C4 — files in chat: upload, send, reach, remove.

Storage is a temporary directory per test. What these pin down is what the server decides on
its own: the bytes must be what they claim, a photo loses its location, a file can only be sent
by whoever uploaded it to the channel it was uploaded to, links are short-lived and re-checked,
and chat never deletes bytes another module might share.
"""

from __future__ import annotations

import io
import time
import uuid
from collections.abc import Iterator
from datetime import timedelta
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from chat_world import World, login, make_channel, world  # noqa: F401
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import FrozenClock
from app.core.storage import LocalDiskStorage, get_storage, set_storage
from app.core.throttle import Throttle
from app.domain.chat import attachments, messages
from app.domain.chat.models import ChatAttachment


@pytest.fixture(autouse=True)
def disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[LocalDiskStorage]:
    backend = LocalDiskStorage(tmp_path)
    set_storage(backend)
    # Neither throttle's window ever ages out on the frozen clock; give both room.
    loose = Throttle("t", limit=10_000, window_seconds=10, block_seconds=1)
    monkeypatch.setattr(attachments, "upload_throttle", loose)
    monkeypatch.setattr(messages, "send_throttle", loose)
    yield backend
    set_storage(None)


def pdf() -> bytes:
    return b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"


def png(size: tuple[int, int] = (32, 24)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, (20, 120, 220)).save(buf, "PNG")
    return buf.getvalue()


def jpeg_with_location(size: tuple[int, int] = (64, 48)) -> bytes:
    exif = Image.Exif()
    exif[0x010F] = "SecretPhoneMaker"
    exif[0x8825] = {1: "N", 2: (6.0, 12.0, 0.0), 3: "E", 4: (106.0, 50.0, 0.0)}
    buf = io.BytesIO()
    Image.new("RGB", size, (200, 30, 30)).save(buf, "JPEG", exif=exif)
    return buf.getvalue()


async def room(http: AsyncClient, api: str, w: World, name: str = "general") -> str:
    await login(http, api, w.pm)
    return (await make_channel(http, api, project_id=w.a, name=name))["id"]


async def send(
    http: AsyncClient,
    api: str,
    cid: str,
    data: bytes,
    name: str = "report.pdf",
    ctype: str = "application/pdf",
) -> Any:
    return await http.post(
        f"{api}/chat/channels/{cid}/attachments", files={"file": (name, data, ctype)}
    )


async def uploaded(
    http: AsyncClient, api: str, cid: str, data: bytes | None = None, **kw: Any
) -> dict[str, Any]:
    r = await send(http, api, cid, data if data is not None else pdf(), **kw)
    assert r.status_code == 201, r.text
    return r.json()


async def say(http: AsyncClient, api: str, cid: str, text: str, **extra: Any) -> Any:
    return await http.post(f"{api}/chat/channels/{cid}/messages", json={"text": text, **extra})


# --- the filename -------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "shown"),
    [
        ("report.pdf", "report.pdf"),
        ("..\\..\\secret\\report.pdf", "report.pdf"),
        ("/etc/passwd.txt", "passwd.txt"),
        ("  my   quarterly   plan .pdf", "my quarterly plan .pdf"),
        ("evil‮txt.pdf", "eviltxt.pdf"),  # a right-to-left override cannot disguise it
        ("bell\x07.pdf", "bell.pdf"),
        (".hidden.txt", "hidden.txt"),
        ("", "file.pdf"),
        (None, "file.pdf"),
    ],
)
def test_the_shown_filename_is_cleaned(raw: str | None, shown: str) -> None:
    assert attachments.clean_filename(raw, ".pdf") == shown


def test_a_very_long_filename_is_cut_but_keeps_its_extension() -> None:
    shown = attachments.clean_filename("x" * 300 + ".pdf", ".pdf")
    assert len(shown) <= attachments.FILENAME_MAX and shown.endswith(".pdf")


# --- uploading ----------------------------------------------------------------------------


async def test_an_upload_is_stored_and_reachable_by_its_link(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid, name="Plan 2026.pdf")

    assert att["filename"] == "Plan 2026.pdf" and att["content_type"] == "application/pdf"
    assert att["size_bytes"] == len(pdf())
    got = await http.get(att["url"])  # no bearer token: the signature is the credential
    assert got.status_code == 200 and got.content == pdf()
    assert got.headers["content-type"].startswith("application/pdf")
    assert got.headers["x-content-type-options"] == "nosniff"


async def test_a_photo_loses_its_location_and_is_resized(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    original = jpeg_with_location(size=(4000, 3000))
    assert Image.open(io.BytesIO(original)).getexif().get_ifd(0x8825), "test photo has GPS"

    att = await uploaded(http, api, cid, original, name="site.jpg", ctype="image/jpeg")
    row = (await db.execute(select(ChatAttachment))).scalars().one()
    stored = Image.open(get_storage().open(row.storage_key))
    assert dict(stored.getexif()) == {}  # the maker, the GPS: all gone
    assert max(stored.size) <= 2560  # resized
    assert att["content_type"] == "image/jpeg"


async def test_a_pdf_passes_through_untouched_whatever_the_image_rules(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    await uploaded(http, api, cid, pdf())
    row = (await db.execute(select(ChatAttachment))).scalars().one()
    assert get_storage().open(row.storage_key).read() == pdf()


@pytest.mark.parametrize(
    ("data", "name", "ctype"),
    [
        (
            b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>",
            "x.svg",
            "image/svg+xml",
        ),
        (b"MZ\x90\x00 pretend this is a program", "invoice.pdf", "application/pdf"),  # not a PDF
        (pdf(), "invoice.exe", "application/pdf"),  # extension disagrees
        (b"fake video bytes", "clip.mp4", "video/mp4"),  # not a chat file type
        (b"", "empty.pdf", "application/pdf"),
        (b"not an image at all", "pic.png", "image/png"),
    ],
)
async def test_a_file_that_is_not_what_it_claims_is_refused(
    data: bytes, name: str, ctype: str, world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    assert (await send(http, api, cid, data, name, ctype)).status_code == 422


async def test_a_file_over_the_size_limit_is_refused(
    world: World, anon_client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    import app.core.storage as storage

    monkeypatch.setattr(storage, "_limit", lambda kind: 100)
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    assert (await send(http, api, cid, pdf() + b"x" * 500)).status_code == 422


async def test_you_can_only_upload_where_you_can_read(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.intern)  # not on project A
    assert (await send(http, api, cid, pdf())).status_code == 404
    assert (await send(http, api, str(uuid.uuid4()), pdf())).status_code == 404
    await login(http, api, world.outsider)  # no workspace persona at all
    assert (await send(http, api, cid, pdf())).status_code == 403


async def test_a_flood_of_uploads_is_slowed_down(
    world: World, anon_client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        attachments,
        "upload_throttle",
        Throttle("up-test", limit=2, window_seconds=60, block_seconds=60),
    )
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    for _ in range(2):
        await uploaded(http, api, cid)
    assert (await send(http, api, cid, pdf())).status_code == 429


async def test_uploads_waiting_to_be_sent_are_capped(
    world: World, anon_client: AsyncClient, api: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(attachments, "MAX_UNLINKED_PER_USER", 2)
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    first = await uploaded(http, api, cid)
    await uploaded(http, api, cid)
    assert (await send(http, api, cid, pdf())).status_code == 409
    # Sending one frees a place.
    assert (await say(http, api, cid, "here", attachment_ids=[first["id"]])).status_code == 201
    assert (await send(http, api, cid, pdf())).status_code == 201


# --- sending a file -----------------------------------------------------------------------


async def test_a_message_carries_the_files_it_names(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    a = await uploaded(http, api, cid, name="plan.pdf")
    b = await uploaded(http, api, cid, png(), name="site.png", ctype="image/png")

    r = await say(http, api, cid, "plans attached", attachment_ids=[a["id"], b["id"]])
    assert r.status_code == 201
    carried = r.json()["attachments"]
    assert [x["filename"] for x in carried] == ["plan.pdf", "site.png"]
    assert all(x["url"].startswith(f"{api}/files/") for x in carried)

    listed = (await http.get(f"{api}/chat/channels/{cid}/messages")).json()["messages"]
    assert [x["filename"] for x in listed[0]["attachments"]] == ["plan.pdf", "site.png"]
    plain = await say(http, api, cid, "no files")
    assert plain.json()["attachments"] == []


async def test_a_message_can_carry_at_most_five_files_and_repeats_count_once(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    ids = [(await uploaded(http, api, cid))["id"] for _ in range(6)]
    assert (await say(http, api, cid, "too many", attachment_ids=ids)).status_code == 422
    ok = await say(http, api, cid, "five and a repeat", attachment_ids=[*ids[:5], ids[0], ids[1]])
    assert ok.status_code == 201 and len(ok.json()["attachments"]) == 5


async def test_you_can_only_send_your_own_unsent_uploads_to_the_channel_they_went_to(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.pm)
    other = (await make_channel(http, api, project_id=world.a, name="other"))["id"]

    await login(http, api, world.lead_field)
    theirs = await uploaded(http, api, cid)
    await login(http, api, world.staff)
    mine = await uploaded(http, api, cid)
    elsewhere = await uploaded(http, api, other)

    for bad in (theirs["id"], elsewhere["id"], str(uuid.uuid4())):
        r = await say(http, api, cid, "x", attachment_ids=[bad])
        assert r.status_code == 422, bad
    sent = await say(http, api, cid, "mine", attachment_ids=[mine["id"]])
    assert sent.status_code == 201
    # Already sent: cannot ride on a second message.
    assert (await say(http, api, cid, "again", attachment_ids=[mine["id"]])).status_code == 422


async def test_every_way_a_file_can_be_unavailable_gives_the_same_answer(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    """So guessing an attachment id says nothing about other people's uploads."""
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.lead_field)
    theirs = await uploaded(http, api, cid)
    await login(http, api, world.staff)
    missing = await say(http, api, cid, "x", attachment_ids=[str(uuid.uuid4())])
    foreign = await say(http, api, cid, "x", attachment_ids=[theirs["id"]])
    assert missing.json()["detail"] == foreign.json()["detail"]


async def test_a_retried_send_does_not_attach_the_files_twice(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid)
    body = {"text": "once", "client_msg_id": str(uuid.uuid4()), "attachment_ids": [att["id"]]}
    first = await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    again = await http.post(f"{api}/chat/channels/{cid}/messages", json=body)
    assert (first.status_code, again.status_code) == (201, 200)
    assert len(again.json()["attachments"]) == 1


async def test_deleting_a_message_removes_its_files_but_not_the_stored_bytes(
    world: World, db: AsyncSession, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid)
    m = (await say(http, api, cid, "to be deleted", attachment_ids=[att["id"]])).json()
    key = (await db.execute(select(ChatAttachment.storage_key))).scalars().one()

    gone = (await http.delete(f"{api}/chat/messages/{m['id']}")).json()
    assert gone["attachments"] == [] and gone["deleted"] is True
    assert (await db.execute(select(ChatAttachment))).scalars().all() == []
    assert get_storage().open(key).read() == pdf()  # bytes are content-addressed, maybe shared
    assert (await http.get(f"{api}/chat/attachments/{att['id']}/url")).status_code == 404


# --- reaching a file ----------------------------------------------------------------------


async def test_a_link_is_short_lived_and_cannot_be_forged(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid)
    query = parse_qs(urlparse(att["url"]).query)
    assert 0 < int(query["exp"][0]) - time.time() <= 305  # about five minutes

    forged = att["url"].replace("sig=", "sig=0")
    assert (await http.get(forged)).status_code == 404
    expired = att["url"].replace(f"exp={query['exp'][0]}", "exp=1")
    assert (await http.get(expired)).status_code == 404


async def test_a_fresh_link_is_only_given_to_someone_who_may_still_see_the_channel(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid)
    m = (await say(http, api, cid, "with a file", attachment_ids=[att["id"]])).json()
    url_path = f"{api}/chat/attachments/{att['id']}/url"

    await login(http, api, world.lead_field)  # a member
    fresh = await http.get(url_path)
    assert fresh.status_code == 200 and (await http.get(fresh.json()["url"])).content == pdf()
    await login(http, api, world.intern)  # not on the project
    assert (await http.get(url_path)).status_code == 404

    await login(http, api, world.pm)  # blocked members lose links although the message remains
    await http.patch(f"{api}/chat/channels/{cid}", json={"blocked_ids": [str(world.staff.id)]})
    await login(http, api, world.staff)
    assert (await http.get(url_path)).status_code == 404
    assert m["attachments"][0]["id"] == att["id"]
    assert (await http.get(f"{api}/chat/attachments/{uuid.uuid4()}/url")).status_code == 404


async def test_someone_elses_unsent_upload_is_not_visible_even_to_a_member(
    world: World, anon_client: AsyncClient, api: str
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    att = await uploaded(http, api, cid)
    url_path = f"{api}/chat/attachments/{att['id']}/url"
    assert (await http.get(url_path)).status_code == 200  # the uploader
    await login(http, api, world.lead_field)  # a member of the channel, not the uploader
    assert (await http.get(url_path)).status_code == 404


# --- housekeeping -------------------------------------------------------------------------


async def test_an_upload_nobody_attached_is_removed_after_a_day_but_a_sent_one_stays(
    world: World,
    db: AsyncSession,
    anon_client: AsyncClient,
    api: str,
    frozen_clock: FrozenClock,
) -> None:
    http = anon_client
    cid = await room(http, api, world)
    await login(http, api, world.staff)
    orphan = await uploaded(http, api, cid, png(), name="orphan.png", ctype="image/png")
    sent = await uploaded(http, api, cid, pdf(), name="sent.pdf")
    await say(http, api, cid, "sending one", attachment_ids=[sent["id"]])

    frozen_clock.advance(timedelta(hours=23))
    await uploaded(http, api, cid, jpeg_with_location(), name="a.jpg", ctype="image/jpeg")
    kept = {a.id for a in (await db.execute(select(ChatAttachment))).scalars()}
    assert uuid.UUID(orphan["id"]) in kept  # not a day old yet

    frozen_clock.advance(timedelta(hours=2))  # now 25 hours on
    await uploaded(http, api, cid, pdf() + b"\n", name="b.pdf")  # any upload tidies up
    left = {a.id for a in (await db.execute(select(ChatAttachment))).scalars()}
    assert uuid.UUID(orphan["id"]) not in left
    assert uuid.UUID(sent["id"]) in left  # attached files are never purged
