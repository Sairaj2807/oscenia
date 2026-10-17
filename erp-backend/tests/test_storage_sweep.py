"""The orphaned-file sweep (P5): it takes what nothing refers to, and only that."""

from __future__ import annotations

import io
import os
import time
from collections.abc import Iterator
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core import storage_sweep
from app.core.storage import ATTACHMENT, LocalDiskStorage, set_storage
from app.core.storage_sweep import KEY_COLUMNS, sweep
from app.db.base import Base
from app.domain.cash.models import Attachment
from app.jobs import definitions

DAY = 24 * 60 * 60


@pytest.fixture
def disk(tmp_path: Path) -> Iterator[LocalDiskStorage]:
    backend = LocalDiskStorage(tmp_path)
    set_storage(backend)
    yield backend
    set_storage(None)


def pdf(tag: str) -> bytes:
    return b"%PDF-1.4\n1 0 obj<<>>endobj\n% " + tag.encode() + b"\ntrailer<<>>\n%%EOF\n"


def put(disk: LocalDiskStorage, tag: str, *, age_days: float = 0) -> str:
    """Store a file with no row behind it (an orphan), made `age_days` old."""
    stored = disk.save(
        io.BytesIO(pdf(tag)), kind=ATTACHMENT, content_type="application/pdf", filename="x.pdf"
    )
    if age_days:
        old = time.time() - age_days * DAY
        os.utime(disk._path(stored.storage_key), (old, old))
    return stored.storage_key


def exists(disk: LocalDiskStorage, key: str) -> bool:
    return disk._path(key).exists()


