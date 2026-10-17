"""Phase 1 — the ledger core.

Ports the slices of the prototype's verification suites that Phase 1 must satisfy:

* ``verify-ledger.mjs`` §1 (every entry balances), §2 (trial balance), §11 (reversal)
* ``verify-flows.mjs`` §42 (chart of accounts), §43 (voucher numbering), §45 (general
  ledger), §44 (inter-document linking)

Plus ``test_triggers``-style assertions that the guarantees survive a client bypassing the
service layer entirely — which is the whole reason they live in Postgres.
"""

from __future__ import annotations

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound, OutOfBalance, PeriodClosed
from app.core.money import ZERO
from app.domain.accounts.models import Account, AccountType, Side
from app.domain.ledger.models import (
    AccountingPeriod,
    JournalEntry,
    PeriodStatus,
    ResetCadence,
    SourceKind,
    VoucherSeries,
)
from app.domain.ledger.numbering import format_voucher, period_key, validate_format
from app.domain.ledger.posting import (
    LineIn,
    SourceIn,
    adjust_entry,
    post_entry,
    reverse_entry,
)
from app.domain.masters.models import User
from app.domain.reports.queries import (
    Period,
    account_balance,
    cash_balance,
    general_ledger,
    linked_entries,
    open_items,
    trial_balance,
)

pytestmark = pytest.mark.phase1

D = Decimal
MAY10 = date(2026, 5, 10)

#: A real seed figure: the Aurora Gala down payment, and PPh 23 at the configured 2%.
DEFAULT_GROSS = Decimal("144000000")
PPH23 = Decimal("0.02")


async def _post(db: AsyncSession, user: User, lines, **kw) -> JournalEntry:
    kw.setdefault("entry_date", MAY10)
    kw.setdefault("memo", "test posting")
    kw.setdefault("source", SourceIn(kind=SourceKind.MANUAL))
    return await post_entry(db, lines=lines, posted_by_id=user.id, **kw)


async def _dp_pair(
    db: AsyncSession, user: User, gross: Decimal = DEFAULT_GROSS, rate: Decimal = PPH23
):
    """The client down-payment shape: recognition gross, then receipt net + prepaid tax.

    This is inherited ruling 5 — money in, the client withholds, so we receive net cash and
    hold a creditable asset in 1401 while revenue is recognised gross.
    """
    tax = (gross * rate).quantize(D("0.01"))
    recognition = await _post(
        db,
        user,
        [LineIn("1201", debit=gross), LineIn("4101", credit=gross)],
        memo="DP recognised — Aurora Gala",
        source=SourceIn(kind=SourceKind.INVOICE, ref="INV-0041"),
    )
    receipt = await post_entry(
        db,
        entry_date=MAY10,
        memo="DP received — Aurora Gala",
        lines=[
            LineIn("1101", debit=gross - tax, note="net cash"),
            LineIn("1401", debit=tax, note="PPh 23 withheld by client"),
            LineIn("1201", credit=gross, note="clears AR at gross"),
        ],
        source=SourceIn(kind=SourceKind.PAYMENT, ref=recognition.entry_no),
        posted_by_id=user.id,
        applied_to=[recognition.id],
    )
    return recognition, receipt, gross, tax


# ---------------------------------------------------------------------------
# Posting
# ---------------------------------------------------------------------------


async def test_posts_a_balanced_entry(db: AsyncSession, user: User) -> None:
    entry = await _post(db, user, [LineIn("1101", debit=D("100")), LineIn("4102", credit=D("100"))])
    assert entry.entry_no.startswith("JE-")
    assert entry.voucher_no
    assert len(entry.lines) == 2


async def test_trial_balance_holds_after_posting(db: AsyncSession, user: User) -> None:
    """verify-ledger §2 — debits equal credits, exactly."""
    await _dp_pair(db, user)
    tb = await trial_balance(db)
    assert tb.balanced, f"out by {tb.difference}"
    assert tb.difference == ZERO


