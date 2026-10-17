"""W3 — a venue return can be mixed: some good, some damaged, some lost.

The prototype splits one returning quantity into up to three rows (good stays in stock, damaged goes
to maintenance as its own row, lost is written off). The server took a single condition for the
whole row, so the warehouse screen could not be wired without losing the split.
"""

from __future__ import annotations

from decimal import Decimal

from httpx import AsyncClient
from test_incentives import _balance, _item, _stock

D = Decimal


async def _rows(client: AsyncClient, api: str, name: str) -> list[dict]:
    rows = (await client.get(f"{api}/inventory")).json()
    return sorted((r for r in rows if r["item"] == name), key=lambda r: r["item_no"])


async def test_a_mixed_return_splits_into_stock_and_maintenance_and_writes_off_the_lost(
    client: AsyncClient, api: str
) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="Truss set", type="Fixed Asset", qty="10", unit_value="8000000"
    )

    r = await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "good", "lost_qty": "1", "damaged_qty": "3"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["entry_id"] is not None, "the lost unit is written off"

    good, damaged = await _rows(client, api, "Truss set")
    assert (good["status"], D(good["qty"])) == ("in_stock", D("6"))
    assert (damaged["status"], D(damaged["qty"])) == ("maintenance", D("3"))
    assert await _balance(client, api, "6901") == D("8000000")


async def test_when_everything_that_came_back_is_damaged_the_row_itself_goes_to_maintenance(
    client: AsyncClient, api: str
) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="Truss set", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "good", "damaged_qty": "4"},
    )
    rows = await _rows(client, api, "Truss set")
    assert len(rows) == 1 and rows[0]["status"] == "maintenance"


async def test_more_than_went_out_is_refused_and_nothing_changes(
    client: AsyncClient, api: str
) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="Truss set", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    r = await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "good", "lost_qty": "2", "damaged_qty": "3"},
    )
    assert r.status_code == 422
    rows = await _rows(client, api, "Truss set")
    assert len(rows) == 1 and D(rows[0]["qty"]) == D("4")


async def test_a_return_without_damage_behaves_as_before(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="Truss set", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    r = await client.post(f"{api}/inventory/{item['id']}/return", json={"condition": "good"})
    assert r.json()["entry_id"] is None
    rows = await _rows(client, api, "Truss set")
    assert len(rows) == 1 and rows[0]["status"] == "in_stock" and D(rows[0]["qty"]) == D("4")


async def test_losing_everything_writes_the_row_off(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="Truss set", type="Fixed Asset", qty="2", unit_value="8000000"
    )
    r = await client.post(
        f"{api}/inventory/{item['id']}/return", json={"condition": "good", "lost_qty": "2"}
    )
    assert r.status_code == 200, r.text
    rows = await _rows(client, api, "Truss set")
    assert len(rows) == 1 and rows[0]["status"] == "written_off" and D(rows[0]["qty"]) == D("0")
    assert await _balance(client, api, "6901") == D("16000000")
