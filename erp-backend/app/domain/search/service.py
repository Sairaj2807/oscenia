"""One search box over every record in the system.

The client's complaint was that the search found only some things. It was true, and the
reason was structural rather than a missing filter: the box searched the collections the
browser happened to be holding — six of them — so purchase orders, stock, crew, fixed
assets and petty-cash requests could not be found at all, and nothing could be found before
it had been loaded. A cap of eight results hid the rest.

This searches the database, which is where the records actually are.

Two behaviours are kept from the client-side version because they are right:

* **A number searches amounts as well as identifiers.** Typing ``192000000`` finds a
  Rp 192,000,000 invoice; the separators people paste are stripped.
* **Amounts match within a band** — 1% or Rp 1,000,000, whichever is wider — because nobody
  remembers a contract value to the rupiah.

Ranking is explicit rather than incidental. An exact document number outranks a prefix,
which outranks a name, which outranks a mention in some other field, which outranks an
amount that happens to fall in the band. Scores are returned, so the ordering can be
explained and tuned instead of argued about.
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import date as date_type
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import Select, case, func, or_, select, true
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.rbac import can_see
from app.domain.ap.models import PurchaseOrder, PurchaseOrderLine, Vendor
from app.domain.ar.models import Client, Invoice, Project, Quotation, QuotationLine
from app.domain.assets.models import Crew, FixedAsset, InventoryItem
from app.domain.cash.models import ProcurementRequest
from app.domain.chat import service as chat_service
from app.domain.chat.access import member_project_ids
from app.domain.chat.models import ChatAttachment, ChatMessage
from app.domain.chat.tokens import parse_tokens
from app.domain.events.models import Event
from app.domain.ledger.models import JournalEntry, JournalLine
from app.domain.masters.models import Role, User
from app.domain.workspace import task_rules
from app.domain.workspace import tasks as task_service
from app.domain.workspace.models import TaskAttachment, WorkspaceTask

#: Below this a query matches most of the database, so it is not a search.
MIN_QUERY = 2
MAX_PER_KIND = 25

#: An amount is searched only when the query carries enough digits to mean one. Three digits
#: is a quantity or a year; four is a figure.
MIN_AMOUNT_DIGITS = 4
AMOUNT_FLOOR = Decimal(1_000_000)
AMOUNT_BAND = Decimal("0.01")

# Rank bands. Gaps are deliberate: a later tweak can land between two without renumbering.
EXACT_NUMBER = 100
NUMBER_PREFIX = 80
NAME_PREFIX = 70
NAME_PART = 55
OTHER_FIELD = 40
AMOUNT_MATCH = 35

KINDS: dict[str, str] = {
    "project": "Projects",
    "client": "Clients",
    "quotation": "Quotations",
    "invoice": "Invoices",
    "purchase_order": "Purchase Orders",
    "vendor": "Vendors",
    "journal": "Journal",
    "procurement": "Petty Cash",
    "inventory": "Stock",
    "fixed_asset": "Fixed Assets",
    "crew": "Crew",
    "chat_message": "Chat",
    "task": "Tasks",
    "event": "Events",
    "file": "Files",
}


@dataclass(frozen=True)
class Term:
    """A parsed query: the text to match, and the amount it might be."""

    raw: str
    text: str
    pattern: str
    prefix: str
    amount: Decimal | None

    @property
    def band(self) -> tuple[Decimal, Decimal]:
        """The window an amount has to fall in. Only read when `amount` is set."""
        assert self.amount is not None
        tolerance = max(AMOUNT_FLOOR, self.amount * AMOUNT_BAND)
        return self.amount - tolerance, self.amount + tolerance


def parse(q: str) -> Term | None:
    """Read a query, or refuse it.

    ``%`` and ``_`` are escaped rather than rejected: they are LIKE wildcards, and a client
    name with an underscore in it would otherwise match far more than it should.
    """
    raw = (q or "").strip()
    if len(raw) < MIN_QUERY:
        return None

    text = raw.lower()
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")

    digits = re.sub(r"[^0-9]", "", raw)
    amount: Decimal | None = None
    if len(digits) >= MIN_AMOUNT_DIGITS:
        try:
            amount = Decimal(digits)
        except InvalidOperation:  # pragma: no cover - re guarantees digits
            amount = None

    return Term(raw=raw, text=text, pattern=f"%{escaped}%", prefix=f"{escaped}%", amount=amount)


def _score(
    term: Term,
    *,
    number: Any,
    name: Any = None,
    others: list[Any] | None = None,
    money: Any = None,
) -> Any:
    """The rank expression for one entity, evaluated in the database.

    Ordering happens in SQL rather than in Python on purpose: scoring after a LIMIT would
    mean the exact match you typed could be cut before it was ever ranked.
    """
    branches: list[tuple[Any, int]] = [
        (func.lower(number) == term.text, EXACT_NUMBER),
        (number.ilike(term.prefix, escape="\\"), NUMBER_PREFIX),
    ]
    if name is not None:
        branches.append((name.ilike(term.prefix, escape="\\"), NAME_PREFIX))
        branches.append((name.ilike(term.pattern, escape="\\"), NAME_PART))
    for column in others or []:
        branches.append((column.ilike(term.pattern, escape="\\"), OTHER_FIELD))
    if money is not None and term.amount is not None:
        low, high = term.band
        branches.append((money.between(low, high), AMOUNT_MATCH))

    return case(*branches, else_=0)


async def _collect(
    session: AsyncSession, stmt: Select[Any], score: Any, limit: int, tiebreak: Any
) -> list[Any]:
    """Run one entity's query, best-ranked first.

    `tiebreak` is the document number, and it is not decoration: scores come in bands, so a
    prefix search ties for most of its results, and without a second key which five of
    twenty came back would vary between identical requests.
    """
    rows = await session.execute(
        stmt.add_columns(score.label("score"))
        .where(score > 0)
        .order_by(score.desc(), tiebreak)
        .limit(limit)
    )
    return list(rows.all())


# ---------------------------------------------------------------------------
# Correlated totals
# ---------------------------------------------------------------------------
#
# A quotation, a purchase order and a journal entry each carry their value on their LINES.
# Summing in a correlated subquery keeps one row per record — a join would multiply the
# record by its line count and report the same quotation three times.

_QUOTATION_TOTAL = (
    select(func.coalesce(func.sum(QuotationLine.amount), 0))
    .where(QuotationLine.quotation_id == Quotation.id)
    # Correlated EXPLICITLY. Left to guess, SQLAlchemy strips the subquery's own FROM when
    # the outer query happens to mention the same table -- which the purchase-order search
    # does, since it joins lines to search their labels -- and the statement then has no
    # FROM at all.
    .correlate(Quotation)
    .scalar_subquery()
)
_PO_TOTAL = (
    select(func.coalesce(func.sum(PurchaseOrderLine.qty * PurchaseOrderLine.unit_price), 0))
    .where(PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
    .correlate(PurchaseOrder)
    .scalar_subquery()
)
_ENTRY_TOTAL = (
    select(func.coalesce(func.sum(JournalLine.debit), 0))
    .where(JournalLine.entry_id == JournalEntry.id)
    .correlate(JournalEntry)
    .scalar_subquery()
)


# ---------------------------------------------------------------------------
# One query per kind
# ---------------------------------------------------------------------------


async def _projects(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Project.project_no,
        name=Project.name,
        others=[Client.name, Project.division],
        money=Project.contract_value,
    )
    stmt = select(Project, Client.name.label("client_name")).join(
        Client, Client.id == Project.client_id
    )
    return [
        {
            "kind": "project",
            "id": row.Project.project_no,
            "uuid": row.Project.id,
            "title": row.Project.name,
            "subtitle": f"{row.client_name} · {row.Project.stage.value}",
            "amount": row.Project.contract_value,
            "date": row.Project.event_date,
            "score": row.score,
        }
        for row in await _collect(session, stmt, score, limit, Project.project_no)
    ]


async def _clients(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Client.client_no,
        name=Client.name,
        others=[Client.contact, Client.phone, Client.email, Client.personal_brand],
    )
    return [
        {
            "kind": "client",
            "id": row.Client.client_no,
            "uuid": row.Client.id,
            "title": row.Client.name,
            "subtitle": " · ".join(x for x in (row.Client.contact, row.Client.phone) if x) or None,
            "amount": None,
            "date": None,
            "score": row.score,
        }
        for row in await _collect(session, select(Client), score, limit, Client.client_no)
    ]


async def _quotations(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Quotation.quotation_no,
        name=Quotation.event_type,
        others=[Client.name],
        money=_QUOTATION_TOTAL,
    )
    stmt = select(
        Quotation, Client.name.label("client_name"), _QUOTATION_TOTAL.label("total")
    ).join(Client, Client.id == Quotation.client_id)
    return [
        {
            "kind": "quotation",
            "id": row.Quotation.quotation_no,
            "uuid": row.Quotation.id,
            "title": f"{row.client_name} — {row.Quotation.event_type}",
            "subtitle": f"{row.Quotation.quotation_no} · {row.Quotation.status.value}",
            "amount": row.total,
            "date": row.Quotation.event_date,
            "score": row.score,
        }
        for row in await _collect(session, stmt, score, limit, Quotation.quotation_no)
    ]


async def _invoices(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Invoice.invoice_no,
        name=Invoice.stage_label,
        others=[Project.project_no, Project.name],
        money=Invoice.amount,
    )
    stmt = select(Invoice, Project.project_no.label("project_no")).join(
        Project, Project.id == Invoice.project_id
    )
    return [
        {
            "kind": "invoice",
            "id": row.Invoice.invoice_no,
            "uuid": row.Invoice.id,
            "title": f"{row.Invoice.invoice_no} — {row.Invoice.stage_label}",
            "subtitle": f"{row.project_no} · {row.Invoice.status.value}",
            "amount": row.Invoice.amount,
            # The invoice's own date where it has one, which is what a person looking for it
            # remembers; the due date otherwise.
            "date": row.Invoice.document_date or row.Invoice.due_date,
            "score": row.score,
        }
        for row in await _collect(session, stmt, score, limit, Invoice.invoice_no)
    ]


async def _purchase_orders(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=PurchaseOrder.po_no,
        name=Vendor.name,
        others=[PurchaseOrderLine.item_label],
        money=func.coalesce(PurchaseOrder.actual_total, _PO_TOTAL),
    )
    # DISTINCT because a PO matching on two of its line labels is still one purchase order.
    stmt = (
        select(
            PurchaseOrder,
            Vendor.name.label("vendor_name"),
            func.coalesce(PurchaseOrder.actual_total, _PO_TOTAL).label("total"),
        )
        .join(Vendor, Vendor.id == PurchaseOrder.vendor_id)
        .outerjoin(PurchaseOrderLine, PurchaseOrderLine.purchase_order_id == PurchaseOrder.id)
        .distinct()
    )
    return [
        {
            "kind": "purchase_order",
            "id": row.PurchaseOrder.po_no,
            "uuid": row.PurchaseOrder.id,
            "title": f"{row.PurchaseOrder.po_no} — {row.vendor_name}",
            "subtitle": row.PurchaseOrder.status.value,
            "amount": row.total,
            "date": row.PurchaseOrder.event_date or row.PurchaseOrder.order_date,
            "score": row.score,
        }
        for row in await _collect(session, stmt, score, limit, PurchaseOrder.po_no)
    ]


async def _vendors(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Vendor.vendor_no,
        name=Vendor.name,
        others=[Vendor.category, Vendor.pic_name, Vendor.npwp],
        money=Vendor.baseline_price,
    )
    return [
        {
            "kind": "vendor",
            "id": row.Vendor.vendor_no,
            "uuid": row.Vendor.id,
            "title": row.Vendor.name,
            "subtitle": row.Vendor.category,
            "amount": row.Vendor.baseline_price,
            "date": None,
            "score": row.score,
        }
        for row in await _collect(session, select(Vendor), score, limit, Vendor.vendor_no)
    ]


async def _journal(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=JournalEntry.voucher_no,
        name=JournalEntry.memo,
        others=[JournalEntry.entry_no, JournalEntry.group_ref, JournalEntry.source_ref],
        money=_ENTRY_TOTAL,
    )
    stmt = select(JournalEntry, _ENTRY_TOTAL.label("total"))
    return [
        {
            "kind": "journal",
            "id": row.JournalEntry.entry_no,
            "uuid": row.JournalEntry.id,
            "title": row.JournalEntry.memo,
            "subtitle": f"{row.JournalEntry.voucher_no} · {row.JournalEntry.source_kind.value}",
            "amount": row.total,
            "date": row.JournalEntry.entry_date,
            "score": row.score,
        }
        for row in await _collect(session, stmt, score, limit, JournalEntry.entry_no)
    ]


async def _procurement(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=ProcurementRequest.request_no,
        name=ProcurementRequest.category,
        others=[ProcurementRequest.requested_by],
        money=ProcurementRequest.amount,
    )
    return [
        {
            "kind": "procurement",
            "id": row.ProcurementRequest.request_no,
            "uuid": row.ProcurementRequest.id,
            "title": f"{row.ProcurementRequest.request_no} — {row.ProcurementRequest.category}",
            "subtitle": (
                f"{row.ProcurementRequest.requested_by} · {row.ProcurementRequest.status.value}"
            ),
            "amount": row.ProcurementRequest.amount,
            "date": row.ProcurementRequest.request_date,
            "score": row.score,
        }
        for row in await _collect(
            session, select(ProcurementRequest), score, limit, ProcurementRequest.request_no
        )
    ]


async def _inventory(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=InventoryItem.item_no,
        name=InventoryItem.item,
        others=[InventoryItem.unit],
        money=InventoryItem.unit_value,
    )
    return [
        {
            "kind": "inventory",
            "id": row.InventoryItem.item_no,
            "uuid": row.InventoryItem.id,
            "title": row.InventoryItem.item,
            "subtitle": (
                f"{row.InventoryItem.qty} {row.InventoryItem.unit or ''}".strip()
                + f" · {row.InventoryItem.status.value}"
            ),
            "amount": row.InventoryItem.unit_value,
            "date": row.InventoryItem.event_date,
            "score": row.score,
        }
        for row in await _collect(
            session, select(InventoryItem), score, limit, InventoryItem.item_no
        )
    ]


async def _fixed_assets(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=FixedAsset.asset_no,
        name=FixedAsset.name,
        others=[FixedAsset.category],
        money=FixedAsset.cost,
    )
    return [
        {
            "kind": "fixed_asset",
            "id": row.FixedAsset.asset_no,
            "uuid": row.FixedAsset.id,
            "title": row.FixedAsset.name,
            "subtitle": f"{row.FixedAsset.category or '—'} · {row.FixedAsset.status.value}",
            "amount": row.FixedAsset.cost,
            "date": row.FixedAsset.acquired_on,
            "score": row.score,
        }
        for row in await _collect(session, select(FixedAsset), score, limit, FixedAsset.asset_no)
    ]


async def _crew(session: AsyncSession, term: Term, limit: int) -> list[dict[str, Any]]:
    score = _score(
        term,
        number=Crew.crew_no,
        name=Crew.name,
        others=[Crew.role],
        money=Crew.base_rate,
    )
    return [
        {
            "kind": "crew",
            "id": row.Crew.crew_no,
            "uuid": row.Crew.id,
            "title": row.Crew.name,
            "subtitle": row.Crew.role,
            "amount": row.Crew.base_rate,
            "date": None,
            "score": row.score,
        }
        for row in await _collect(
            session, select(Crew).where(Crew.active.is_(True)), score, limit, Crew.crew_no
        )
    ]


# ---------------------------------------------------------------------------
# Kinds that depend on WHO is asking
# ---------------------------------------------------------------------------
#
# Everything above is gated by module alone. A chat message, a task and the files on them are
# not: whether you may see one depends on the channel it is in, the project you work on, your
# division. Those rules already exist (`chat.access`, `workspace.task_rules`) and are reused as
# they are, not restated in SQL. SQL only narrows the candidates; the rule decides.
#
# Guests are deliberately not searchable. They are people who RSVPed to an invitation, and
# their names, numbers and notes are personal data that a search box would spread.

#: How much text to show around the match in a message hit.
SNIPPET_CHARS = 140


def _plain(text: str, by_no: dict[str, str]) -> str:
    """A message as a person would read it: ``<@M-05>`` becomes ``@Rina M.``, ``<#T-102>``
    becomes ``#T-102``. Raw tokens never reach the result list."""
    out: list[str] = []
    for part in parse_tokens(text):
        if part.type == "mention":
            out.append("@" + by_no.get(part.value, "someone"))
        elif part.type == "task":
            out.append("#" + part.value)
        else:
            out.append(part.value)
    return re.sub(r"\s+", " ", "".join(out)).strip()