async def test_pph23_direction_money_in(db: AsyncSession, user: User) -> None:
    """verify-ledger §12 — the load-bearing rule, and the one that was backwards in round 1.

    Revenue gross, cash net, withholding an **asset** in 1401. Nothing is credited to 2105
    on a client receipt: that account is for tax *we* withhold from vendors.
    """
    _, receipt, gross, tax = await _dp_pair(db, user)

    assert await account_balance(db, "4101") == gross, "revenue recognised GROSS"
    assert await account_balance(db, "1101") == gross - tax, "cash arrives NET"
    assert await account_balance(db, "1401") == tax, "withholding is an ASSET"
    assert await account_balance(db, "2105") == ZERO, "nothing credited to the payable"
    assert await account_balance(db, "1201") == ZERO, "receivable cleared at GROSS"

    cash = await account_balance(db, "1101")
    prepaid = await account_balance(db, "1401")
    assert cash + prepaid == gross, "cash + prepaid tax == receivable cleared"

    assert receipt.series == "km"


@pytest.mark.parametrize(
    ("lines", "exc"),
    [
        ([LineIn("1101", debit=D("10")), LineIn("4102", credit=D("9"))], OutOfBalance),
        ([LineIn("1101", debit=D("10"))], Invalid),
        (
            [LineIn("1101", debit=D("10"), credit=D("10")), LineIn("4102", credit=D("10"))],
            Invalid,
        ),
        ([LineIn("1101", debit=D("-10")), LineIn("4102", credit=D("-10"))], Invalid),
        ([LineIn("1101", debit=ZERO), LineIn("4102", credit=ZERO)], Invalid),
    ],
    ids=["unbalanced", "single-line", "both-sides", "negative", "empty"],
)
async def test_malformed_entries_are_refused(db: AsyncSession, user: User, lines, exc) -> None:
    with pytest.raises(exc):
        await _post(db, user, lines)


async def test_memo_is_required(db: AsyncSession, user: User) -> None:
    with pytest.raises(Invalid):
        await _post(
            db,
            user,
            [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
            memo="   ",
        )


async def test_unknown_account_is_refused(db: AsyncSession, user: User) -> None:
    with pytest.raises(NotFound):
        await _post(db, user, [LineIn("9999", debit=D("10")), LineIn("4102", credit=D("10"))])


# ---------------------------------------------------------------------------
# §43 — Voucher numbering
# ---------------------------------------------------------------------------


async def test_every_entry_carries_a_unique_voucher_number(db: AsyncSession, user: User) -> None:
    entries = [
        await _post(db, user, [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))])
        for _ in range(5)
    ]
    numbers = [e.voucher_no for e in entries]
    assert all(numbers)
    assert len(set(numbers)) == len(numbers), "voucher numbers must be unique"


async def test_series_auto_classification(db: AsyncSession, user: User) -> None:
    """Receipts land in KM, disbursements in KK, manual entries in JV."""
    cash_in = await _post(
        db,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
        source=SourceIn(kind=SourceKind.PAYMENT),
    )
    cash_out = await _post(
        db,
        user,
        [LineIn("5101", debit=D("10")), LineIn("1101", credit=D("10"))],
        source=SourceIn(kind=SourceKind.PO),
    )
    manual = await _post(
        db,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
        source=SourceIn(kind=SourceKind.MANUAL),
    )
    accrual_rev = await _post(
        db,
        user,
        [LineIn("1201", debit=D("10")), LineIn("4101", credit=D("10"))],
        source=SourceIn(kind=SourceKind.INVOICE),
    )
    accrual_exp = await _post(
        db,
        user,
        [LineIn("5101", debit=D("10")), LineIn("2102", credit=D("10"))],
        source=SourceIn(kind=SourceKind.PO),
    )
    depreciation = await _post(
        db,
        user,
        [LineIn("6103", debit=D("10")), LineIn("1303", credit=D("10"))],
        source=SourceIn(kind=SourceKind.DEPRECIATION, ref="2026-05-x"),
    )

    assert cash_in.series == "km"
    assert cash_out.series == "kk"
    assert manual.series == "jv"
    assert accrual_rev.series == "rev"
    assert accrual_exp.series == "exp"
    assert depreciation.series == "fa"


