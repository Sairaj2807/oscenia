"""Phase 8 — the demo seed.

The build plan's acceptance criterion for this phase is that ``python -m app.seed.demo``
reproduces the prototype's opening position and the suite passes against it. These are the
assertions behind that sentence.

The one that matters most is the last: the seed does **not** quietly correct the 6,132,000
discrepancy in the client's own opening data. It reports it.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.money import ZERO
from app.domain.ap.models import Vendor
from app.domain.ar.models import Client
from app.domain.assets.models import Crew, FixedAsset, InventoryItem, InventoryType
from app.domain.ledger.models import JournalEntry, JournalLine, SourceKind
from app.domain.reports.queries import account_balance
from app.seed.demo import ASSETS, CLIENTS, CREW, STOCK, VENDORS, seed_demo

pytestmark = pytest.mark.phase8

D = Decimal
AS_OF = date(2026, 7, 26)


async def test_the_seed_loads_the_opening_position(db: AsyncSession) -> None:
    report = await seed_demo(db, as_of=AS_OF)

    assert report.clients == len(CLIENTS)
    assert report.vendors == len(VENDORS)
    assert report.crew == len(CREW)
    assert report.stock == len(STOCK)
    assert report.assets == len(ASSETS)
    assert report.opening_posted is True


async def test_the_opening_entry_balances(db: AsyncSession) -> None:
    await seed_demo(db, as_of=AS_OF)

    entry = (
        await db.execute(
            select(JournalEntry).where(
                JournalEntry.source_kind == SourceKind.OPENING,
                JournalEntry.source_ref == "FY2026",
            )
        )
    ).scalar_one()

    totals = (
        await db.execute(
            select(func.sum(JournalLine.debit), func.sum(JournalLine.credit)).where(
                JournalLine.entry_id == entry.id
            )
        )
    ).one()
    assert totals[0] == totals[1] == D("1128200000")
    assert entry.series == "jv" or entry.series, "it carries a voucher series like any entry"


async def test_seeding_twice_changes_nothing(db: AsyncSession) -> None:
    await seed_demo(db, as_of=AS_OF)
    second = await seed_demo(db, as_of=AS_OF)

    assert (second.clients, second.vendors, second.crew, second.stock, second.assets) == (
        0,
        0,
        0,
        0,
        0,
    )
    assert second.opening_posted is False

    entries = (
        await db.execute(
            select(func.count())
            .select_from(JournalEntry)
            .where(JournalEntry.source_kind == SourceKind.OPENING)
        )
    ).scalar_one()
    assert entries == 1, "the opening balances were not posted a second time"


async def test_the_seed_converges_rather_than_merely_skipping(db: AsyncSession) -> None:
    """Filling in what is missing, not noticing one row and returning early.

    Phase 2's seeder was idempotent *by existence*: adding passwords to an already-seeded
    database did nothing at all. This is the assertion that stops that recurring.
    """
    await seed_demo(db, as_of=AS_OF)

    victim = (
        await db.execute(select(Client).where(Client.name == "TechNusa"))
    ).scalar_one()
    await db.delete(victim)
    await db.flush()

    report = await seed_demo(db, as_of=AS_OF)

    assert report.clients == 1, "it noticed the one that was missing"
    total = (await db.execute(select(func.count()).select_from(Client))).scalar_one()
    assert total == len(CLIENTS)


async def test_the_register_ties_to_1302_after_seeding(db: AsyncSession) -> None:
    """The assets are registered with ``post=False`` because 1302 already carries them.

    Capitalising them again would double-count 640,000,000, which is precisely what that
    flag exists to prevent — and this is the assertion that proves it did.
    """
    await seed_demo(db, as_of=AS_OF)

    ledger = await account_balance(db, "1302")
    register = (
        await db.execute(select(func.sum(FixedAsset.cost)))
    ).scalar_one()

    assert ledger == D("640000000")
    assert register == D("640000000")
    assert await account_balance(db, "1303") == ZERO, "and nothing has depreciated yet"


async def test_fixed_asset_stock_ties_to_the_register(db: AsyncSession) -> None:
    """Ledger invariant §7 against the seeded data rather than a synthetic fixture."""
    report = await seed_demo(db, as_of=AS_OF)

    assert report.stock_equipment == D("640000000")
    assert report.ledger_equipment == D("640000000")
    assert report.equipment_gap == ZERO


async def test_the_consumables_discrepancy_is_reported_not_corrected(
    db: AsyncSession,
) -> None:
    """The prototype's opening 1301 is 28,200,000; the stock it ships is 22,068,000.

    Both numbers are the client's. Silently changing either would be re-deciding a reviewed
    figure, and silently shipping the mismatch would put a broken reconciliation in front of
    them without saying so. The seed loads them as given and names the gap.
    """
    report = await seed_demo(db, as_of=AS_OF)

    assert report.ledger_consumables == D("28200000"), "the client's opening balance, as given"
    assert report.stock_consumables == D("22068000"), "and the stock it is supposed to represent"
    assert report.consumables_gap == D("6132000")


async def test_every_asset_is_linked_to_the_stock_it_represents(db: AsyncSession) -> None:
    """Without the link the warehouse write-down cannot find the register to shrink."""
    await seed_demo(db, as_of=AS_OF)

    assets = (await db.execute(select(FixedAsset))).scalars().all()
    assert len(assets) == len(ASSETS)
    assert all(asset.inventory_item_id is not None for asset in assets)

    fixed_stock = (
        await db.execute(
            select(func.count())
            .select_from(InventoryItem)
            .where(InventoryItem.type == InventoryType.FIXED_ASSET)
        )
    ).scalar_one()
    assert fixed_stock == len(ASSETS), "one register entry per line of fixed-asset stock"


async def test_the_seeded_crew_and_vendors_carry_their_real_figures(
    db: AsyncSession,
) -> None:
    await seed_demo(db, as_of=AS_OF)

    agus = (await db.execute(select(Crew).where(Crew.name == "Agus P."))).scalar_one()
    assert agus.base_rate == D("5000000")
    assert agus.last_rating == D("9.2")

    soundforge = (
        await db.execute(select(Vendor).where(Vendor.name == "SoundForge"))
    ).scalar_one()
    assert soundforge.pph23_rate == D("1.5"), (
        "a vendor-specific rate overriding the 2% default — paying them at the default "
        "would misstate both the cost and account 2105"
    )


async def test_a_not_recorded_anniversary_stays_null(db: AsyncSession) -> None:
    """The prototype stores '—'. Null is the honest translation of "nobody wrote one down"."""
    await seed_demo(db, as_of=AS_OF)

    wibowo = (
        await db.execute(select(Client).where(Client.name == "Keluarga Wibowo"))
    ).scalar_one()
    assert wibowo.anniversary is None
    assert wibowo.birthday == "30 Jul"
