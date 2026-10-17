"""The global search endpoint.

Over real HTTP, because the thing being tested is whether a person typing what they
remember finds the record — and what they remember is a document number, half a name, or
roughly how much it was for.

The records are built here rather than assumed: the test database carries reference data
only, so a suite that searched "whatever is in there" would pass on an empty result the day
the fixtures changed.
"""

from __future__ import annotations

import uuid as uuid_mod
from datetime import date
from decimal import Decimal
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.ap.models import PoStatus, PurchaseOrder, PurchaseOrderLine, Vendor
from app.domain.ar.models import (
    Client,
    Invoice,
    InvoiceStatus,
    InvoiceType,
    Project,
    Quotation,
    QuotationLine,
    QuotationStatus,
)
from app.domain.assets.models import (
    AssetStatus,
    Crew,
    FixedAsset,
    InventoryItem,
    InventoryStatus,
    InventoryType,
    Method,
)
from app.domain.cash.models import ProcurementRequest, RequestStatus
from app.domain.masters.models import User

pytestmark = pytest.mark.phase1

DAY = date(2026, 5, 10)

#: One figure, carried by the invoice and by nothing else, so an amount search has exactly
#: one right answer.
INVOICE_AMOUNT = Decimal("192000000")


@pytest.fixture
async def records(db: AsyncSession) -> dict[str, Any]:
    """One of every searchable kind, each with a name nothing else shares."""
    author = (await db.execute(select(User))).scalars().first()
    assert author is not None, "the reference seed provides users"

    client_row = Client(
        client_no="CL-90", name="Aurora Bank", contact="Ibu Sari", phone="+62811900001"
    )
    vendor = Vendor(vendor_no="V-90", name="Lumina LED", category="Lighting", pic_name="Pak Hendra")
    db.add_all([client_row, vendor])
    await db.flush()

    project = Project(
        project_no="EVT-9001",
        name="Aurora Bank Annual Gala",
        client_id=client_row.id,
        stage_since=DAY,
        contract_value=Decimal("480000000"),
        event_date=DAY,
    )
    db.add(project)
    await db.flush()

    quotation = Quotation(
        quotation_no="QT-9001",
        client_id=client_row.id,
        event_type="Gala Dinner",
        status=QuotationStatus.SENT,
        created_by_user_id=author.id,
        event_date=DAY,
    )
    db.add(quotation)
    await db.flush()
    db.add(
        QuotationLine(
            quotation_id=quotation.id, line_no=1, label="Stage", amount=Decimal("314000000")
        )
    )

    invoice = Invoice(
        invoice_no="INV-9001",
        project_id=project.id,
        type=InvoiceType.DOWN_PAYMENT,
        stage_label="Down Payment",
        amount=INVOICE_AMOUNT,
        status=InvoiceStatus.UNPAID,
        document_date=DAY,
    )
    order = PurchaseOrder(
        po_no="PO-9001",
        vendor_id=vendor.id,
        project_id=project.id,
        status=PoStatus.APPROVED,
        order_date=DAY,
    )
    db.add_all([invoice, order])
    await db.flush()
    db.add(
        PurchaseOrderLine(
            purchase_order_id=order.id,
            line_no=1,
            item_label="Moving head fixtures",
            qty=Decimal("10"),
            unit_price=Decimal("4500000"),
        )
    )

    request = ProcurementRequest(
        request_no="PR-901",
        project_id=project.id,
        category="Crew Meals",
        amount=Decimal("2500000"),
        status=RequestStatus.PENDING,
        requested_by="Pak Budi",
        request_date=DAY,
    )
    item = InventoryItem(
        item_no="IT-90",
        item="Line array speaker",
        type=InventoryType.FIXED_ASSET,
        qty=Decimal("10"),
        unit="unit",
        unit_value=Decimal("12000000"),
        status=InventoryStatus.IN_STOCK,
    )
    asset = FixedAsset(
        asset_no="FA-901",
        name="Projector rig",
        category="AV",
        acquired_on=DAY,
        cost=Decimal("85000000"),
        useful_life_months=48,
        method=Method.STRAIGHT_LINE,
        status=AssetStatus.ACTIVE,
    )
    crew = Crew(
        crew_no="CR-90", name="Rizky Pratama", role="Lighting Op", base_rate=Decimal("750000")
    )
    db.add_all([request, item, asset, crew])
    await db.flush()

    return {
        "client": client_row,
        "vendor": vendor,
        "project": project,
        "quotation": quotation,
        "invoice": invoice,
        "order": order,
        "request": request,
        "item": item,
        "asset": asset,
        "crew": crew,
    }


async def _search(client: AsyncClient, api: str, q: str, **params: Any) -> dict[str, Any]:
    response = await client.get(f"{api}/search", params={"q": q, **params})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