def test_voucher_format_tokens() -> None:
    """The client's own example must work as written."""
    series = VoucherSeries(
        key="rev",
        prefix="REVENUE",
        label="Revenue",
        format="[PREFIX] - [MONTH] - [DATE] - [SEQ_001]",
        reset=ResetCadence.MONTHLY,
    )
    assert format_voucher(series, date(2026, 8, 14), 1) == "REVENUE - 08 - 14 - 001"

    wide = VoucherSeries(
        key="x",
        prefix="KK",
        label="x",
        format="[PREFIX]/[YY][MON]/[SEQ_00001]",
        reset=ResetCadence.MONTHLY,
    )
    assert format_voucher(wide, date(2026, 8, 14), 42) == "KK/26AUG/00042"


def test_format_without_a_sequence_token_is_refused() -> None:
    validate_format("[PREFIX]-[SEQ_001]")
    with pytest.raises(Invalid):
        validate_format("[PREFIX]-[MONTH]-[DATE]")


@pytest.mark.parametrize(
    ("cadence", "expected"),
    [
        (ResetCadence.MONTHLY, "2026-08"),
        (ResetCadence.YEARLY, "2026"),
        (ResetCadence.DAILY, "2026-08-14"),
        (ResetCadence.NEVER, "all"),
    ],
)
def test_counter_period_keys(cadence: ResetCadence, expected: str) -> None:
    assert period_key(cadence, date(2026, 8, 14)) == expected


# ---------------------------------------------------------------------------
# §11 — Reversal, and §7 — adjustment
# ---------------------------------------------------------------------------


async def test_reversal_cancels_the_entry_out(db: AsyncSession, user: User) -> None:
    """verify-ledger §11 — reversing returns every account to where it started."""
    _, receipt, gross, tax = await _dp_pair(db, user)

    cash_before = await account_balance(db, "1101")
    prepaid_before = await account_balance(db, "1401")

    await reverse_entry(db, entry_id=receipt.id, posted_by_id=user.id)

    assert await account_balance(db, "1101") == cash_before - (gross - tax)
    assert await account_balance(db, "1401") == prepaid_before - tax
    assert await account_balance(db, "1201") == gross, "the receivable reopens at GROSS"

    tb = await trial_balance(db)
    assert tb.balanced


async def test_reversal_gets_its_own_voucher_number(db: AsyncSession, user: User) -> None:
    entry = await _post(db, user, [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))])
    reversal = await reverse_entry(db, entry_id=entry.id, posted_by_id=user.id)

    assert reversal.voucher_no != entry.voucher_no
    assert reversal.series == "jv"
    assert reversal.reversal_of_id == entry.id
    await db.refresh(entry)
    assert entry.reversed_by_id == reversal.id


async def test_reversing_twice_is_refused(db: AsyncSession, user: User) -> None:
    entry = await _post(db, user, [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))])
    await reverse_entry(db, entry_id=entry.id, posted_by_id=user.id)
    with pytest.raises(Conflict):
        await reverse_entry(db, entry_id=entry.id, posted_by_id=user.id)


async def test_adjustment_leaves_only_the_difference(db: AsyncSession, user: User) -> None:
    """verify-flows §7 — the original is preserved and flagged; net effect is the delta."""
    entry = await _post(db, user, [LineIn("5101", debit=D("100")), LineIn("2102", credit=D("100"))])
    before = await account_balance(db, "5101")

    _, replacement = await adjust_entry(
        db,
        entry_id=entry.id,
        lines=[LineIn("5101", debit=D("130")), LineIn("2102", credit=D("130"))],
        posted_by_id=user.id,
    )

    assert await account_balance(db, "5101") == before - D("100") + D("130")
    assert replacement.source_kind == SourceKind.ADJUSTMENT
    await db.refresh(entry)
    assert entry.reversed_by_id is not None, "the original stays, flagged"

    tb = await trial_balance(db)
    assert tb.balanced


