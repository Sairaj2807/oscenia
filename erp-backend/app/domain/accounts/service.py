"""Chart-of-accounts operations.

The database enforces the hard rules (see the ``accounts_guarded`` and ``accounts_nesting``
triggers). This layer exists to catch them first and say something useful — "deactivate it
instead" is more helpful than a raw plpgsql RAISE — and to carry the two behaviours that
are policy rather than constraint:

* a sub-account **inherits** ``is_cash`` and ``tax_key`` from its parent
* ``next_code`` suggests ``1101.01`` under a parent, or the next free top-level code
"""

from __future__ import annotations

import re
from decimal import Decimal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import Conflict, Invalid, NotFound
from app.core.money import ZERO
from app.domain.accounts.models import (
    CONTROL_ACCOUNTS,
    TYPE_META,
    TYPE_ORDER,
    Account,
    AccountType,
    Side,
    Statement,
    normal_side,
    statement_of,
)
from app.domain.accounts.schemas import AccountCreate, AccountUpdate
from app.domain.ledger.models import JournalLine

CODE_RE = re.compile(r"^[0-9]+(\.[0-9]+)*$")


async def get(session: AsyncSession, code: str) -> Account:
    account = (
        await session.execute(select(Account).where(Account.code == code))
    ).scalar_one_or_none()
    if account is None:
        raise NotFound(f"No account with code {code!r}.")
    return account


async def list_accounts(
    session: AsyncSession,
    *,
    type_: AccountType | None = None,
    query: str | None = None,
    include_inactive: bool = False,
) -> list[Account]:
    stmt = select(Account)
    if type_ is not None:
        stmt = stmt.where(Account.type == type_)
    if not include_inactive:
        stmt = stmt.where(Account.active.is_(True))
    if query:
        pattern = f"%{query.strip()}%"
        stmt = stmt.where(
            Account.code.ilike(pattern)
            | Account.name.ilike(pattern)
            | Account.group_label.ilike(pattern)
        )
    return list((await session.execute(stmt.order_by(Account.code))).scalars().all())


async def usage_counts(session: AsyncSession) -> dict[str, int]:
    rows = (
        await session.execute(
            select(JournalLine.account_code, func.count())
            .group_by(JournalLine.account_code)
        )
    ).all()
    return {code: count for code, count in rows}


async def children_map(session: AsyncSession) -> dict[str, list[str]]:
    rows = (
        await session.execute(
            select(Account.parent_code, Account.code).where(Account.parent_code.isnot(None))
        )
    ).all()
    out: dict[str, list[str]] = {}
    for parent, code in rows:
        out.setdefault(parent, []).append(code)
    return {k: sorted(v) for k, v in out.items()}


async def balances(session: AsyncSession) -> dict[str, Decimal]:
    """Signed to each account's natural side, in one query rather than one per account."""
    rows = (
        await session.execute(
            select(
                JournalLine.account_code,
                func.coalesce(func.sum(JournalLine.debit), 0),
                func.coalesce(func.sum(JournalLine.credit), 0),
            ).group_by(JournalLine.account_code)
        )
    ).all()
    accounts = {a.code: a for a in (await session.execute(select(Account))).scalars().all()}

    out: dict[str, Decimal] = {}
    for code, debit, credit in rows:
        account = accounts.get(code)
        if account is None:
            continue
        out[code] = (
            Decimal(debit) - Decimal(credit)
            if normal_side(account.type) is Side.DEBIT
            else Decimal(credit) - Decimal(debit)
        )
    return out


def is_header(code: str, children: dict[str, list[str]]) -> bool:
    return bool(children.get(code))


async def stats(session: AsyncSession) -> dict[str, int]:
    accounts = list((await session.execute(select(Account))).scalars().all())
    children = await children_map(session)
    usage = await usage_counts(session)

    postable = [a for a in accounts if a.active and not is_header(a.code, children)]
    return {
        "total": len(accounts),
        "postable": len(postable),
        "deactivated": len([a for a in accounts if not a.active]),
        # The fragmentation warning: a chart that keeps growing accounts nobody posts to.
        "never_posted": len([a for a in accounts if usage.get(a.code, 0) == 0]),
    }


async def next_code(
    session: AsyncSession, *, parent: str | None = None, type_: AccountType | None = None
) -> str:
    """``1101`` -> ``1101.01`` under a parent, else the next free top-level code for a type."""
    if parent:
        await get(session, parent)
        siblings = (
            (
                await session.execute(
                    select(Account.code).where(Account.parent_code == parent)
                )
            )
            .scalars()
            .all()
        )
        suffixes = [
            int(code.rsplit(".", 1)[-1])
            for code in siblings
            if code.rsplit(".", 1)[-1].isdigit()
        ]
        return f"{parent}.{max(suffixes, default=0) + 1:02d}"

    if type_ is None:
        raise Invalid("Provide either a parent code or an account type.")

    tops = (
        (
            await session.execute(
                select(Account.code).where(
                    Account.type == type_, Account.parent_code.is_(None)
                )
            )
        )
        .scalars()
        .all()
    )
    numeric = [int(c) for c in tops if c.isdigit()]
    if not numeric:
        raise Invalid(f"No existing top-level {type_.value} account to number from.")
    return str(max(numeric) + 1)


