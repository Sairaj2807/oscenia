"""Demo data — the prototype's opening position, as real rows.

Run it::

    python -m app.seed.demo --as-of 2026-07-26

**Scope.** This reproduces the *opening position* and the master data behind it: the FY2026
opening balances entry, clients, vendors, crew, warehouse stock and the fixed-asset register.
It does not replay the prototype's fifty-odd transactions — those are the demo's *history*,
not its opening position, and every one of them is reachable through the API the flow tests
already exercise.

**Idempotent, and converging rather than merely skipping.** Running it twice does not
duplicate a row, and running it against a partly-seeded database fills in what is missing
instead of noticing one row and returning early. That distinction cost a bug in phase 2.

**One thing it does not fix.** The prototype's opening balance for 1301 Inventory —
Consumables is 28,200,000, but the consumable stock it ships adds up to 22,068,000. The
warehouse and the ledger are 6,132,000 apart *in the client's own seed data*, and its comment
claims the tie only for fixed assets ("Fixed-asset value totals 640,000,000 = ledger account
1302"), which does tie exactly. Rather than quietly change a client-reviewed figure or
quietly ship a broken reconciliation, this seed loads the numbers as given and **reports the
gap** at the end of the run. See Q16 in the open questions.
"""

from __future__ import annotations

import argparse
import asyncio
from dataclasses import dataclass
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.money import ZERO, money
from app.db.session import get_sessionmaker
from app.domain.ap.models import Vendor
from app.domain.ar.models import Client
from app.domain.assets.models import (
    Crew,
    FixedAsset,
    InventoryItem,
    InventoryStatus,
    InventoryType,
    Method,
)
from app.domain.assets.service import capitalise
from app.domain.ledger.models import JournalEntry, SourceKind
from app.domain.ledger.numbering import next_document_no
from app.domain.ledger.posting import LineIn, SourceIn, post_entry
from app.domain.masters.models import Role, User
from app.seed.chart import seed_all as seed_reference

D = Decimal

#: The opening balances, verbatim from `seed.js` JE-0001.
OPENING: list[tuple[str, Decimal, Decimal, str]] = [
    ("1101", D("420000000"), ZERO, "Bank opening balance"),
    ("1103", D("40000000"), ZERO, "Petty cash float"),
    ("1301", D("28200000"), ZERO, "Consumables on hand"),
    ("1302", D("640000000"), ZERO, "Event equipment at cost"),
    ("3102", ZERO, D("200000000"), "Paid-in capital"),
    ("3101", ZERO, D("928200000"), "Retained earnings brought forward"),
]

CLIENTS: list[dict[str, object]] = [
    {
        "name": "Aurora Bank",
        "contact": "Ibu Ratna",
        "email": "ratna@aurorabank.co.id",
        "phone": "+62 812-1100-2200",
        "birthday": "28 Jul",
        "anniversary": "01 Mar 2019",
        "personal_brand": "Premium · understated · gold-accented",
        "fav_vendor": "Lumina LED",
        "satisfaction": D("4.8"),
    },
    {
        "name": "TechNusa",
        "contact": "Pak Aditya",
        "email": "aditya@technusa.io",
        "phone": "+62 811-3040-5060",
        "birthday": "02 Aug",
        "anniversary": "09 Nov 2021",
        "personal_brand": "Bold · energetic · developer-first",
        "fav_vendor": "SoundForge",
        "satisfaction": D("4.5"),
    },
    {
        "name": "Meridian Cosmetics",
        "contact": "Ibu Clara",
        "email": "clara@meridian.com",
        "phone": "+62 813-7788-9900",
        "birthday": "15 Dec",
        "anniversary": "20 May 2020",
        "personal_brand": "Elegant · feminine · rose-gold",
        "fav_vendor": "StageWorks",
        "satisfaction": D("4.2"),
    },
    {
        "name": "Keluarga Wibowo",
        "contact": "Bpk. Wibowo",
        "email": "wibowo.family@gmail.com",
        "phone": "+62 815-2233-4455",
        "birthday": "30 Jul",
        # '—' in the prototype: not recorded, which the milestone scan treats differently
        # from a date it cannot parse.
        "anniversary": None,
        "personal_brand": "Warm · traditional · intimate",
        "fav_vendor": "Bloom & Co",
        "satisfaction": D("5.0"),
    },
]