# ---------------------------------------------------------------------------
# §44 — Inter-document linking
# ---------------------------------------------------------------------------


async def test_open_item_lifecycle(db: AsyncSession, user: User) -> None:
    """An unpaid invoice is an open item; once paid it is not; the chain walks both ways."""
    gross = D("144000000")
    recognition = await _post(
        db,
        user,
        [LineIn("1201", debit=gross), LineIn("4101", credit=gross)],
        source=SourceIn(kind=SourceKind.INVOICE, ref="INV-9001"),
    )

    items = await open_items(db, control="1201", side=Side.DEBIT)
    mine = [i for i in items if i.entry_id == recognition.id]
    assert len(mine) == 1
    assert mine[0].outstanding == gross
    assert mine[0].raised == gross

    payment = await post_entry(
        db,
        entry_date=MAY10,
        memo="settle INV-9001",
        lines=[LineIn("1101", debit=gross), LineIn("1201", credit=gross)],
        source=SourceIn(kind=SourceKind.PAYMENT, ref=recognition.entry_no),
        posted_by_id=user.id,
        applied_to=[recognition.id],
    )

    items = await open_items(db, control="1201", side=Side.DEBIT)
    assert not [i for i in items if i.entry_id == recognition.id], "settled, so not open"

    settles, settled_by = await linked_entries(db, payment.id)
    assert recognition.id in settles
    assert not settled_by

    settles, settled_by = await linked_entries(db, recognition.id)
    assert payment.id in settled_by


async def test_reversing_a_payment_reopens_the_invoice(db: AsyncSession, user: User) -> None:
    """The behaviour that makes ``openItems`` correct rather than merely plausible."""
    gross = D("50000000")
    recognition = await _post(
        db,
        user,
        [LineIn("1201", debit=gross), LineIn("4101", credit=gross)],
        source=SourceIn(kind=SourceKind.INVOICE, ref="INV-9002"),
    )
    payment = await post_entry(
        db,
        entry_date=MAY10,
        memo="settle INV-9002",
        lines=[LineIn("1101", debit=gross), LineIn("1201", credit=gross)],
        source=SourceIn(kind=SourceKind.PAYMENT),
        posted_by_id=user.id,
        applied_to=[recognition.id],
    )

    assert not [
        i
        for i in await open_items(db, control="1201", side=Side.DEBIT)
        if i.entry_id == recognition.id
    ]

    await reverse_entry(db, entry_id=payment.id, posted_by_id=user.id)

    reopened = [
        i
        for i in await open_items(db, control="1201", side=Side.DEBIT)
        if i.entry_id == recognition.id
    ]
    assert len(reopened) == 1, "reversing the payment reopens the invoice"
    assert reopened[0].outstanding == gross


async def test_a_partial_payment_leaves_the_balance_open(db: AsyncSession, user: User) -> None:
    gross, part = D("100000000"), D("40000000")
    recognition = await _post(
        db,
        user,
        [LineIn("1201", debit=gross), LineIn("4101", credit=gross)],
        source=SourceIn(kind=SourceKind.INVOICE, ref="INV-9003"),
    )
    await post_entry(
        db,
        entry_date=MAY10,
        memo="part payment",
        lines=[LineIn("1101", debit=part), LineIn("1201", credit=part)],
        source=SourceIn(kind=SourceKind.PAYMENT),
        posted_by_id=user.id,
        applied_to=[recognition.id],
    )

    item = next(
        i
        for i in await open_items(db, control="1201", side=Side.DEBIT)
        if i.entry_id == recognition.id
    )
    assert item.raised == gross
    assert item.applied == part
    assert item.outstanding == gross - part


