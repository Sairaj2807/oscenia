"""Backlog item 1 — renaming a tag and editing a catalogue line's tags.

The vendor screens could create and delete tags but not rename them, and tag a vendor but not an
item. The rename must keep the id (every vendor and item already points at it), and an item's tags
are replaced as a whole, like a vendor's.
"""

from __future__ import annotations

from decimal import Decimal

from httpx import AsyncClient
from test_ap import _item, _vendor

D = Decimal


async def _tag(client: AsyncClient, api: str, tag_id: str, label: str) -> dict:
    r = await client.post(f"{api}/tags", json={"id": tag_id, "label": label})
    assert r.status_code == 201, r.text
    return r.json()


async def test_renaming_a_tag_changes_the_label_and_keeps_everything_tagged(
    client: AsyncClient, api: str
) -> None:
    await _tag(client, api, "staging", "Staging")
    vendor = await _vendor(client, api, tags=["staging"])

    r = await client.patch(f"{api}/tags/staging", json={"label": "  Staging & Truss  "})
    assert r.status_code == 200, r.text
    assert r.json() == {"id": "staging", "label": "Staging & Truss"}

    after = (await client.get(f"{api}/vendors/{vendor['id']}")).json()
    assert [t["id"] if isinstance(t, dict) else t for t in after["tags"]] == ["staging"]
    labels = {t["id"]: t["label"] for t in (await client.get(f"{api}/tags")).json()}
    assert labels["staging"] == "Staging & Truss"


async def test_renaming_an_unknown_tag_is_a_404_and_a_blank_label_is_refused(
    client: AsyncClient, api: str
) -> None:
    assert (await client.patch(f"{api}/tags/nope", json={"label": "X"})).status_code == 404
    await _tag(client, api, "lighting", "Lighting")
    assert (await client.patch(f"{api}/tags/lighting", json={"label": "   "})).status_code == 422
    assert (await client.patch(f"{api}/tags/lighting", json={"label": ""})).status_code == 422
    still = {t["id"]: t["label"] for t in (await client.get(f"{api}/tags")).json()}
    assert still["lighting"] == "Lighting"


async def test_a_catalogue_items_tags_are_replaced_as_a_whole(
    client: AsyncClient, api: str
) -> None:
    await _tag(client, api, "led", "LED")
    await _tag(client, api, "visual", "Visual")
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"])

    r = await client.patch(f"{api}/vendor-catalogue/{item['id']}", json={"tags": ["led", "visual"]})
    assert r.status_code == 200, r.text
    assert sorted(t["id"] for t in r.json()["tags"]) == ["led", "visual"]

    r = await client.patch(f"{api}/vendor-catalogue/{item['id']}", json={"tags": ["led"]})
    assert [t["id"] for t in r.json()["tags"]] == ["led"]

    r = await client.patch(f"{api}/vendor-catalogue/{item['id']}", json={"tags": []})
    assert r.json()["tags"] == []


async def test_a_catalogue_edit_can_correct_the_description_and_price_but_not_the_stock(
    client: AsyncClient, api: str
) -> None:
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"], stock="320", price="2400000")

    r = await client.patch(
        f"{api}/vendor-catalogue/{item['id']}",
        json={"item": "LED wall (per m2, 2.6mm)", "unit_price": "2500000", "stock": "1"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["item"] == "LED wall (per m2, 2.6mm)"
    assert D(body["unit_price"]) == D("2500000")
    assert D(body["stock"]) == D("320"), "stock is not editable here: it would oversell booked kit"


async def test_unknown_tags_items_and_bad_prices_are_refused(client: AsyncClient, api: str) -> None:
    vendor = await _vendor(client, api)
    item = await _item(client, api, vendor["id"])
    ghost = "00000000-0000-0000-0000-000000000000"

    assert (
        await client.patch(f"{api}/vendor-catalogue/{item['id']}", json={"tags": ["ghost"]})
    ).status_code == 404
    assert (
        await client.patch(f"{api}/vendor-catalogue/{ghost}", json={"tags": []})
    ).status_code == 404
    assert (
        await client.patch(f"{api}/vendor-catalogue/{item['id']}", json={"unit_price": "-1"})
    ).status_code == 422
