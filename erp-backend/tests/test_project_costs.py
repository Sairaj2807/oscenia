"""W4 — the itemised cost lines behind a project's cost figure.

The project page lists every cost line and says the list adds up to the project's cost, so these
check that it does: only project cost accounts, only this project, reversals kept as negatives, and
the sum equal to the P&L's own cost figure (the two must never disagree).
"""

from __future__ import annotations

from decimal import Decimal

from httpx import AsyncClient
from test_ar import _confirmed

D = Decimal


async def _cost(
    client: AsyncClient, api: str, project: dict | None, account: str, amount: str, **kw
):
    body = {
        "entry_date": kw.pop("on", "2026-06-01"),
        "memo": kw.pop("memo", "cost"),
        "lines": [
            {"account": account, "debit": amount, "note": "the line"},
            {"account": "2102", "credit": amount},
        ],
        "source": {"kind": "po", "ref": kw.pop("ref", "PO-X")},
    }
    if project is not None:
        body["project_id"] = project["id"]
    r = await client.post(f"{api}/journal-entries", json=body)
    assert r.status_code == 201, r.text
    return r.json()


async def _lines(client: AsyncClient, api: str, project: dict) -> list[dict]:
    r = await client.get(f"{api}/reports/project-costs", params={"project_id": project["id"]})
    assert r.status_code == 200, r.text
    return r.json()


async def test_only_this_projects_cost_account_lines_are_listed_newest_first(
    client: AsyncClient, api: str
) -> None:
    mine = await _confirmed(client, api)
    await _cost(client, api, mine, "5101", "1000000", on="2026-06-01", memo="older")
    await _cost(client, api, mine, "6901", "250000", on="2026-06-20", memo="asset loss")
    await _cost(client, api, mine, "6101", "999", memo="overhead is not a project cost")
    await _cost(client, api, None, "5101", "777", memo="no project at all")

    lines = await _lines(client, api, mine)
    assert [(ln["memo"], ln["account_code"], ln["amount"]) for ln in lines] == [
        ("asset loss", "6901", "250000.00"),
        ("older", "5101", "1000000.00"),
    ]
    assert lines[0]["note"] == "the line" and lines[0]["source_kind"] == "po"
    assert lines[0]["is_reversal"] is False and lines[0]["is_reversed"] is False


async def test_a_reversed_cost_nets_to_zero_and_is_flagged(client: AsyncClient, api: str) -> None:
    mine = await _confirmed(client, api)
    entry = await _cost(client, api, mine, "5101", "500000")
    r = await client.post(f"{api}/journal-entries/{entry['id']}/reverse")
    assert r.status_code in (200, 201), r.text

    lines = await _lines(client, api, mine)
    assert sorted(ln["amount"] for ln in lines) == ["-500000.00", "500000.00"]
    assert {(ln["is_reversal"], ln["is_reversed"]) for ln in lines} == {
        (True, False),
        (False, True),
    }


async def test_the_lines_add_up_to_the_projects_cost(client: AsyncClient, api: str) -> None:
    mine = await _confirmed(client, api)
    await _cost(client, api, mine, "5101", "1000000")
    entry = await _cost(client, api, mine, "5101", "300000")
    await client.post(f"{api}/journal-entries/{entry['id']}/reverse")
    await _cost(client, api, mine, "6901", "40000")

    total = sum(D(ln["amount"]) for ln in await _lines(client, api, mine))
    pnl = (
        await client.get(
            f"{api}/reports/project-pnl", params={"project_id": mine["id"], "period": "all"}
        )
    ).json()
    assert total == D(pnl["cost"]) == D("1040000.00")


async def test_a_project_with_no_costs_has_an_empty_list(client: AsyncClient, api: str) -> None:
    mine = await _confirmed(client, api)
    assert await _lines(client, api, mine) == []