async def test_payables_open_items_use_the_credit_side(db: AsyncSession, user: User) -> None:
    """AP is the mirror of AR: control 2102, opened by a credit."""
    amount = D("18500000")
    bill = await _post(
        db,
        user,
        [LineIn("6101", debit=amount), LineIn("2102", credit=amount)],
        source=SourceIn(kind=SourceKind.PO, ref="BILL-0012", due=date(2026, 6, 11)),
    )

    item = next(
        i for i in await open_items(db, control="2102", side=Side.CREDIT) if i.entry_id == bill.id
    )
    assert item.outstanding == amount
    assert item.due == date(2026, 6, 11), "a bill with no PO still ages"


# ---------------------------------------------------------------------------
# §45 — General ledger
# ---------------------------------------------------------------------------


async def test_general_ledger_opening_plus_movement_equals_closing(
    db: AsyncSession, user: User
) -> None:
    await _post(
        db,
        user,
        [LineIn("1101", debit=D("100")), LineIn("4102", credit=D("100"))],
        entry_date=date(2026, 4, 1),
    )
    await _post(
        db,
        user,
        [LineIn("1101", debit=D("50")), LineIn("4102", credit=D("50"))],
        entry_date=date(2026, 5, 15),
    )

    gl = await general_ledger(
        db, codes=["1101"], period=Period(start=date(2026, 5, 1), end=date(2026, 5, 31))
    )
    assert gl.opening == D("100.00"), "movements before the window are folded in, not dropped"
    assert gl.closing == D("150.00")
    assert gl.opening + gl.movement == gl.closing
    assert gl.single_account


async def test_single_account_ledger_matches_account_balance(db: AsyncSession, user: User) -> None:
    await _dp_pair(db, user)
    gl = await general_ledger(db, codes=["1101"])
    assert gl.closing == await account_balance(db, "1101")


async def test_consolidated_ledger_nets_to_zero(db: AsyncSession, user: User) -> None:
    await _dp_pair(db, user)
    gl = await general_ledger(db)
    assert gl.total_debit == gl.total_credit
    assert gl.closing == ZERO, "every debit has a credit, so the consolidated net is zero"
    assert not gl.single_account


async def test_credit_normal_account_balance_is_signed_to_its_side(
    db: AsyncSession, user: User
) -> None:
    await _post(db, user, [LineIn("1101", debit=D("100")), LineIn("4102", credit=D("100"))])
    assert await account_balance(db, "4102") == D("100.00"), "revenue is credit-normal"
    assert await account_balance(db, "1101") == D("100.00"), "cash is debit-normal"


# ---------------------------------------------------------------------------
# Cash
# ---------------------------------------------------------------------------


async def test_cash_balance_sums_every_cash_flagged_account(db: AsyncSession, user: User) -> None:
    await _post(
        db, user, [LineIn("1103", debit=D("40000000")), LineIn("3102", credit=D("40000000"))]
    )
    await _post(
        db, user, [LineIn("1101", debit=D("10000000")), LineIn("3102", credit=D("10000000"))]
    )

    total, rows = await cash_balance(db)
    codes = {c for c, _, _ in rows}
    assert {"1101", "1102", "1103"} <= codes
    assert total == D("50000000.00")


async def test_a_transfer_between_cash_accounts_leaves_total_unchanged(
    db: AsyncSession, user: User
) -> None:
    """verify-flows §4 — a petty cash top-up moves money, it does not create it."""
    await _post(
        db, user, [LineIn("1101", debit=D("100000000")), LineIn("3102", credit=D("100000000"))]
    )
    before, _ = await cash_balance(db)

    await _post(
        db,
        user,
        [LineIn("1103", debit=D("15000000")), LineIn("1101", credit=D("15000000"))],
        source=SourceIn(kind=SourceKind.PETTYCASH, ref="TOPUP"),
    )

    after, _ = await cash_balance(db)
    assert after == before, "total cash unchanged by an internal transfer"
    assert await account_balance(db, "1103") == D("15000000.00")


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------