def _kinds(body: dict[str, Any]) -> list[str]:
    return [g["kind"] for g in body["groups"]]


def _ids(body: dict[str, Any], kind: str) -> list[str]:
    for group in body["groups"]:
        if group["kind"] == kind:
            return [h["id"] for h in group["hits"]]
    return []


def _hits(body: dict[str, Any], kind: str) -> list[dict[str, Any]]:
    for group in body["groups"]:
        if group["kind"] == kind:
            return list(group["hits"])
    return []


# ---------------------------------------------------------------------------
# What the old search could not reach
# ---------------------------------------------------------------------------


async def test_it_finds_the_five_kinds_the_old_box_could_not(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """The client's complaint, precisely.

    The previous search read six collections out of the browser's memory, so a purchase
    order, a stock item, a crew member, a fixed asset and a petty-cash request could not be
    found at all — not because of a filter, but because nothing ever looked for them.
    """
    for kind, query, expected in (
        ("purchase_order", "PO-9001", "PO-9001"),
        ("inventory", "Line array", "IT-90"),
        ("crew", "Rizky", "CR-90"),
        ("fixed_asset", "Projector rig", "FA-901"),
        ("procurement", "Crew Meals", "PR-901"),
    ):
        body = await _search(client, api, query)
        assert expected in _ids(body, kind), f"{query!r}: {_kinds(body)}"


async def test_the_older_six_kinds_still_work(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    for kind, query, expected in (
        ("project", "Aurora Bank Annual", "EVT-9001"),
        ("client", "Aurora Bank", "CL-90"),
        ("quotation", "QT-9001", "QT-9001"),
        ("invoice", "INV-9001", "INV-9001"),
        ("vendor", "Lumina", "V-90"),
    ):
        body = await _search(client, api, query)
        assert expected in _ids(body, kind), f"{query!r}: {_kinds(body)}"


async def test_a_journal_entry_is_findable_by_memo_and_by_code(
    client: AsyncClient, api: str
) -> None:
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": DAY.isoformat(),
            "memo": "Searchable marker entry",
            "lines": [
                {"account": "1101", "debit": "7000000"},
                {"account": "4102", "credit": "7000000"},
            ],
        },
    )
    assert posted.status_code == 201, posted.text
    entry = posted.json()

    by_memo = await _search(client, api, "Searchable marker")
    assert entry["entry_no"] in _ids(by_memo, "journal")

    # The voucher number is what is printed on the document and quoted in the filing
    # cabinet, so it is what somebody holding the paper types in.
    by_voucher = await _search(client, api, entry["voucher_no"])
    hits = _hits(by_voucher, "journal")
    assert hits and hits[0]["id"] == entry["entry_no"]
    assert hits[0]["score"] == 100


# ---------------------------------------------------------------------------
# Ranking
# ---------------------------------------------------------------------------


async def test_an_exact_number_outranks_a_prefix(
    client: AsyncClient, api: str, db: AsyncSession, records: dict[str, Any]
) -> None:
    """Ranking happens in SQL for this reason: scoring after a LIMIT would let the exact
    match be cut before it was ever ranked."""
    db.add(
        Project(
            project_no="EVT-90011",
            name="Decoy",
            client_id=records["client"].id,
            stage_since=DAY,
            contract_value=Decimal("1000000"),
        )
    )
    await db.flush()

    body = await _search(client, api, "EVT-9001", limit=25)
    hits = _hits(body, "project")
    assert [h["id"] for h in hits][:1] == ["EVT-9001"], [h["id"] for h in hits]
    assert hits[0]["score"] > hits[1]["score"]


