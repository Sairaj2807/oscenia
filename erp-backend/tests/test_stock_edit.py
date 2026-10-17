"""P8: editing, archiving and deleting stock items.

The rule behind all of it: the ledger holds the value of what is in stock, so an item that has
taken part in anything (a release, a write-off, a fixed-asset record, a delivery order, a
movement) keeps its value and type, cannot be deleted, and is archived instead. An item that
never has been used may be corrected freely and deleted. Quantity is never editable here; only
movements change it.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_ar import _confirmed
from test_incentives import _item

from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role


async def _patch(client: AsyncClient, api: str, target: dict, **body: Any) -> Any:
    return await client.patch(f"{api}/inventory/{target['id']}", json=body)


async def _listed(client: AsyncClient, api: str, *, archived: bool = False) -> dict[str, dict]:
    r = await client.get(f"{api}/inventory", params={"include_archived": archived})
    assert r.status_code == 200, r.text
    return {i["id"]: i for i in r.json()}


async def _do_with(client: AsyncClient, api: str, item: dict) -> dict:
    project = await _confirmed(client, api)
    r = await client.post(
        f"{api}/delivery-orders",
        json={
            "project_id": project["id"],
            "lines": [{"inventory_item_id": item["id"], "qty": "1"}],
        },
    )
    assert r.status_code == 201, r.text
    return r.json()


# --- editing ---------------------------------------------------------------------------------


async def test_an_unused_item_can_be_corrected_in_every_field_but_quantity(
    client: AsyncClient, api: str
) -> None:
    item = await _item(client, api, item="Gafer tape", qty="100", unit_value="50000")
    r = await _patch(client, api, item, item="Gaffer tape", unit="roll", unit_value="65000")
    assert r.status_code == 200, r.text
    got = r.json()
    assert got["item"] == "Gaffer tape" and got["unit_value"] == "65000.00"
    assert got["qty"] == "100.00", "quantity is untouched"
    assert got["total_value"] == "6500000.00", "the total follows the corrected value"

    r = await _patch(client, api, item, type="Fixed Asset")
    assert r.status_code == 200 and r.json()["type"] == "Fixed Asset"


async def test_quantity_cannot_be_set_by_an_edit(client: AsyncClient, api: str) -> None:
    item = await _item(client, api, qty="100")
    r = await _patch(client, api, item, qty="5")
    assert r.status_code == 422, "an unknown field is refused, not ignored"
    assert (await _listed(client, api))[item["id"]]["qty"] == "100.00"


async def test_a_unit_can_be_cleared_but_a_name_cannot_be_blanked(
    client: AsyncClient, api: str
) -> None:
    item = await _item(client, api, unit="roll")
    assert (await _patch(client, api, item, unit=None)).json()["unit"] is None
    assert (await _patch(client, api, item, item="")).status_code == 422


async def test_value_and_type_lock_after_a_release_but_the_name_stays_editable(
    client: AsyncClient, api: str
) -> None:
    item = await _item(client, api, qty="100", unit_value="50000")
    released = await client.post(f"{api}/inventory/{item['id']}/release", json={"qty": "10"})
    assert released.status_code == 200 and released.json()["voucher_no"], "a release posts"

    locked = await _patch(client, api, item, unit_value="1")
    assert locked.status_code == 409 and "ledger" in locked.text and "unit value" in locked.text
    assert (await _patch(client, api, item, type="Fixed Asset")).status_code == 409
    # Saying the same value again is not a change.
    assert (await _patch(client, api, item, unit_value="50000")).status_code == 200
    assert (await _patch(client, api, item, item="Gaffer tape (black)")).status_code == 200


async def test_value_locks_once_the_item_is_on_the_fixed_asset_register(
    client: AsyncClient, api: str
) -> None:
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="2", unit_value="9000000"
    )
    made = await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "LED Wall",
            "acquired_on": "2026-01-01",
            "cost": "18000000",
            "useful_life_months": 36,
            "inventory_item_id": item["id"],
            "post": False,
        },
    )
    assert made.status_code == 201, made.text
    locked = await _patch(client, api, item, unit_value="1")
    assert locked.status_code == 409 and "fixed-asset" in locked.text


async def test_value_locks_once_the_item_is_on_a_delivery_order(
    client: AsyncClient, api: str
) -> None:
    item = await _item(client, api, item="Truss", type="Fixed Asset", qty="4", unit_value="1000")
    await _do_with(client, api, item)
    locked = await _patch(client, api, item, unit_value="2000")
    assert locked.status_code == 409 and "delivery order" in locked.text


async def test_an_edit_is_audited_with_what_changed(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    item = await _item(client, api, item="Old name")
    await _patch(client, api, item, item="New name")
    row = (
        await db.execute(
            select(AuditEvent).where(
                AuditEvent.entity_id == str(item["id"]), AuditEvent.action == "inventory.edit"
            )
        )
    ).scalar_one()
    assert row.before == {"item": "Old name"} and row.after == {"item": "New name"}


# --- archiving -------------------------------------------------------------------------------


async def test_an_archived_item_leaves_the_list_but_not_the_database(
    client: AsyncClient, api: str
) -> None:
    item = await _item(client, api)
    r = await client.post(f"{api}/inventory/{item['id']}/archive")
    assert r.status_code == 200 and r.json()["archived_at"] is not None

    assert item["id"] not in await _listed(client, api)
    assert item["id"] in await _listed(client, api, archived=True)
    # Idempotent: archiving twice is not an error and does not move the date.
    again = await client.post(f"{api}/inventory/{item['id']}/archive")
    assert again.status_code == 200 and again.json()["archived_at"] == r.json()["archived_at"]


async def test_an_archived_item_cannot_be_moved_edited_or_put_on_an_order(
    client: AsyncClient, api: str
) -> None:
    consumable = await _item(client, api, qty="10")
    asset = await _item(client, api, item="Speaker", type="Fixed Asset", qty="2", unit_value="1")
    for it in (consumable, asset):
        await client.post(f"{api}/inventory/{it['id']}/archive")

    release = await client.post(f"{api}/inventory/{consumable['id']}/release", json={"qty": "1"})
    assert release.status_code == 409 and "archived" in release.text
    project = await _confirmed(client, api)
    out = await client.post(
        f"{api}/inventory/{asset['id']}/check-out",
        json={"project_id": project["id"], "event_date": "2030-01-01"},
    )
    assert out.status_code == 409 and "archived" in out.text
    assert (await _patch(client, api, consumable, item="x")).status_code == 409
    order = await client.post(
        f"{api}/delivery-orders",
        json={
            "project_id": project["id"],
            "lines": [{"inventory_item_id": asset["id"], "qty": "1"}],
        },
    )
    assert order.status_code == 409 and "archived" in order.text


async def test_an_item_can_be_restored(client: AsyncClient, api: str) -> None:
    item = await _item(client, api)
    await client.post(f"{api}/inventory/{item['id']}/archive")
    r = await client.post(f"{api}/inventory/{item['id']}/unarchive")
    assert r.status_code == 200 and r.json()["archived_at"] is None
    assert item["id"] in await _listed(client, api)
    assert (await _patch(client, api, item, item="Back again")).status_code == 200


async def test_an_item_out_at_an_event_or_on_an_open_order_cannot_be_archived(
    client: AsyncClient, api: str
) -> None:
    out = await _item(client, api, item="Camera", type="Fixed Asset", qty="1", unit_value="1")
    project = await _confirmed(client, api)
    await client.post(
        f"{api}/inventory/{out['id']}/check-out",
        json={"project_id": project["id"], "event_date": "2030-01-01"},
    )
    refused = await client.post(f"{api}/inventory/{out['id']}/archive")
    assert refused.status_code == 409 and "in transit" in refused.text

    listed = await _item(client, api, item="Rigging", type="Fixed Asset", qty="1", unit_value="1")
    order = await _do_with(client, api, listed)
    refused = await client.post(f"{api}/inventory/{listed['id']}/archive")
    assert refused.status_code == 409 and order["do_no"] in refused.text


# --- deleting --------------------------------------------------------------------------------


async def test_a_never_used_item_can_be_deleted(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    item = await _item(client, api, item="Typo item")
    r = await client.delete(f"{api}/inventory/{item['id']}")
    assert r.status_code == 204
    assert item["id"] not in await _listed(client, api, archived=True)
    row = (
        await db.execute(
            select(AuditEvent).where(
                AuditEvent.entity_id == str(item["id"]), AuditEvent.action == "inventory.delete"
            )
        )
    ).scalar_one()
    assert row.detail and row.detail["item"] == "Typo item"
    assert (await client.delete(f"{api}/inventory/{item['id']}")).status_code == 404


async def test_a_used_item_cannot_be_deleted_and_is_told_to_archive(
    client: AsyncClient, api: str
) -> None:
    released = await _item(client, api, qty="10")
    await client.post(f"{api}/inventory/{released['id']}/release", json={"qty": "1"})
    refused = await client.delete(f"{api}/inventory/{released['id']}")
    assert refused.status_code == 409 and "Archive it instead" in refused.text
    assert released["id"] in await _listed(client, api)

    ordered = await _item(client, api, item="Truss", type="Fixed Asset", qty="4", unit_value="1")
    await _do_with(client, api, ordered)
    assert (await client.delete(f"{api}/inventory/{ordered['id']}")).status_code == 409


async def test_an_unknown_item_is_a_404(client: AsyncClient, api: str) -> None:
    ghost = str(uuid.uuid4())
    assert (await client.patch(f"{api}/inventory/{ghost}", json={"item": "x"})).status_code == 404
    assert (await client.post(f"{api}/inventory/{ghost}/archive")).status_code == 404
    assert (await client.delete(f"{api}/inventory/{ghost}")).status_code == 404


# --- who may ---------------------------------------------------------------------------------


@pytest.mark.parametrize("role", [Role.SALES, Role.FINANCE])
async def test_only_roles_that_manage_stock_may_edit_archive_or_delete(
    client: AsyncClient, client_for, api: str, role: Role
) -> None:
    item = await _item(client, api)
    other = await client_for(role)
    for call in (
        other.patch(f"{api}/inventory/{item['id']}", json={"item": "x"}),
        other.post(f"{api}/inventory/{item['id']}/archive"),
        other.post(f"{api}/inventory/{item['id']}/unarchive"),
        other.delete(f"{api}/inventory/{item['id']}"),
    ):
        r = await call
        assert r.status_code == 403 and r.json()["action"] == "manage_stock"


async def test_the_warehouse_may(client: AsyncClient, client_for, api: str) -> None:
    item = await _item(client, api)
    warehouse = await client_for(Role.WAREHOUSE)
    assert (
        await warehouse.patch(f"{api}/inventory/{item['id']}", json={"item": "Renamed"})
    ).status_code == 200
    assert (await warehouse.post(f"{api}/inventory/{item['id']}/archive")).status_code == 200