async def test_posting_into_a_closed_period_is_refused(db: AsyncSession, user: User) -> None:
    db.add(AccountingPeriod(year=2026, month=3, status=PeriodStatus.CLOSED))
    await db.flush()

    with pytest.raises(PeriodClosed):
        await _post(
            db,
            user,
            [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
            entry_date=date(2026, 3, 15),
        )


async def test_an_open_period_accepts_postings(db: AsyncSession, user: User) -> None:
    db.add(AccountingPeriod(year=2026, month=4, status=PeriodStatus.OPEN))
    await db.flush()
    entry = await _post(
        db,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
        entry_date=date(2026, 4, 15),
    )
    assert entry.entry_no


# ---------------------------------------------------------------------------
# §42 — Chart of accounts
# ---------------------------------------------------------------------------


async def test_seed_chart_has_27_accounts(db: AsyncSession) -> None:
    count = len((await db.execute(select(Account.code))).scalars().all())
    assert count >= 27


async def test_cash_flag_and_types_match_the_prototype(db: AsyncSession) -> None:
    cash = set(
        (await db.execute(select(Account.code).where(Account.is_cash.is_(True)))).scalars().all()
    )
    assert cash == {"1101", "1102", "1103"}

    contra = (
        (await db.execute(select(Account.code).where(Account.is_contra.is_(True)))).scalars().all()
    )
    assert list(contra) == ["1303"], "only accumulated depreciation is contra"

    prepaid = (await db.execute(select(Account).where(Account.code == "1401"))).scalar_one()
    assert prepaid.type == AccountType.ASSET, "PPh 23 withheld from us is an ASSET"

    payable = (await db.execute(select(Account).where(Account.code == "2105"))).scalar_one()
    assert payable.type == AccountType.LIABILITY, "PPh 23 we withhold is a LIABILITY"


async def test_posting_to_a_header_account_is_refused(db: AsyncSession, user: User) -> None:
    """Opening a sub-account turns its parent into a header, which stops accepting posts."""
    db.add(
        Account(
            code="1101.01",
            name="Main Bank — Operating",
            type=AccountType.ASSET,
            group_label="Cash & Bank",
            parent_code="1101",
            is_cash=True,
        )
    )
    await db.flush()

    with pytest.raises(Conflict, match="header"):
        await _post(db, user, [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))])

    entry = await _post(
        db, user, [LineIn("1101.01", debit=D("10")), LineIn("4102", credit=D("10"))]
    )
    assert entry.entry_no, "the sub-account accepts postings"


async def test_a_header_still_counts_toward_total_cash(db: AsyncSession, user: User) -> None:
    """The rule the prototype flagged in a comment: postings on a parent do not move."""
    await _post(db, user, [LineIn("1101", debit=D("100")), LineIn("3102", credit=D("100"))])
    before, _ = await cash_balance(db)

    db.add(
        Account(
            code="1101.02",
            name="Main Bank — Payroll",
            type=AccountType.ASSET,
            group_label="Cash & Bank",
            parent_code="1101",
            is_cash=True,
        )
    )
    await db.flush()

    after, _ = await cash_balance(db)
    assert after == before, "opening a sub-account must not change Total Cash"


async def test_posting_to_a_deactivated_account_is_refused(db: AsyncSession, user: User) -> None:
    account = (await db.execute(select(Account).where(Account.code == "2103"))).scalar_one()
    account.active = False
    await db.flush()

    with pytest.raises(Conflict, match="deactivated"):
        await _post(db, user, [LineIn("2103", debit=D("10")), LineIn("4102", credit=D("10"))])


# ---------------------------------------------------------------------------
# The database defends itself — raw SQL, bypassing the service layer entirely
# ---------------------------------------------------------------------------


async def test_raw_update_of_a_posted_entry_is_rejected(
    db_immediate: AsyncSession, user: User
) -> None:
    entry = await _post(
        db_immediate,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)immutable"):
        await db_immediate.execute(
            text("UPDATE journal_entries SET memo = 'tampered' WHERE id = :i"),
            {"i": entry.id},
        )