VENDORS: list[dict[str, object]] = [
    {
        "name": "Lumina LED",
        "category": "LED / Visual",
        "baseline_price": D("45000000"),
        "score": D("4.7"),
        "npwp": "01.324.556.7-051.000",
        "pph23_rate": D("2"),
        "bank_name": "Bank Mandiri",
        "bank_account": "123-000-4567-890",
        "bank_holder": "PT Lumina Visual Nusantara",
        "pic_name": "Pak Hendra",
        "pic_phone": "+62 811-2000-3001",
        "pic_email": "hendra@luminaled.co.id",
    },
    {
        "name": "SoundForge",
        "category": "Audio",
        "baseline_price": D("38000000"),
        "score": D("4.4"),
        # Deliberately not 2%: a vendor-specific rate that overrides the company default,
        # and paying them at the default misstates both the cost and account 2105.
        "pph23_rate": D("1.5"),
    },
    {
        "name": "StageWorks",
        "category": "Staging",
        "baseline_price": D("52000000"),
        "score": D("4.1"),
    },
    {
        "name": "Bloom & Co",
        "category": "Decor / Floral",
        "baseline_price": D("29000000"),
        "score": D("4.9"),
    },
]

CREW: list[tuple[str, str, Decimal, Decimal]] = [
    ("Agus P.", "Field Lead", D("5000000"), D("9.2")),
    ("Rina M.", "Stage Manager", D("4500000"), D("8.6")),
    ("Yoga K.", "Rigging Tech", D("4000000"), D("7.8")),
    ("Sela D.", "Lighting Op", D("4200000"), D("9.6")),
]

