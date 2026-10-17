"""Find and remove stored files that nothing refers to.

Files are content-addressed (``ab/cd/<sha256>.ext``), so one stored file may be referenced by
rows in several tables, and removing a row never removes the file (see ``ChatAttachment``). Over
time that leaves orphans: an upload whose message was never sent, a file taken off a vendor, a
replaced photo.
They cost disk and, if they hold personal documents, outlive the thing that justified keeping them.

The sweep is built so it cannot take a file somebody still needs:

* **Mark first.** The set of keys every table refers to is read in full before anything is listed.
* **Age guard.** A file is only a candidate once it is older than the grace period (7 days), so the
  file an upload has just written, a moment before its row exists, is never one. Storing the same
  content again touches the file, so a re-used orphan counts as new.
* **Re-check before each delete.** Between the mark and the unlink a row may have started to refer
  to
  the file; each candidate is looked up once more, directly, before it is removed.
* **Dry run by default.** Until ``storage_sweep_delete`` is switched on it only reports.
* **Only keys this store made.** A file whose name is not ``ab/cd/<sha256>.ext`` is never listed, so
  anything else in the directory is left alone.

Add a table with a storage key to :data:`KEY_COLUMNS` and the sweep protects its files; a key column
that is missing from the list is the one way this module can delete a live file, so the test that
walks every model for a ``storage_key`` column fails if one is not listed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.core.storage import StorageBackend
from app.domain.assets.models import DeliveryOrder
from app.domain.cash.models import Attachment
from app.domain.chat.models import ChatAttachment, ChatMeetingFile
from app.domain.events.models import EventMedia
from app.domain.workspace.models import TaskAttachment

DAY = 24 * 60 * 60

#: Every column that holds a storage key. The sweep keeps every file any of them names.
KEY_COLUMNS: tuple[InstrumentedAttribute[str] | InstrumentedAttribute[str | None], ...] = (
    Attachment.storage_key,
    ChatAttachment.storage_key,
    ChatMeetingFile.storage_key,
    TaskAttachment.storage_key,
    EventMedia.storage_key,
    DeliveryOrder.signature_key,
)

#: An unfinished upload this old is a leftover from a crash, not an upload in progress.
STALE_TEMP_SECONDS = DAY


@dataclass(slots=True)
class SweepReport:
    dry_run: bool
    grace_days: int
    scanned: int = 0
    referenced: int = 0
    #: Unreferenced and older than the grace period: what a live sweep removes.
    orphans: int = 0
    orphan_bytes: int = 0
    #: Unreferenced but too new to take.
    too_new: int = 0
    #: Referenced again between the mark and the delete; kept.
    rescued: int = 0
    deleted: int = 0
    freed_bytes: int = 0
    temp_removed: int = 0
    dirs_removed: int = 0
    #: A few of the orphans, so a dry run can be checked against the disk. Keys are content hashes.
    sample: list[str] = field(default_factory=list)

    def detail(self) -> dict[str, object]:
        return {
            "dry_run": self.dry_run,
            "grace_days": self.grace_days,
            "scanned": self.scanned,
            "referenced": self.referenced,
            "orphans": self.orphans,
            "orphan_bytes": self.orphan_bytes,
            "too_new": self.too_new,
            "rescued": self.rescued,
            "deleted": self.deleted,
            "freed_bytes": self.freed_bytes,
            "temp_removed": self.temp_removed,
            "dirs_removed": self.dirs_removed,
            "sample": self.sample,
        }


async def referenced_keys(session: AsyncSession) -> set[str]:
    """Every storage key any table refers to (the mark)."""
    keys: set[str] = set()
    for column in KEY_COLUMNS:
        found = await session.execute(select(column).where(column.is_not(None)).distinct())
        keys.update(k for (k,) in found.all() if k)
    return keys


async def _is_referenced(session: AsyncSession, key: str) -> bool:
    for column in KEY_COLUMNS:
        hit = await session.execute(select(column).where(column == key).limit(1))
        if hit.first() is not None:
            return True
    return False


async def sweep(
    session: AsyncSession,
    storage: StorageBackend,
    *,
    delete: bool,
    grace_days: int,
    now: float | None = None,
) -> SweepReport:
    """Mark, then sweep. With ``delete`` false nothing is removed; the report says what would be."""
    clock = time.time() if now is None else now
    cutoff = clock - grace_days * DAY
    report = SweepReport(dry_run=not delete, grace_days=grace_days)

    live = await referenced_keys(session)
    report.referenced = len(live)

    candidates = []
    for file in storage.iter_files():
        report.scanned += 1
        if file.storage_key in live:
            continue
        if file.modified > cutoff:
            report.too_new += 1
            continue
        candidates.append(file)
        report.orphans += 1
        report.orphan_bytes += file.byte_size
        if len(report.sample) < 10:
            report.sample.append(file.storage_key)

    if delete:
        for file in candidates:
            # A row may have started to refer to it since the mark.
            if await _is_referenced(session, file.storage_key):
                report.rescued += 1
                report.orphans -= 1
                report.orphan_bytes -= file.byte_size
                continue
            storage.delete(file.storage_key)
            report.deleted += 1
            report.freed_bytes += file.byte_size
        report.temp_removed = storage.remove_stale_temp(older_than_seconds=STALE_TEMP_SECONDS)
        report.dirs_removed = storage.prune_empty_dirs()
    return report
