"""Workspace backend T3 — files on a task (W2).

Storage is a temporary directory per test. What these pin down is what the server decides on its
own: the bytes must be what they claim (a program renamed ``.pdf`` is refused, a ``.docx`` must be
a Word document), a photo loses its location, a task holds at most ten files, a done task takes no
more and loses none, only the uploader or the PM removes one, and a file is reached only by a
short-lived link minted after the access check.
"""

from __future__ import annotations

import datetime as dt
import io
import zipfile
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse

import pytest
from chat_world import World, login, world  # noqa: F401
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.clock import FrozenClock
from app.core.storage import DOCX, LocalDiskStorage, set_storage
from app.core.throttle import Throttle
from app.domain.audit.models import AuditEvent
from app.domain.chat import attachments
from app.domain.workspace.models import TaskAttachment, WorkspaceTask

D = "2026-08-30"
PDF = b"%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"


@pytest.fixture(autouse=True)
def disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[LocalDiskStorage]:
    backend = LocalDiskStorage(tmp_path)
    set_storage(backend)
    monkeypatch.setattr(
        attachments,
        "upload_throttle",
        Throttle("t", limit=10_000, window_seconds=10, block_seconds=1),
    )
    yield backend
    set_storage(None)


def png() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (32, 24), (20, 120, 220)).save(buf, "PNG")
    return buf.getvalue()


def jpeg_with_location() -> bytes:
    exif = Image.Exif()
    exif[0x8825] = {1: "S", 2: (6.0, 12.0, 0.0), 3: "E", 4: (106.0, 49.0, 0.0)}  # GPS
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def docx(*, real: bool = True) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        z.writestr("word/document.xml" if real else "other.xml", "<document/>")
    return buf.getvalue()