async def upload(client: AsyncClient, api: str, tag: str) -> dict[str, Any]:
    r = await client.post(
        f"{api}/attachments", files={"file": (f"{tag}.pdf", pdf(tag), "application/pdf")}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def key_of(db: Any, attachment: dict[str, Any]) -> str:
    """The API does not expose where a file is kept, so read it from the row."""
    found = await db.execute(
        select(Attachment.storage_key).where(Attachment.id == attachment["id"])
    )
    return str(found.scalar_one())


async def run(db: Any, disk: LocalDiskStorage, *, delete: bool, grace: int = 7):
    return await sweep(db, disk, delete=delete, grace_days=grace)


# ---------------------------------------------------------------------------
# What it takes and what it leaves
# ---------------------------------------------------------------------------


async def test_a_dry_run_reports_orphans_and_removes_nothing(
    db: Any, disk: LocalDiskStorage
) -> None:
    orphan = put(disk, "orphan", age_days=30)
    report = await run(db, disk, delete=False)
    assert report.dry_run is True
    assert report.orphans == 1 and report.deleted == 0 and report.orphan_bytes > 0
    assert report.sample == [orphan]
    assert exists(disk, orphan)


async def test_a_live_sweep_takes_an_old_orphan_and_keeps_a_referenced_file(
    client: AsyncClient, api: str, db: Any, disk: LocalDiskStorage
) -> None:
    kept = await upload(client, api, "kept")
    orphan = put(disk, "orphan", age_days=30)
    old = time.time() - 30 * DAY
    kept_key = await key_of(db, kept)
    os.utime(disk._path(kept_key), (old, old))  # old, but a row refers to it

    report = await run(db, disk, delete=True)
    assert report.deleted == 1 and report.freed_bytes > 0 and report.orphans == 1
    assert not exists(disk, orphan)
    assert exists(disk, kept_key), "a file a row refers to is never taken"


async def test_a_new_orphan_is_left_until_the_grace_period_passes(
    db: Any, disk: LocalDiskStorage
) -> None:
    fresh = put(disk, "fresh", age_days=1)
    edge = put(disk, "edge", age_days=6)
    report = await run(db, disk, delete=True)
    assert report.deleted == 0 and report.too_new == 2 and report.orphans == 0
    assert exists(disk, fresh) and exists(disk, edge)
    assert (await run(db, disk, delete=True, grace=0)).deleted == 2


async def test_a_file_that_is_not_one_of_ours_is_never_touched(
    db: Any, disk: LocalDiskStorage
) -> None:
    stranger = disk.root / "notes.txt"
    stranger.write_text("not a stored upload")
    deep = disk.root / "ab" / "cd" / "readme.md"
    deep.parent.mkdir(parents=True)
    deep.write_text("also not ours")
    old = time.time() - 90 * DAY
    for p in (stranger, deep):
        os.utime(p, (old, old))
    report = await run(db, disk, delete=True)
    assert report.scanned == 0 and report.deleted == 0
    assert stranger.exists() and deep.exists()


async def test_a_file_referenced_since_the_mark_is_rescued(
    client: AsyncClient, api: str, db: Any, disk: LocalDiskStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A row can start to refer to a file between the mark and the delete; it is looked up again."""
    kept = await upload(client, api, "raced")
    old = time.time() - 30 * DAY
    kept_key = await key_of(db, kept)
    os.utime(disk._path(kept_key), (old, old))

    async def stale_mark(_session: Any) -> set[str]:
        return set()  # the mark that was taken before the row existed

    monkeypatch.setattr(storage_sweep, "referenced_keys", stale_mark)
    report = await run(db, disk, delete=True)
    assert report.rescued == 1 and report.deleted == 0 and report.orphans == 0
    assert exists(disk, kept_key)


async def test_storing_the_same_content_again_makes_an_old_orphan_new(
    db: Any, disk: LocalDiskStorage
) -> None:
    key = put(disk, "same", age_days=30)
    again = put(disk, "same")  # the same bytes uploaded now
    assert again == key
    report = await run(db, disk, delete=True)
    assert report.deleted == 0 and report.too_new == 1 and exists(disk, key)


async def test_stale_temp_files_and_empty_folders_are_cleaned_but_a_fresh_upload_is_not(
    db: Any, disk: LocalDiskStorage
) -> None:
    stale = disk.root / ".upload-stale"
    fresh = disk.root / ".upload-fresh"
    stale.write_bytes(b"x")
    fresh.write_bytes(b"x")
    old = time.time() - 3 * DAY
    os.utime(stale, (old, old))
    orphan = put(disk, "gone", age_days=30)
    folder = disk._path(orphan).parent

    report = await run(db, disk, delete=True)
    assert report.temp_removed == 1 and not stale.exists() and fresh.exists()
    assert report.dirs_removed >= 1 and not folder.exists(), "the emptied fan-out folder goes"
    assert disk.root.exists(), "never the root"


async def test_an_empty_store_is_not_an_error(db: Any, tmp_path: Path) -> None:
    report = await sweep(
        db, LocalDiskStorage(tmp_path / "never-created"), delete=True, grace_days=7
    )
    assert report.scanned == 0 and report.deleted == 0


def test_every_table_with_a_storage_key_is_protected() -> None:
    """The one way the sweep can delete a live file is a key column it does not know about."""
    holders = {
        table.name
        for table in Base.metadata.tables.values()
        if any(column.name.endswith(("storage_key", "signature_key")) for column in table.columns)
    }
    protected = {column.class_.__tablename__ for column in KEY_COLUMNS}
    assert holders == protected, f"add {holders - protected} to KEY_COLUMNS"


# ---------------------------------------------------------------------------
# The scheduled job
# ---------------------------------------------------------------------------


async def test_the_job_only_reports_by_default(
    client: AsyncClient, api: str, disk: LocalDiskStorage
) -> None:
    orphan = put(disk, "orphan", age_days=30)
    run_ = await client.post(f"{api}/jobs/storage.sweep/run", json={})
    assert run_.status_code == 200, run_.text
    history = (await client.get(f"{api}/jobs/storage.sweep/runs")).json()
    detail = history[0]["detail"]
    assert detail["dry_run"] is True and detail["orphans"] == 1 and detail["deleted"] == 0
    assert exists(disk, orphan)


async def test_the_job_removes_orphans_once_switched_on(
    client: AsyncClient, api: str, disk: LocalDiskStorage, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        definitions,
        "get_settings",
        lambda: SimpleNamespace(storage_sweep_delete=True, storage_sweep_grace_days=7),
    )
    orphan = put(disk, "orphan", age_days=30)
    young = put(disk, "young", age_days=2)
    assert (await client.post(f"{api}/jobs/storage.sweep/run", json={})).status_code == 200
    detail = (await client.get(f"{api}/jobs/storage.sweep/runs")).json()[0]["detail"]
    assert detail["dry_run"] is False and detail["deleted"] == 1
    assert not exists(disk, orphan) and exists(disk, young)


async def test_a_run_with_nothing_to_do_says_so(
    client: AsyncClient, api: str, disk: LocalDiskStorage
) -> None:
    await client.post(f"{api}/jobs/storage.sweep/run", json={})
    run_ = (await client.get(f"{api}/jobs/storage.sweep/runs")).json()[0]
    assert run_["status"] == "skipped" and run_["detail"]["reason"] == "no orphaned files"