async def test_raw_delete_of_a_posted_entry_is_rejected(
    db_immediate: AsyncSession, user: User
) -> None:
    entry = await _post(
        db_immediate,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)never deleted|reversal"):
        await db_immediate.execute(
            text("DELETE FROM journal_entries WHERE id = :i"), {"i": entry.id}
        )


async def test_raw_update_of_a_journal_line_is_rejected(
    db_immediate: AsyncSession, user: User
) -> None:
    entry = await _post(
        db_immediate,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)immutable"):
        await db_immediate.execute(
            text("UPDATE journal_lines SET debit = 999 WHERE entry_id = :i"),
            {"i": entry.id},
        )


async def test_two_sided_line_rejected_by_check_constraint(
    db_immediate: AsyncSession, user: User
) -> None:
    """The service layer refuses this too — but the CHECK is what makes it true."""
    entry = await _post(
        db_immediate,
        user,
        [LineIn("1101", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)one_side|check"):
        await db_immediate.execute(
            text(
                "INSERT INTO journal_lines (id, entry_id, line_no, account_code, debit, credit) "
                "VALUES (gen_random_uuid(), :i, 99, '1101', 5, 5)"
            ),
            {"i": entry.id},
        )


async def test_renumbering_a_used_account_is_rejected(
    db_immediate: AsyncSession, user: User
) -> None:
    await _post(
        db_immediate,
        user,
        [LineIn("1102", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)locked"):
        await db_immediate.execute(text("UPDATE accounts SET code = '1199' WHERE code = '1102'"))


async def test_retyping_a_used_account_is_rejected(db_immediate: AsyncSession, user: User) -> None:
    await _post(
        db_immediate,
        user,
        [LineIn("1102", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)locked"):
        await db_immediate.execute(
            text("UPDATE accounts SET type = 'liability' WHERE code = '1102'")
        )


async def test_renaming_a_used_account_is_allowed(db_immediate: AsyncSession, user: User) -> None:
    """The deliberate exception — renaming never moves history anywhere."""
    await _post(
        db_immediate,
        user,
        [LineIn("1102", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    await db_immediate.execute(
        text("UPDATE accounts SET name = 'Cash in Hand' WHERE code = '1102'")
    )
    renamed = (
        await db_immediate.execute(select(Account).where(Account.code == "1102"))
    ).scalar_one()
    assert renamed.name == "Cash in Hand"


async def test_deleting_a_used_account_is_rejected(db_immediate: AsyncSession, user: User) -> None:
    await _post(
        db_immediate,
        user,
        [LineIn("1102", debit=D("10")), LineIn("4102", credit=D("10"))],
    )
    with pytest.raises(DBAPIError, match="(?i)deactivate|cannot be deleted"):
        await db_immediate.execute(text("DELETE FROM accounts WHERE code = '1102'"))


async def test_sub_accounts_nest_one_level_only(db_immediate: AsyncSession) -> None:
    db_immediate.add(
        Account(
            code="1101.03",
            name="Level one",
            type=AccountType.ASSET,
            group_label="Cash & Bank",
            parent_code="1101",
            is_cash=True,
        )
    )
    await db_immediate.flush()

    db_immediate.add(
        Account(
            code="1101.03.01",
            name="Level two",
            type=AccountType.ASSET,
            group_label="Cash & Bank",
            parent_code="1101.03",
            is_cash=True,
        )
    )
    with pytest.raises(DBAPIError, match="(?i)one level"):
        await db_immediate.flush()


async def test_a_sub_account_must_share_its_parent_type(
    db_immediate: AsyncSession,
) -> None:
    db_immediate.add(
        Account(
            code="1101.04",
            name="Wrong type",
            type=AccountType.LIABILITY,
            group_label="Cash & Bank",
            parent_code="1101",
        )
    )
    with pytest.raises(DBAPIError, match="(?i)parent type"):
        await db_immediate.flush()