async def a_task(http: AsyncClient, api: str, w: World, **kw: Any) -> dict[str, Any]:
    await login(http, api, kw.pop("by", w.pm))
    body = {
        "project_id": w.a,
        "title": "Check the rigging",
        "assignee_id": str(w.staff.id),
        "deadline": D,
    }
    r = await http.post(f"{api}/tasks", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def upload(
    http: AsyncClient, api: str, task: dict[str, Any], name: str, data: bytes, ctype: str
) -> Any:
    return await http.post(
        f"{api}/tasks/{task['id']}/attachments", files={"file": (name, data, ctype)}
    )


# --- attaching ------------------------------------------------------------------------------


async def test_a_pdf_a_picture_and_a_word_document_are_accepted_and_shown_whole(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    await login(http, api, world.staff)
    for name, data, ctype, kind in [
        ("run-of-show.pdf", PDF, "application/pdf", "pdf"),
        ("stage.png", png(), "image/png", "image"),
        ("brief.docx", docx(), DOCX, "docx"),
    ]:
        frozen_clock.advance(dt.timedelta(seconds=1))  # files are listed in the order they came
        r = await upload(http, api, t, name, data, ctype)
        assert r.status_code == 201, (name, r.text)
        whole = r.json()
        assert (
            whole["attachments"][-1]["filename"] == name
            and whole["attachments"][-1]["kind"] == kind
        )
        assert whole["attachments"][-1]["uploader_no"] == world.staff.member_no
    assert [f["filename"] for f in whole["attachments"]] == [
        "run-of-show.pdf",
        "stage.png",
        "brief.docx",
    ]
    assert whole["rev"] == t["rev"] + 3
    assert [(a["kind"], a["text"]) for a in whole["activity"][-3:]] == [
        ("attach", "attached run-of-show.pdf"), ("attach", "attached stage.png"),
        ("attach", "attached brief.docx"),
    ]  # fmt: skip
    actions = (await db.execute(select(AuditEvent.action).order_by(AuditEvent.at))).scalars().all()
    assert actions.count("task.attach") == 3


@pytest.mark.parametrize(
    ("name", "data", "ctype", "why"),
    [
        ("virus.pdf", b"MZ\x90\x00\x03" + bytes(64), "application/pdf", "program renamed"),
        ("notes.docx", docx(real=False), DOCX, "a zip that is not a Word document"),
        ("fake.docx", b"PK\x03\x04" + bytes(40), DOCX, "not even a zip"),
        ("empty.pdf", b"", "application/pdf", "empty"),
        ("drawing.svg", b"<svg/>", "image/svg+xml", "never SVG"),
        ("sheet.csv", b"a,b\n1,2\n", "text/csv", "a type chat takes but tasks do not"),
        ("plan.exe", PDF, "application/pdf", "wrong extension"),
        ("pic.png", PDF, "image/png", "type and bytes disagree"),
    ],
)
async def test_a_file_that_is_not_what_it_claims_is_refused(
    anon_client: AsyncClient, api: str, world: World, name: str, data: bytes, ctype: str, why: str
) -> None:
    t = await a_task(anon_client, api, world)
    r = await upload(anon_client, api, t, name, data, ctype)
    assert r.status_code == 422, (why, r.text)
    await login(anon_client, api, world.pm)
    assert (await anon_client.get(f"{api}/tasks/{t['id']}")).json()["attachments"] == []


async def test_a_file_over_ten_megabytes_is_refused_and_a_photo_loses_its_location(
    anon_client: AsyncClient, api: str, world: World, disk: LocalDiskStorage
) -> None:
    t = await a_task(anon_client, api, world)
    big = PDF + bytes(10 * 1024 * 1024)
    assert (await upload(anon_client, api, t, "big.pdf", big, "application/pdf")).status_code == 422
    sent = jpeg_with_location()
    assert b"Exif" in sent
    r = await upload(anon_client, api, t, "site.jpg", sent, "image/jpeg")
    assert r.status_code == 201, r.text
    [row] = [p for p in disk.root.rglob("*.jpg")]
    assert b"Exif" not in row.read_bytes(), "re-encoded: the photo's GPS is gone"


async def test_a_task_holds_at_most_ten_files(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    t = await a_task(anon_client, api, world)
    for n in range(10):
        r = await upload(anon_client, api, t, f"f{n}.pdf", PDF + bytes([n]), "application/pdf")
        assert r.status_code == 201, (n, r.text)
    r = await upload(anon_client, api, t, "one-too-many.pdf", PDF + b"x", "application/pdf")
    assert r.status_code == 409 and "up to 10" in r.text


async def test_only_people_who_can_see_the_task_may_attach_and_a_done_task_takes_no_more(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    await login(http, api, world.lead_design)  # sees no Field task on project A
    assert (await upload(http, api, t, "a.pdf", PDF, "application/pdf")).status_code == 404
    await login(http, api, world.staff)
    assert (await upload(http, api, t, "a.pdf", PDF, "application/pdf")).status_code == 201

    for who, action in [
        (world.staff, "start"),
        (world.staff, "submit"),
        (world.lead_field, "approve"),
        (world.pm, "approve"),
    ]:
        await login(http, api, who)
        assert (await http.post(f"{api}/tasks/{t['id']}/{action}")).status_code == 200
    await login(http, api, world.staff)
    done = await upload(http, api, t, "late.pdf", PDF + b"1", "application/pdf")
    assert done.status_code == 409 and "done" in done.text


# --- removing and opening -------------------------------------------------------------------


async def test_the_uploader_or_the_pm_removes_a_file_and_nobody_else(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession, frozen_clock: FrozenClock
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    await login(http, api, world.lead_field)  # can see it (their division)
    mine = (await upload(http, api, t, "mine.pdf", PDF, "application/pdf")).json()["attachments"][0]
    frozen_clock.advance(dt.timedelta(seconds=1))
    await login(http, api, world.staff)
    theirs = (await upload(http, api, t, "theirs.pdf", PDF + b"2", "application/pdf")).json()[
        "attachments"
    ][1]

    url = f"{api}/tasks/{t['id']}/attachments"
    refused = await http.delete(f"{url}/{mine['id']}")
    assert refused.status_code == 403, "a colleague cannot remove someone else's file"
    ok = await http.delete(f"{url}/{theirs['id']}")
    assert ok.status_code == 200 and [f["filename"] for f in ok.json()["attachments"]] == [
        "mine.pdf"
    ]
    assert ok.json()["activity"][-1]["text"] == "removed theirs.pdf"
    await login(http, api, world.pm)
    gone = await http.delete(f"{url}/{mine['id']}")
    assert gone.status_code == 200 and gone.json()["attachments"] == []
    assert (await http.delete(f"{url}/{mine['id']}")).status_code == 404
    rows = (await db.execute(select(TaskAttachment))).scalars().all()
    assert rows == [], "the rows go; the stored bytes are never deleted here"
    audited = (await db.execute(select(AuditEvent.action).order_by(AuditEvent.at))).scalars().all()
    assert audited.count("task.detach") == 2


async def test_a_done_task_keeps_its_files(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    await login(http, api, world.staff)
    f = (await upload(http, api, t, "a.pdf", PDF, "application/pdf")).json()["attachments"][0]
    for who, action in [
        (world.staff, "start"),
        (world.staff, "submit"),
        (world.lead_field, "approve"),
        (world.pm, "approve"),
    ]:
        await login(http, api, who)
        await http.post(f"{api}/tasks/{t['id']}/{action}")
    await login(http, api, world.pm)
    assert (await http.delete(f"{api}/tasks/{t['id']}/attachments/{f['id']}")).status_code == 409


async def test_a_file_opens_by_a_short_lived_link_minted_after_the_access_check(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    await login(http, api, world.staff)
    f = (await upload(http, api, t, "run.pdf", PDF, "application/pdf")).json()["attachments"][0]
    r = await http.get(f"{api}/tasks/{t['id']}/attachments/{f['id']}/url")
    assert r.status_code == 200, r.text
    link = r.json()["url"]
    q = parse_qs(urlparse(link).query)
    assert {"exp", "sig"} <= set(q)
    served = await http.get(link)  # reachable by the link alone, as an <img> or a new tab would
    assert served.status_code == 200 and served.content == PDF

    await login(http, api, world.lead_design)  # cannot see the task: no link, whatever the file id
    assert (await http.get(f"{api}/tasks/{t['id']}/attachments/{f['id']}/url")).status_code == 404
    await login(http, api, world.staff)
    assert (
        await http.get(f"{api}/tasks/{t['id']}/attachments/{uuid_zero()}/url")
    ).status_code == 404


def uuid_zero() -> str:
    return "00000000-0000-0000-0000-000000000000"


async def test_a_demo_file_record_has_no_stored_copy_to_open(
    anon_client: AsyncClient, api: str, world: World, db: AsyncSession
) -> None:
    http = anon_client
    t = await a_task(http, api, world)
    row = (
        await db.execute(select(WorkspaceTask).where(WorkspaceTask.task_no == t["task_no"]))
    ).scalar_one()
    ghost = TaskAttachment(
        task_id=row.id, uploader_id=world.staff.id, storage_key=None, filename="seeded.pdf",
        kind="pdf", content_type="application/pdf", size_bytes=10, created_at=row.assigned_at,
    )  # fmt: skip
    db.add(ghost)
    await db.flush()
    await login(http, api, world.pm)
    r = await http.get(f"{api}/tasks/{t['id']}/attachments/{ghost.id}/url")
    assert r.status_code == 404 and "demo record" in r.text


async def test_a_file_id_from_another_task_does_not_work_through_this_one(
    anon_client: AsyncClient, api: str, world: World
) -> None:
    http = anon_client
    one = await a_task(http, api, world)
    two = await a_task(http, api, world)
    await login(http, api, world.staff)
    mine = (await upload(http, api, one, "one.pdf", PDF, "application/pdf")).json()["attachments"][
        0
    ]
    for call in (
        http.delete(f"{api}/tasks/{two['id']}/attachments/{mine['id']}"),
        http.get(f"{api}/tasks/{two['id']}/attachments/{mine['id']}/url"),
    ):
        assert (await call).status_code == 404
    still = (await http.get(f"{api}/tasks/{one['id']}")).json()["attachments"]
    assert [f["filename"] for f in still] == ["one.pdf"]


def test_svg_is_never_an_accepted_task_file_type() -> None:
    """Refused at the type check itself, before any bytes are read."""
    from app.core.errors import Invalid
    from app.core.storage import TASK_FILE, validate

    for ctype in ("image/svg+xml", "text/html", "application/x-msdownload"):
        with pytest.raises(Invalid):
            validate(TASK_FILE, ctype, "x.svg")
    assert validate(TASK_FILE, "application/pdf", "a.pdf") == ("application/pdf", ".pdf")