async def test_the_group_holding_the_best_hit_comes_first(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """An exact purchase order must not sit under a fuzzy project name."""
    body = await _search(client, api, "PO-9001")
    assert _kinds(body)[0] == "purchase_order", _kinds(body)


async def test_a_hit_carries_the_key_as_well_as_the_number(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """`id` routes, `uuid` fetches — the same split the rest of the API keeps."""
    body = await _search(client, api, "EVT-9001")
    hit = _hits(body, "project")[0]
    assert hit["uuid"] == str(records["project"].id)
    assert uuid_mod.UUID(hit["uuid"])
    # Money crosses as a string; the scale depends on whether the row came from Postgres or
    # from the identity map, so compare the value rather than its spelling.
    assert Decimal(hit["amount"]) == Decimal("480000000"), hit["amount"]
    assert hit["subtitle"].startswith("Aurora Bank")


# ---------------------------------------------------------------------------
# Amounts
# ---------------------------------------------------------------------------


async def test_an_amount_finds_the_invoice_it_belongs_to(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """Typing the figure finds the document, which is how people look for money."""
    body = await _search(client, api, "192000000", limit=25)
    assert "INV-9001" in _ids(body, "invoice")


async def test_an_amount_matches_within_the_band_but_not_outside_it(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """1% or Rp 1,000,000, whichever is wider. Nobody remembers a figure to the rupiah."""
    near = await _search(client, api, "191100000", limit=25)  # 0.47% under
    assert "INV-9001" in _ids(near, "invoice")

    far = await _search(client, api, "175000000", limit=25)  # 8.9% under
    assert "INV-9001" not in _ids(far, "invoice")


async def test_separators_in_a_pasted_figure_are_ignored(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    body = await _search(client, api, "192.000.000", limit=25)
    assert "INV-9001" in _ids(body, "invoice")


async def test_a_short_number_is_not_read_as_an_amount(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """Three digits is a quantity or a year, not a figure.

    Read as one it would match everything within a million rupiah of it, which on petty
    cash is most of the register.
    """
    body = await _search(client, api, "192", limit=25)
    assert "INV-9001" not in _ids(body, "invoice")


# ---------------------------------------------------------------------------
# Shape and edges
# ---------------------------------------------------------------------------


async def test_a_one_character_query_returns_nothing_rather_than_erroring(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """A search box sends a request per keystroke; the first one is not a mistake."""
    body = await _search(client, api, "a")
    assert body["total"] == 0
    assert body["groups"] == []


async def test_a_wildcard_is_matched_literally(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    """`%` is a LIKE wildcard. Unescaped, `%%` would return the whole database."""
    body = await _search(client, api, "%%")
    assert body["total"] == 0, _kinds(body)


async def test_the_per_kind_limit_is_honoured(
    client: AsyncClient, api: str, db: AsyncSession, records: dict[str, Any]
) -> None:
    for n in range(3):
        db.add(
            Project(
                project_no=f"EVT-920{n}",
                name=f"Aurora Bank Overflow {n}",
                client_id=records["client"].id,
                stage_since=DAY,
                contract_value=Decimal("1000000"),
            )
        )
    await db.flush()

    wide = await _search(client, api, "Aurora Bank", limit=25)
    assert len(_ids(wide, "project")) > 1, "nothing to limit otherwise"

    narrow = await _search(client, api, "Aurora Bank", limit=1)
    for group in narrow["groups"]:
        assert len(group["hits"]) <= 1


async def test_kinds_narrows_the_search(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    body = await _search(client, api, "Aurora Bank", kinds="client")
    assert _kinds(body) == ["client"]


async def test_an_unknown_kind_is_ignored_rather_than_fatal(
    client: AsyncClient, api: str, records: dict[str, Any]
) -> None:
    body = await _search(client, api, "Aurora Bank", kinds="client,unicorns")
    assert _kinds(body) == ["client"]


async def test_search_requires_a_session(anon_client: AsyncClient, api: str) -> None:
    response = await anon_client.get(f"{api}/search", params={"q": "PO-9001"})
    assert response.status_code == 401


async def test_search_only_returns_kinds_the_role_may_open(
    client_for: Any, api: str, records: dict[str, Any], db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
) -> None:  # fmt: skip
    """The search box must not hand out what the screens would refuse. A Team member (workspace
    and chat only) gets nothing; Warehouse sees stock and petty cash, not crew rates or POs."""
    from app.domain.masters.models import Role

    probes = (
        ("purchase_order", "PO-9001"), ("inventory", "Line array"), ("crew", "Rizky"),
        ("fixed_asset", "Projector rig"), ("procurement", "Crew Meals"),
    )  # fmt: skip
    # The reference seed has no Team login (they come from the chat demo seed), so make one.
    from conftest import DEMO_PASSWORD, EMAIL_FOR_ROLE

    from app.seed.users import add_user

    await add_user(db, "team-search@oscenia.co.id", "Team Search", Role.TEAM, DEMO_PASSWORD)
    monkeypatch.setitem(EMAIL_FOR_ROLE, Role.TEAM, "team-search@oscenia.co.id")
    team = await client_for(Role.TEAM)
    for kind, query in probes:
        assert _ids(await _search(team, api, query), kind) == [], f"team found {kind}"
        assert (await _search(team, api, query))["total"] == 0

    warehouse = await client_for(Role.WAREHOUSE)
    assert "IT-90" in _ids(await _search(warehouse, api, "Line array"), "inventory")
    assert "PR-901" in _ids(await _search(warehouse, api, "Crew Meals"), "procurement")
    for kind, query in (
        ("purchase_order", "PO-9001"), ("crew", "Rizky"), ("fixed_asset", "Projector rig"),
    ):  # fmt: skip
        assert _ids(await _search(warehouse, api, query), kind) == [], f"warehouse found {kind}"

    ceo = await client_for(Role.CEO)
    body = await _search(ceo, api, "Rizky")
    assert "CR-90" in _ids(body, "crew"), "the CEO still sees everything"
