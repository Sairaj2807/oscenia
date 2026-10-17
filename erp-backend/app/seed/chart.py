"""Seed the chart of accounts, voucher series, document sequences and demo users.

Idempotent: safe to run against an existing database. Run with::

    python -m app.seed.chart

Everything here is transcribed from the prototype, which the client's finance team has
reviewed across two rounds. Codes and account types are not ours to improvise.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password
from app.db.session import dispose_engine, get_sessionmaker
from app.domain.accounts.models import Account, AccountType
from app.domain.ap.models import Tag
from app.domain.ar.models import MouClause, MouTemplate
from app.domain.ledger.models import DocumentSequence, ResetCadence, VoucherSeries
from app.domain.masters.models import Role, TaxConfig, User

# ---------------------------------------------------------------------------
# The 27 seed accounts — src/lib/accounts.js SEED_ACCOUNTS
# (code, name, type, group_label, is_cash, is_contra, tax_key)
# ---------------------------------------------------------------------------

T = AccountType

SEED_ACCOUNTS: list[tuple[str, str, AccountType, str, bool, bool, str | None]] = [
    ("1101", "Main Bank Cash", T.ASSET, "Cash & Bank", True, False, None),
    ("1102", "Cash on Hand", T.ASSET, "Cash & Bank", True, False, None),
    ("1103", "Petty Cash", T.ASSET, "Cash & Bank", True, False, None),
    ("1201", "Accounts Receivable", T.ASSET, "Receivables", False, False, None),
    ("1301", "Inventory — Consumables", T.ASSET, "Inventory & Equipment", False, False, None),
    ("1302", "Inventory — Fixed Assets", T.ASSET, "Inventory & Equipment", False, False, None),
    ("1303", "Accumulated Depreciation", T.ASSET, "Inventory & Equipment", False, True, None),
    ("1401", "Prepaid Tax — PPh 23", T.ASSET, "Prepaid Taxes", False, False, "pph23"),
    ("2101", "Unearned Revenue", T.LIABILITY, "Payables & Accruals", False, False, None),
    ("2102", "Vendor Payables", T.LIABILITY, "Payables & Accruals", False, False, None),
    ("2103", "Crew Payables", T.LIABILITY, "Payables & Accruals", False, False, None),
    ("2105", "PPh 23 Payable", T.LIABILITY, "Tax Payables", False, False, "pph23"),
    ("2106", "PPN Payable", T.LIABILITY, "Tax Payables", False, False, "ppn"),
    ("2107", "PPh 21 Payable", T.LIABILITY, "Tax Payables", False, False, "pph21"),
    ("3101", "Retained Earnings", T.EQUITY, "Equity", False, False, None),
    ("3102", "Paid-in Capital", T.EQUITY, "Equity", False, False, None),
    ("4101", "Event Revenue DP", T.REVENUE, "Event Revenue", False, False, None),
    ("4102", "Event Revenue", T.REVENUE, "Event Revenue", False, False, None),
    ("5101", "Event COGS — Vendors", T.COGS, "Direct Event Costs", False, False, None),
    ("5102", "Event COGS — Crew", T.COGS, "Direct Event Costs", False, False, None),
    ("5103", "Event COGS — Logistics", T.COGS, "Direct Event Costs", False, False, None),
    ("5104", "Event COGS — Consumables", T.COGS, "Direct Event Costs", False, False, None),
    ("6101", "Office Overhead", T.OPEX, "Overheads", False, False, None),
    ("6102", "Salaries (non-event)", T.OPEX, "Overheads", False, False, None),
    ("6103", "Depreciation Expense", T.OPEX, "Depreciation", False, False, None),
    ("6901", "Asset Loss Expense", T.OPEX, "Asset Losses", False, False, None),
    ("7101", "Tax Expense", T.TAX, "Tax", False, False, None),
]

#: Control accounts, named once so nothing downstream hardcodes a string literal.
AR_CONTROL = "1201"
AP_CONTROL = "2102"
PREPAID_PPH23 = "1401"
PPH23_PAYABLE = "2105"


# ---------------------------------------------------------------------------
# Voucher series — src/lib/vouchers.js SEED_VOUCHER_SERIES
# ---------------------------------------------------------------------------

STANDARD = "[PREFIX]-[MONTH]-[DATE]-[SEQ_001]"
SPACED = "[PREFIX] - [MONTH] - [DATE] - [SEQ_001]"

SEED_SERIES: list[tuple[str, str, str, str, str, ResetCadence]] = [
    ("km", "KM", "Cash In (Kas Masuk)",
     "Client receipts, refunds in, petty cash returns", STANDARD, ResetCadence.MONTHLY),
    ("kk", "KK", "Cash Out (Kas Keluar)",
     "Vendor payments, disbursements, payroll", STANDARD, ResetCadence.MONTHLY),
    ("rm", "RM", "Reimbursement",
     "Cash-advance settlement and expense claims", STANDARD, ResetCadence.MONTHLY),
    ("fa", "FA", "Fixed Asset",
     "Acquisition, depreciation and write-off",
     "FIXED ASSET (FA) - [MONTH] - [DATE] - [SEQ_001]", ResetCadence.MONTHLY),
    ("rev", "REVENUE", "Revenue (accrual)",
     "Invoices raised — receivable recognised, no cash yet", SPACED, ResetCadence.MONTHLY),
    ("exp", "EXPENSE", "Expense (accrual)",
     "Bills received — payable raised, no cash yet", SPACED, ResetCadence.MONTHLY),
    ("jv", "JV", "Adjustment Voucher",
     "Manual entries, reversals, corrections and opening balances",
     STANDARD, ResetCadence.MONTHLY),
]


# ---------------------------------------------------------------------------
# Document sequences — replacing the prototype's count-based ids
# ---------------------------------------------------------------------------

SEED_SEQUENCES: list[tuple[str, str, int, int]] = [
    # key, prefix, pad, starting value
    ("journal_entry", "JE", 4, 1001),
    ("invoice", "INV", 4, 45),
    ("purchase_order", "PO", 4, 3001),
    ("procurement", "PR", 3, 106),
    ("fixed_asset", "FA", 3, 7),
    ("quotation", "QT", 4, 1002),
    ("project", "EVT", 4, 1),
    ("client", "CL", 2, 5),
    ("vendor", "V", 2, 6),
    ("catalogue", "VI", 2, 1),
    ("inventory", "IT", 2, 1),
    ("crew", "CR", 2, 1),
    ("event", "EV", 2, 1),
    ("studio_template", "studio", 1, 1),
]


# ---------------------------------------------------------------------------
# Demo users — one per role, names from src/lib/roles.js ROLES
# ---------------------------------------------------------------------------

SEED_USERS: list[tuple[str, str, str, Role]] = [
    ("rahmat@oscenia.co.id", "R. Hartono", "RH", Role.CEO),
    ("lina@oscenia.co.id", "Lina W.", "LW", Role.FINANCE),
    ("agus@oscenia.co.id", "Agus P.", "AP", Role.PM),
    ("dinda@oscenia.co.id", "Dinda A.", "DA", Role.SALES),
    ("bagus@oscenia.co.id", "Bagus S.", "BS", Role.WAREHOUSE),
]

# ---------------------------------------------------------------------------
# Tax configuration - seedTaxConfig in the prototype
# (key, label, rate %, active, account)
# ---------------------------------------------------------------------------

SEED_TAX: list[tuple[str, str, str, bool, str | None]] = [
    ("pph23", "PPh 23 - Service withholding", "2", True, "2105"),
    ("pph21", "PPh 21 - Employee withholding", "5", False, "2107"),
    ("ppn", "PPN - Value Added Tax", "11", False, "2106"),
    # No account: corporate income tax is computed on the income statement, never posted.
    ("corporate", "Corporate Income Tax", "22", True, None),
]


#: Used as ``posted_by`` for opening balances and anything the system posts on its own.
SYSTEM_USER_EMAIL = "system@oscenia.co.id"

#: Development password for every seeded demo user.
#:
#: This is a demo credential and is safe to publish precisely because it is useless
#: anywhere real: `Settings` refuses to start with the default JWT secret when
#: ENV=production, and `seed_users` creates no demo user there. Do not reuse it.
DEMO_PASSWORD = "oscenia-demo-2026"


async def seed_accounts(session: AsyncSession) -> int:
    existing = set(
        (await session.execute(select(Account.code))).scalars().all()
    )
    added = 0
    for code, name, type_, group, is_cash, is_contra, tax_key in SEED_ACCOUNTS:
        if code in existing:
            continue
        session.add(
            Account(
                code=code,
                name=name,
                type=type_,
                group_label=group,
                is_cash=is_cash,
                is_contra=is_contra,
                tax_key=tax_key,
            )
        )
        added += 1
    await session.flush()
    return added


async def seed_series(session: AsyncSession) -> int:
    existing = set((await session.execute(select(VoucherSeries.key))).scalars().all())
    added = 0
    for key, prefix, label, hint, fmt, reset in SEED_SERIES:
        if key in existing:
            continue
        session.add(
            VoucherSeries(
                key=key, prefix=prefix, label=label, hint=hint, format=fmt, reset=reset
            )
        )
        added += 1
    await session.flush()
    return added


async def seed_sequences(session: AsyncSession) -> int:
    existing = set((await session.execute(select(DocumentSequence.key))).scalars().all())
    added = 0
    for key, prefix, pad, start in SEED_SEQUENCES:
        if key in existing:
            continue
        session.add(DocumentSequence(key=key, prefix=prefix, pad=pad, next_value=start))
        added += 1
    await session.flush()
    return added


async def seed_users(session: AsyncSession, *, include_demo: bool | None = None) -> int:
    """Create the demo users, and backfill a password for any that predate phase 2.

    **Never in production.** ``include_demo`` defaults to "not production", so the reference
    seed run on a live server creates only the system user, and the demo password can sign
    nobody in. Real people are added with ``python -m app.seed.users``.

    Idempotent by *convergence*, not merely by existence. Seeding only ever creating rows
    means an existing database silently misses anything added later — which is exactly what
    happened when passwords landed: the users were already there, so they kept a NULL hash
    and nobody could log in.

    A password is only ever written when the column is NULL, so this can never clobber a
    real one.
    """
    rows = (await session.execute(select(User))).scalars().all()
    by_email = {u.email: u for u in rows}
    existing = set(by_email)
    added = 0

    if SYSTEM_USER_EMAIL not in existing:
        session.add(
            User(
                email=SYSTEM_USER_EMAIL,
                full_name="System",
                initials="SY",
                role=Role.FINANCE,
                # Not a login. No password hash and inactive, so verify_password()
                # cannot succeed against it by any route.
                active=False,
            )
        )
        added += 1

    if include_demo is None:
        include_demo = get_settings().env != "production"

    for email, name, initials, role in SEED_USERS if include_demo else []:
        if email in existing:
            user = by_email[email]
            if user.password_hash is None:
                user.password_hash = hash_password(DEMO_PASSWORD)
            continue
        session.add(
            User(
                email=email,
                full_name=name,
                initials=initials,
                role=role,
                password_hash=hash_password(DEMO_PASSWORD),
            )
        )
        added += 1

    await session.flush()
    return added


async def seed_tax(session: AsyncSession) -> int:
    existing = set((await session.execute(select(TaxConfig.key))).scalars().all())
    added = 0
    for key, label, rate, active, account in SEED_TAX:
        if key in existing:
            continue
        session.add(
            TaxConfig(
                key=key,
                label=label,
                rate=Decimal(rate),
                active=active,
                account_code=account,
            )
        )
        added += 1
    await session.flush()
    return added


SEED_TEMPLATES: list[tuple[str, str, str, str, str, bool, list[str]]] = [
    (
        "corporate", "Corporate", "MEMORANDUM OF UNDERSTANDING",
        "Valid for 30 days from the date of issue", "Director, Oscenia Events", True,
        [
            "Oscenia Events will deliver the scope of work set out in the attached quotation.",
            "The down payment schedule attached forms part of this agreement.",
            "Vendor and venue bookings are confirmed only once the down payment is received.",
            "Changes to scope after signing may alter the contract value.",
        ],
    ),
    (
        "wedding", "Wedding", "WEDDING SERVICE AGREEMENT",
        "Valid for 14 days from the date of issue", "Director, Oscenia Events", False,
        [
            "Oscenia Events will deliver the wedding services set out in the attached quotation.",
            "A site visit will be scheduled no later than 30 days before the event.",
            "The down payment schedule attached forms part of this agreement.",
        ],
    ),
    (
        "government", "Government / Institutional", "SURAT PERJANJIAN KERJA SAMA",
        "Valid for 45 days from the date of issue", "Director, Oscenia Events", False,
        [
            "Oscenia Events will deliver the scope of work set out in the attached quotation.",
            "Withholding tax (PPh 23) will be applied in accordance with prevailing regulation.",
            "Payment terms follow the attached down payment schedule.",
            "Both parties agree to settle disputes by deliberation before any other remedy.",
        ],
    ),
]


async def seed_templates(session: AsyncSession) -> int:
    existing = set((await session.execute(select(MouTemplate.id))).scalars().all())
    added = 0
    for key, label, heading, validity, signatory, default, clauses in SEED_TEMPLATES:
        if key in existing:
            continue
        template = MouTemplate(
            id=key,
            label=label,
            heading=heading,
            validity=validity,
            signatory=signatory,
            is_default=default,
        )
        template.clauses = [
            MouClause(clause_no=i, text=text) for i, text in enumerate(clauses, start=1)
        ]
        session.add(template)
        added += 1
    await session.flush()
    return added


#: The starting tag vocabulary - seedTags in the prototype.
SEED_TAGS: list[tuple[str, str]] = [
    ("corporate-gala", "Corporate Gala"),
    ("conference", "Conference"),
    ("product-launch", "Product Launch"),
    ("wedding", "Wedding"),
    ("investor-summit", "Investor Summit"),
    ("outdoor-capable", "Outdoor Capable"),
    ("preferred-supplier", "Preferred Supplier"),
    ("rush-friendly", "Rush Friendly"),
]


async def seed_tags(session: AsyncSession) -> int:
    existing = set((await session.execute(select(Tag.id))).scalars().all())
    added = 0
    for key, label in SEED_TAGS:
        if key in existing:
            continue
        session.add(Tag(id=key, label=label))
        added += 1
    await session.flush()
    return added


async def seed_all(session: AsyncSession) -> dict[str, int]:
    return {
        "accounts": await seed_accounts(session),
        "voucher_series": await seed_series(session),
        "document_sequences": await seed_sequences(session),
        "users": await seed_users(session),
        "tax_config": await seed_tax(session),
        "mou_templates": await seed_templates(session),
        "tags": await seed_tags(session),
    }


async def _main() -> None:
    async with get_sessionmaker()() as session:
        result = await seed_all(session)
        await session.commit()
    await dispose_engine()

    for name, count in result.items():
        print(f"  {name:<20} {count:>3} added")
    print("Seed complete.")


if __name__ == "__main__":
    asyncio.run(_main())