#: item, type, qty, unit, unit value, status
STOCK: list[tuple[str, InventoryType, Decimal, str, Decimal, InventoryStatus]] = [
    (
        "Duct Tape (roll)",
        InventoryType.CONSUMABLE,
        D("240"),
        "pcs",
        D("35000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Cable Ties (pack)",
        InventoryType.CONSUMABLE,
        D("180"),
        "pack",
        D("45000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Microphone Batteries",
        InventoryType.CONSUMABLE,
        D("96"),
        "pcs",
        D("58000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "VIP Sofa (gold)",
        InventoryType.FIXED_ASSET,
        D("12"),
        "unit",
        D("8000000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Truss 3m Segment",
        InventoryType.FIXED_ASSET,
        D("40"),
        "unit",
        D("2600000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Moving Head Light",
        InventoryType.FIXED_ASSET,
        D("24"),
        "unit",
        D("6500000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "LED Panel 500x500",
        InventoryType.FIXED_ASSET,
        D("36"),
        "unit",
        D("4400000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Line Array Speaker",
        InventoryType.FIXED_ASSET,
        D("16"),
        "unit",
        D("4100000"),
        InventoryStatus.IN_STOCK,
    ),
    (
        "Stage Deck 2x1m",
        InventoryType.FIXED_ASSET,
        D("60"),
        "unit",
        D("1000000"),
        InventoryStatus.IN_STOCK,
    ),
]

#: name, category, stock item, cost, salvage, life months, method
ASSETS: list[tuple[str, str, str, Decimal, Decimal, int, Method]] = [
    (
        "VIP Sofa (gold)",
        "Furniture",
        "VIP Sofa (gold)",
        D("96000000"),
        D("9600000"),
        60,
        Method.STRAIGHT_LINE,
    ),
    (
        "Truss 3m Segment",
        "Staging",
        "Truss 3m Segment",
        D("104000000"),
        D("10400000"),
        96,
        Method.STRAIGHT_LINE,
    ),
    (
        "Moving Head Light",
        "Lighting",
        "Moving Head Light",
        D("156000000"),
        D("15600000"),
        48,
        Method.DECLINING,
    ),
    (
        "LED Panel 500x500",
        "Video",
        "LED Panel 500x500",
        D("158400000"),
        D("15840000"),
        48,
        Method.STRAIGHT_LINE,
    ),
    (
        "Line Array Speaker",
        "Audio",
        "Line Array Speaker",
        D("65600000"),
        D("6560000"),
        60,
        Method.STRAIGHT_LINE,
    ),
    (
        "Stage Deck 2x1m",
        "Staging",
        "Stage Deck 2x1m",
        D("60000000"),
        D("6000000"),
        120,
        Method.STRAIGHT_LINE,
    ),
]


@dataclass
class SeedReport:
    clients: int = 0
    vendors: int = 0
    crew: int = 0
    stock: int = 0
    assets: int = 0
    opening_posted: bool = False
    #: The prototype's demo events (``app.seed.events``).
    events: int = 0
    guests: int = 0

    #: The reconciliation the prototype's own data does not satisfy — reported, not corrected.
    ledger_consumables: Decimal = ZERO
    stock_consumables: Decimal = ZERO
    ledger_equipment: Decimal = ZERO
    stock_equipment: Decimal = ZERO

    @property
    def consumables_gap(self) -> Decimal:
        return self.ledger_consumables - self.stock_consumables

    @property
    def equipment_gap(self) -> Decimal:
        return self.ledger_equipment - self.stock_equipment


async def seed_demo(session: AsyncSession, *, as_of: date) -> SeedReport:
    """Load the opening position. Safe to run repeatedly."""
    report = SeedReport()
    await seed_reference(session)

    user = (
        (await session.execute(select(User).where(User.role == Role.CEO).order_by(User.email)))
        .scalars()
        .first()
    )
    if user is None:
        raise RuntimeError("Reference data is missing its users. Run app.seed.chart first.")

    # --- clients ---------------------------------------------------------
    for fields in CLIENTS:
        name = str(fields["name"])
        if (
            await session.execute(select(Client.id).where(Client.name == name))
        ).first() is not None:
            continue
        session.add(Client(client_no=await next_document_no(session, "client"), **fields))
        report.clients += 1

    # --- vendors ---------------------------------------------------------
    for fields in VENDORS:
        name = str(fields["name"])
        if (
            await session.execute(select(Vendor.id).where(Vendor.name == name))
        ).first() is not None:
            continue
        session.add(Vendor(vendor_no=await next_document_no(session, "vendor"), **fields))
        report.vendors += 1

    # --- crew ------------------------------------------------------------
    for name, role, rate, rating in CREW:
        if (await session.execute(select(Crew.id).where(Crew.name == name))).first() is not None:
            continue
        session.add(
            Crew(
                crew_no=await next_document_no(session, "crew"),
                name=name,
                role=role,
                base_rate=rate,
                last_rating=rating,
            )
        )
        report.crew += 1

    await session.flush()

    # --- warehouse -------------------------------------------------------
    items: dict[str, InventoryItem] = {}
    for label, kind, qty, unit, unit_value, status in STOCK:
        found = (
            (await session.execute(select(InventoryItem).where(InventoryItem.item == label)))
            .scalars()
            .first()
        )
        if found is None:
            found = InventoryItem(
                item_no=await next_document_no(session, "inventory"),
                item=label,
                type=kind,
                qty=qty,
                unit=unit,
                unit_value=unit_value,
                status=status,
            )
            session.add(found)
            report.stock += 1
        items[label] = found
    await session.flush()

    # --- fixed-asset register -------------------------------------------
    #
    # `post=False` throughout: every one of these is already inside the opening 1302 balance
    # above. Capitalising them again would double-count 640,000,000, which is exactly what
    # the flag exists to prevent.
    for name, category, item_label, cost, salvage, life, method in ASSETS:
        if (
            await session.execute(select(FixedAsset.id).where(FixedAsset.name == name))
        ).first() is not None:
            continue
        # Through the service, not by constructing the row: the seed must obey the same
        # validation and use the same numbering as the API, or the two drift and only the
        # seed's copy gets it wrong.
        await capitalise(
            session,
            name=name,
            acquired_on=date(2026, 1, 1),
            cost=cost,
            useful_life_months=life,
            user=user,
            salvage=salvage,
            method=method,
            category=category,
            inventory_item_id=items[item_label].id,
            post=False,
        )
        report.assets += 1
    await session.flush()

    # --- the opening entry ----------------------------------------------
    already = (
        await session.execute(
            select(JournalEntry.id).where(
                JournalEntry.source_kind == SourceKind.OPENING,
                JournalEntry.source_ref == "FY2026",
            )
        )
    ).first()
    if already is None:
        await post_entry(
            session,
            entry_date=date(2026, 1, 1),
            memo="Opening balances — FY2026",
            lines=[
                LineIn(code, debit=debit, credit=credit, note=note)
                for code, debit, credit, note in OPENING
            ],
            source=SourceIn(kind=SourceKind.OPENING, ref="FY2026"),
            posted_by_id=user.id,
        )
        report.opening_posted = True

    # --- the reconciliation ----------------------------------------------
    from app.domain.reports.queries import account_balance

    report.ledger_consumables = await account_balance(session, "1301")
    report.ledger_equipment = await account_balance(session, "1302")
    for item in items.values():
        value = money(money(item.qty) * money(item.unit_value))
        if item.type is InventoryType.CONSUMABLE:
            report.stock_consumables += value
        else:
            report.stock_equipment += value

    # --- events (after clients, which they are matched to by name) --------
    from app.seed.events import seed_events

    stamp = datetime.combine(as_of, time(9, 0), tzinfo=ZoneInfo(get_settings().timezone))
    seeded = await seed_events(session, created_by=user, now=stamp)
    report.events, report.guests = seeded.events, seeded.guests

    return report


def _render(report: SeedReport, *, as_of: date) -> str:
    lines = [
        f"Seeded the FY2026 opening position (as of {as_of}).",
        f"  clients {report.clients}  vendors {report.vendors}  crew {report.crew}"
        f"  stock {report.stock}  assets {report.assets}",
        f"  opening entry: {'posted' if report.opening_posted else 'already present'}",
        f"  events {report.events}  event guests {report.guests}",
        "",
        "Reconciliation — warehouse against the ledger:",
        f"  1302 Fixed Assets  ledger {report.ledger_equipment:>16,}"
        f"   stock {report.stock_equipment:>16,}"
        f"   {'ties' if report.equipment_gap == ZERO else f'GAP {report.equipment_gap:,}'}",
        f"  1301 Consumables   ledger {report.ledger_consumables:>16,}"
        f"   stock {report.stock_consumables:>16,}"
        f"   {'ties' if report.consumables_gap == ZERO else f'GAP {report.consumables_gap:,}'}",
    ]
    if report.consumables_gap != ZERO:
        lines += [
            "",
            f"  The {report.consumables_gap:,} gap on 1301 is inherited from the prototype's own",
            "  seed data, not introduced here. Its comment claims the tie for fixed assets only,",
            "  and 1302 does tie exactly. Parked as Q16 rather than silently corrected: changing",
            "  a client-reviewed opening balance is the client's call, not ours.",
        ]
    return "\n".join(lines)


async def _main(as_of: date) -> None:
    from app.core.config import get_settings

    if get_settings().env == "production":
        # Demo balances posted into real books would have to be reversed entry by entry.
        raise SystemExit("Refusing to load demo data with ENV=production.")

    async with get_sessionmaker()() as session, session.begin():
        report = await seed_demo(session, as_of=as_of)
    print(_render(report, as_of=as_of))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Load the demo opening position.")
    parser.add_argument(
        "--as-of",
        type=date.fromisoformat,
        default=date(2026, 7, 26),
        help="The demo's 'today'. Defaults to the prototype's DEMO_TODAY.",
    )
    asyncio.run(_main(parser.parse_args().as_of))