def _snippet(plain: str, needle: str) -> str:
    """The stretch of `plain` around the first match, cut with an ellipsis where it was trimmed."""
    at = plain.lower().find(needle)
    if at < 0 or len(plain) <= SNIPPET_CHARS:
        return plain[:SNIPPET_CHARS] + ("…" if len(plain) > SNIPPET_CHARS else "")
    start = max(0, at - SNIPPET_CHARS // 3)
    end = min(len(plain), start + SNIPPET_CHARS)
    return ("…" if start else "") + plain[start:end] + ("…" if end < len(plain) else "")


def _channel_label(channel: Any) -> str:
    # A DM's name is empty, and naming the other person is for its two members only; the caller
    # can open it, so it is the caller's own conversation, but a neutral label costs nothing.
    return "Direct message" if channel.is_dm else f"#{channel.name}"


async def _chat_messages(
    session: AsyncSession, term: Term, limit: int, user: User
) -> list[dict[str, Any]]:
    ctx = await chat_service.load_context(session, user)
    if str(user.id) not in ctx.people:
        return []
    open_ids = [c.id for c in ctx.channels.values() if ctx.can_open(c)]
    if not open_ids:
        return []
    by_no = {u.member_no: u.full_name for u in ctx.users.values() if u.member_no}

    score = _score(term, number=ChatMessage.text, others=[ChatMessage.text])
    stmt = select(ChatMessage).where(
        ChatMessage.channel_id.in_(open_ids),
        ChatMessage.deleted_at.is_(None),
        ChatMessage.kind == "text",
    )
    # Over-fetch: the match is on the stored text, tokens included, so a query that only hits a
    # token (`M-05`) is dropped below once the text is rendered the way a reader sees it.
    rows = await _collect(session, stmt, score, limit * 3, ChatMessage.created_at.desc())
    hits: list[dict[str, Any]] = []
    for row in rows:
        message = row.ChatMessage
        plain = _plain(message.text, by_no)
        if term.text not in plain.lower():
            continue
        channel = ctx.channels[message.channel_id]
        author = ctx.users.get(str(message.author_id))
        hits.append(
            {
                "kind": "chat_message",
                "id": str(message.id),
                "uuid": message.id,
                "title": _snippet(plain, term.text),
                "subtitle": " · ".join(
                    x for x in (_channel_label(channel), author.full_name if author else None) if x
                ),
                "amount": None,
                "date": message.created_at.date(),
                "score": row.score,
                "ref": f"channel:{channel.id}",
            }
        )
        if len(hits) == limit:
            break
    return hits


async def _task_scope(session: AsyncSession, user: User) -> tuple[Any, Any]:
    """The directory the task rules read, and a SQL narrowing that is never wider than them."""
    directory = await task_service.load_directory(session, user)
    me = directory.people.get(str(user.id))
    if me is None:
        return directory, None
    match me.workspace_role:
        case "pm":
            narrow: Any = true()
        case "leader":
            narrow = or_(
                WorkspaceTask.division == me.division, WorkspaceTask.assigned_by_id == user.id
            )
        case "staff":
            narrow = WorkspaceTask.project_id.in_(
                [uuid.UUID(p) for p in member_project_ids(me, directory.project_divisions)]
            )
        case _:
            narrow = WorkspaceTask.assignee_id == user.id
    return directory, narrow


async def _tasks(
    session: AsyncSession, term: Term, limit: int, user: User
) -> list[dict[str, Any]]:
    directory, narrow = await _task_scope(session, user)
    if narrow is None:
        return []
    score = _score(
        term,
        number=WorkspaceTask.task_no,
        name=WorkspaceTask.title,
        others=[WorkspaceTask.description],
    )
    stmt = (
        select(WorkspaceTask, Project.project_no.label("project_no"))
        .join(Project, Project.id == WorkspaceTask.project_id)
        .where(narrow)
    )
    hits: list[dict[str, Any]] = []
    # The rule is the authority; the SQL above only keeps the candidates few. Paging past rows
    # the rule refuses means a task you may see is not pushed out by one you may not.
    for offset in range(0, limit * 8, limit * 2):
        rows = list(
            (
                await session.execute(
                    stmt.add_columns(score.label("score"))
                    .where(score > 0)
                    .order_by(score.desc(), WorkspaceTask.task_no)
                    .limit(limit * 2)
                    .offset(offset)
                )
            ).all()
        )
        for row in rows:
            task = row.WorkspaceTask
            if not task_rules.can_see_task(
                directory.me_member, task_service.fact(task), directory.project_divisions
            ):
                continue
            hits.append(
                {
                    "kind": "task",
                    "id": task.task_no,
                    "uuid": task.id,
                    "title": task.title,
                    "subtitle": f"{row.project_no} · {task.status.value}",
                    "amount": None,
                    "date": task.deadline,
                    "score": row.score,
                    "ref": f"project:{row.project_no}",
                }
            )
            if len(hits) == limit:
                return hits
        if len(rows) < limit * 2:
            break
    return hits


async def _events(
    session: AsyncSession, term: Term, limit: int, user: User
) -> list[dict[str, Any]]:
    score = _score(term, number=Event.event_no, name=Event.name, others=[Event.venue])
    return [
        {
            "kind": "event",
            "id": row.Event.event_no,
            "uuid": row.Event.id,
            "title": row.Event.name,
            "subtitle": " · ".join(x for x in (row.Event.venue, row.Event.status.value) if x),
            "amount": None,
            "date": row.Event.date,
            "score": row.score,
            "ref": f"event:{row.Event.event_no}",
        }
        for row in await _collect(session, select(Event), score, limit, Event.event_no)
    ]


async def _files(
    session: AsyncSession, term: Term, limit: int, user: User
) -> list[dict[str, Any]]:
    """File NAMES only, found through the parent that holds them: a chat attachment is as
    visible as its channel, a task attachment as its task. The hit opens the parent."""
    hits: list[dict[str, Any]] = []

    if can_see(user.role, "chat"):
        ctx = await chat_service.load_context(session, user)
        # Membership first: a login with no workspace persona has no chat, and the access rules
        # cannot even be asked about someone they do not know.
        open_ids = (
            [c.id for c in ctx.channels.values() if ctx.can_open(c)]
            if str(user.id) in ctx.people
            else []
        )
        if open_ids:
            score = _score(term, number=ChatAttachment.filename, name=ChatAttachment.filename)
            stmt = (
                select(ChatAttachment)
                .join(ChatMessage, ChatMessage.id == ChatAttachment.message_id)
                .where(
                    ChatAttachment.channel_id.in_(open_ids),
                    ChatMessage.deleted_at.is_(None),
                )
            )
            for row in await _collect(
                session, stmt, score, limit, ChatAttachment.filename
            ):
                att = row.ChatAttachment
                hits.append(
                    {
                        "kind": "file",
                        "id": att.filename,
                        "uuid": att.id,
                        "title": att.filename,
                        "subtitle": f"in {_channel_label(ctx.channels[att.channel_id])}",
                        "amount": None,
                        "date": att.created_at.date(),
                        "score": row.score,
                        "ref": f"channel:{att.channel_id}",
                    }
                )

    if can_see(user.role, "workspace"):
        directory, narrow = await _task_scope(session, user)
        if narrow is not None:
            score = _score(term, number=TaskAttachment.filename, name=TaskAttachment.filename)
            task_stmt = (
                select(TaskAttachment, WorkspaceTask, Project.project_no.label("project_no"))
                .join(WorkspaceTask, WorkspaceTask.id == TaskAttachment.task_id)
                .join(Project, Project.id == WorkspaceTask.project_id)
                .where(narrow)
            )
            for row in await _collect(
                session, task_stmt, score, limit * 3, TaskAttachment.filename
            ):
                task = row.WorkspaceTask
                if not task_rules.can_see_task(
                    directory.me_member, task_service.fact(task), directory.project_divisions
                ):
                    continue
                att = row.TaskAttachment
                hits.append(
                    {
                        "kind": "file",
                        "id": att.filename,
                        "uuid": att.id,
                        "title": att.filename,
                        "subtitle": f"on {task.task_no} · {task.title}",
                        "amount": None,
                        "date": att.created_at.date(),
                        "score": row.score,
                        "ref": f"project:{row.project_no}",
                    }
                )

    hits.sort(key=lambda h: (-h["score"], h["id"]))
    return hits[:limit]


#: The module a role needs to see each kind of record, as the screens themselves are gated. A search
#: box that ignored this would hand a Team member the journal, vendor bank details and crew rates.
KIND_MODULE = {
    "project": "projects",
    "client": "crm",
    "quotation": "quotations",
    "invoice": "receivables",
    "purchase_order": "purchaseorders",
    "vendor": "vendors",
    "journal": "accounting",
    "procurement": "procurement",
    "inventory": "warehouse",
    "fixed_asset": "fixedassets",
    "crew": "payroll",
    "chat_message": "chat",
    "task": "workspace",
    "event": "events",
    # Either module opens a file; `_files` checks each source for itself.
    "file": "chat",
}


def kinds_for(role: Role) -> set[str]:
    """The kinds this role may search."""
    allowed = {kind for kind, module in KIND_MODULE.items() if can_see(role, module)}
    if can_see(role, "workspace"):
        allowed.add("file")
    return allowed


_FINDERS = {
    "project": _projects,
    "client": _clients,
    "quotation": _quotations,
    "invoice": _invoices,
    "purchase_order": _purchase_orders,
    "vendor": _vendors,
    "journal": _journal,
    "procurement": _procurement,
    "inventory": _inventory,
    "fixed_asset": _fixed_assets,
    "crew": _crew,
}

#: Finders whose answer depends on the person asking, so they are given the user.
_USER_FINDERS = {
    "chat_message": _chat_messages,
    "task": _tasks,
    "event": _events,
    "file": _files,
}


async def search(
    session: AsyncSession,
    q: str,
    *,
    limit: int = 5,
    kinds: list[str] | None = None,
    allowed: set[str] | None = None,
    user: User | None = None,
) -> dict[str, Any]:
    """Search every kind at once, grouped, best group first.

    Returns empty rather than raising on a too-short query: a search box sends a request on
    every keystroke, and the first two of them are not an error.
    """
    term = parse(q)
    if term is None:
        return {"query": (q or "").strip(), "total": 0, "groups": []}

    known = {**_FINDERS, **(_USER_FINDERS if user is not None else {})}
    wanted = [k for k in (kinds or list(known)) if k in known and (allowed is None or k in allowed)]
    per_kind = max(1, min(limit, MAX_PER_KIND))

    groups: list[dict[str, Any]] = []
    total = 0
    for kind in wanted:
        if kind in _USER_FINDERS:
            assert user is not None
            hits = await _USER_FINDERS[kind](session, term, per_kind, user)
        else:
            hits = await _FINDERS[kind](session, term, per_kind)
        if not hits:
            continue
        hits.sort(key=lambda h: (-h["score"], _recency(h["date"]), h["id"]))
        total += len(hits)
        groups.append(
            {"kind": kind, "label": KINDS[kind], "total": len(hits), "hits": hits}
        )

    # The group holding the best single hit comes first. A fixed order would bury the exact
    # purchase order somebody typed under three fuzzy project names.
    groups.sort(key=lambda g: -max(h["score"] for h in g["hits"]))
    return {"query": term.raw, "total": total, "groups": groups}


def _recency(value: date_type | None) -> int:
    """Newest first within a score band, and undated records last rather than first.

    Negated, because the sort is ascending and an ordinal grows with the date. Undated rows
    get 0, which is larger than every negated ordinal and so lands them at the end.
    """
    return 0 if value is None else -value.toordinal()