async def create(session: AsyncSession, draft: AccountCreate) -> Account:
    if not CODE_RE.match(draft.code):
        raise Invalid(
            f"{draft.code!r} is not a valid account code. Use digits, optionally dotted for "
            "sub-accounts, e.g. 1101 or 1101.01."
        )

    existing = (
        await session.execute(select(Account).where(Account.code == draft.code))
    ).scalar_one_or_none()
    if existing is not None:
        raise Conflict(f"Account {draft.code} already exists ({existing.name}).")

    is_cash = draft.is_cash or False
    tax_key = draft.tax_key
    group_label = draft.group_label

    if draft.parent_code:
        parent = await get(session, draft.parent_code)

        if parent.code in CONTROL_ACCOUNTS:
            raise Conflict(
                f"{parent.code} ({parent.name}) is a control account and cannot have "
                "sub-accounts: receivables and payables are reconciled against it "
                "directly, and a sub-account would turn it into a header that accepts "
                "no postings."
            )
        if parent.parent_code is not None:
            raise Conflict(
                f"Sub-accounts nest one level only: {parent.code} already sits under "
                f"{parent.parent_code}."
            )
        if parent.type is not draft.type:
            raise Conflict(
                f"A sub-account must share its parent's type. {parent.code} is "
                f"{parent.type.value}, not {draft.type.value}."
            )

        # Inheritance is policy, not constraint: a sub-account of a bank account is still
        # cash, and a sub-account of a withholding account still carries its tax key.
        if draft.is_cash is None:
            is_cash = parent.is_cash
        if tax_key is None:
            tax_key = parent.tax_key
        if group_label is None:
            group_label = parent.group_label

    account = Account(
        code=draft.code,
        name=draft.name,
        type=draft.type,
        group_label=group_label or TYPE_META[draft.type][2],
        parent_code=draft.parent_code,
        is_cash=is_cash,
        tax_key=tax_key,
    )
    session.add(account)
    await session.flush()
    return account


async def update(session: AsyncSession, code: str, patch: AccountUpdate) -> Account:
    account = await get(session, code)
    for field, value in patch.model_dump(exclude_unset=True).items():
        setattr(account, field, value)
    await session.flush()
    return account


async def set_active(session: AsyncSession, code: str, active: bool) -> Account:
    account = await get(session, code)
    account.active = active
    await session.flush()
    return account


async def delete(session: AsyncSession, code: str) -> None:
    account = await get(session, code)

    used = (
        await session.execute(
            select(func.count()).select_from(JournalLine).where(
                JournalLine.account_code == code
            )
        )
    ).scalar_one()
    if used:
        raise Conflict(
            f"Account {code} carries {used} posted line(s) and cannot be deleted — deleting "
            "it would orphan them. Deactivate it instead: the balance and history stay, and "
            "nothing new can post to it."
        )

    kids = (
        await session.execute(
            select(func.count()).select_from(Account).where(Account.parent_code == code)
        )
    ).scalar_one()
    if kids:
        raise Conflict(f"Account {code} has {kids} sub-account(s) and cannot be deleted.")

    await session.delete(account)
    await session.flush()


async def detail(session: AsyncSession, code: str) -> dict[str, object]:
    account = await get(session, code)
    children = await children_map(session)
    usage = await usage_counts(session)
    bal = await balances(session)

    header = is_header(code, children)
    return {
        **{c.name: getattr(account, c.name) for c in Account.__table__.columns},
        "usage_count": usage.get(code, 0),
        "balance": bal.get(code, ZERO),
        "is_header": header,
        "is_postable": account.active and not header,
        "child_codes": children.get(code, []),
        "normal_side": normal_side(account.type),
        "statement": statement_of(account.type),
    }


async def tree(session: AsyncSession, *, include_inactive: bool = False) -> list[dict]:
    """type -> executive group -> account -> sub-accounts, as the screen renders it."""
    accounts = await list_accounts(session, include_inactive=include_inactive)
    bal = await balances(session)
    by_parent: dict[str, list[Account]] = {}
    for a in accounts:
        if a.parent_code:
            by_parent.setdefault(a.parent_code, []).append(a)

    def node(a: Account) -> dict:
        return {
            **{c.name: getattr(a, c.name) for c in Account.__table__.columns},
            "balance": bal.get(a.code, ZERO),
            "children": [node(c) for c in sorted(by_parent.get(a.code, []), key=lambda x: x.code)],
        }

    out: list[dict] = []
    for type_ in TYPE_ORDER:
        tops = [a for a in accounts if a.type is type_ and a.parent_code is None]
        if not tops:
            continue
        groups: dict[str, list[Account]] = {}
        for a in tops:
            groups.setdefault(a.group_label, []).append(a)
        out.append(
            {
                "type": type_,
                "label": TYPE_META[type_][2],
                "groups": [
                    {"group": g, "accounts": [node(a) for a in sorted(items, key=lambda x: x.code)]}
                    for g, items in sorted(groups.items())
                ],
            }
        )
    return out


__all__ = [
    "Statement",
    "create",
    "delete",
    "detail",
    "get",
    "list_accounts",
    "next_code",
    "set_active",
    "stats",
    "tree",
    "update",
]
