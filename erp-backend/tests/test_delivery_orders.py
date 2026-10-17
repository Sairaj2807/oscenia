"""Backlog item 7 — delivery orders.

A delivery order is the paperwork that goes with kit to an event: what is going, for which
project, Draft -> Dispatched (signed) -> Received. It is a document, not a stock movement: none
of these tests expects stock to change, because the order does not touch it (that scope is the
open client question).
"""

from __future__ import annotations

import io
import uuid

import pytest
from httpx import AsyncClient
from PIL import Image
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from test_ar import _confirmed
from test_incentives import _item

from app.domain.audit.models import AuditEvent
from app.domain.masters.models import Role


def _png(size: tuple[int, int] = (300, 120)) -> bytes:
    """A small drawn-looking PNG, the way the signature pad produces one."""
    out = io.BytesIO()
    image = Image.new("RGBA", size, (255, 255, 255, 0))
    for x in range(20, size[0] - 20):
        image.putpixel((x, size[1] // 2 + (x % 9)), (0, 0, 80, 255))
    image.save(out, "PNG")
    return out.getvalue()


async def _sign(client: AsyncClient, api: str, order: dict, *, name: str = "Pak Hendra") -> dict:
    r = await client.put(
        f"{api}/delivery-orders/{order['id']}/signature",
        data={"signed_by_name": name},
        files={"file": ("signature.png", _png(), "image/png")},
    )
    assert r.status_code == 200, r.text
    return r.json()


async def _order(client: AsyncClient, api: str, project: dict, lines: list[dict]) -> dict:
    r = await client.post(
        f"{api}/delivery-orders", json={"project_id": project["id"], "lines": lines}
    )
    assert r.status_code == 201, r.text
    return r.json()


async def test_a_new_order_is_a_draft_with_a_number_and_the_projects_event_date(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    stock = await _item(client, api, item="LED Wall", type="Fixed Asset", qty="8", unit_value="1")

    order = await _order(
        client,
        api,
        project,
        [{"inventory_item_id": stock["id"], "qty": "4"}, {"item": "Cable ramps", "qty": "6"}],
    )
    assert order["do_no"].startswith("DO-") and order["status"] == "Draft"
    assert order["signed"] is False and order["dispatched_on"] is None
    assert order["event_date"] == project["event_date"]
    assert [(ln["line_no"], ln["item_label"], ln["qty"]) for ln in order["lines"]] == [
        (1, "LED Wall", "4.00"),
        (2, "Cable ramps", "6.00"),
    ]
    # It is a document: the stock it names is where it was.
    after = {i["id"]: i for i in (await client.get(f"{api}/inventory")).json()}
    assert after[stock["id"]]["status"] == "in_stock" and after[stock["id"]]["qty"] == "8.00"


async def test_dispatching_signs_it_and_receiving_closes_it(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    await _sign(client, api, order)

    sent = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert sent.status_code == 200, sent.text
    assert sent.json()["status"] == "Dispatched" and sent.json()["signed"] is True
    assert sent.json()["dispatched_on"] is not None and sent.json()["received_on"] is None

    got = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert got.json()["status"] == "Received" and got.json()["received_on"] is not None

    again = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert again.status_code == 409 and "received" in again.text


async def test_the_list_is_newest_first(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    first = await _order(client, api, project, [{"item": "A", "qty": "1"}])
    second = await _order(client, api, project, [{"item": "B", "qty": "1"}])
    listed = [o["do_no"] for o in (await client.get(f"{api}/delivery-orders")).json()]
    assert listed.index(second["do_no"]) < listed.index(first["do_no"])


async def test_what_cannot_be_ordered_is_refused_and_nothing_is_made(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    ghost = str(uuid.uuid4())
    before = len((await client.get(f"{api}/delivery-orders")).json())

    def post(body: dict):
        return client.post(f"{api}/delivery-orders", json=body)

    assert (await post({"project_id": project["id"], "lines": []})).status_code == 422
    assert (
        await post({"project_id": project["id"], "lines": [{"item": "x", "qty": "0"}]})
    ).status_code == 422
    assert (
        await post({"project_id": project["id"], "lines": [{"qty": "1"}]})
    ).status_code == 422, "a line needs a stock item or a description"
    assert (
        await post(
            {"project_id": project["id"], "lines": [{"inventory_item_id": ghost, "qty": "1"}]}
        )
    ).status_code == 404
    assert (
        await post({"project_id": ghost, "lines": [{"item": "x", "qty": "1"}]})
    ).status_code == 404
    assert len((await client.get(f"{api}/delivery-orders")).json()) == before


async def test_kit_cannot_be_sent_to_a_cancelled_project(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    await client.post(f"{api}/projects/{project['id']}/cancel", json={"refund_dp": False})
    r = await client.post(
        f"{api}/delivery-orders",
        json={"project_id": project["id"], "lines": [{"item": "x", "qty": "1"}]},
    )
    assert r.status_code == 409 and "cancelled" in r.text


@pytest.mark.parametrize("role", [Role.FINANCE, Role.PM, Role.SALES])
async def test_only_the_warehouse_and_the_ceo_may_draft_or_progress_an_order(
    client: AsyncClient, client_for, api: str, role: Role
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "1"}])
    other = await client_for(role)

    made = await other.post(
        f"{api}/delivery-orders",
        json={"project_id": project["id"], "lines": [{"item": "x", "qty": "1"}]},
    )
    assert made.status_code == 403 and made.json()["action"] == "manage_do"
    assert (await other.post(f"{api}/delivery-orders/{order['id']}/advance")).status_code == 403
    assert (await other.get(f"{api}/delivery-orders")).status_code == 200, "anyone may read them"


async def test_the_warehouse_can_do_it(client: AsyncClient, client_for, api: str) -> None:
    project = await _confirmed(client, api)
    warehouse = await client_for(Role.WAREHOUSE)
    r = await warehouse.post(
        f"{api}/delivery-orders",
        json={"project_id": project["id"], "lines": [{"item": "Truss", "qty": "3"}]},
    )
    assert r.status_code == 201, r.text
    await _sign(warehouse, api, r.json())
    adv = await warehouse.post(f"{api}/delivery-orders/{r.json()['id']}/advance")
    assert adv.status_code == 200 and adv.json()["status"] == "Dispatched"


# --- the signature ---------------------------------------------------------------------------


async def test_dispatch_is_refused_until_the_recipient_has_signed(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])

    refused = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert refused.status_code == 409 and "signature" in refused.text
    assert (await client.get(f"{api}/delivery-orders")).json()[0]["status"] == "Draft"

    signed = await _sign(client, api, order, name="  Pak   Hendra ")
    assert signed["has_signature"] is True and signed["signed_by_name"] == "Pak Hendra"
    assert signed["signed_at"] is not None
    assert signed["status"] == "Draft", "signing is not dispatching"
    assert "signature_key" not in signed and "storage_key" not in signed

    sent = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert sent.status_code == 200 and sent.json()["signed"] is True


async def test_a_signature_can_be_redrawn_until_dispatch_and_is_final_after(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    await _sign(client, api, order, name="First")
    again = await _sign(client, api, order, name="Second")
    assert again["signed_by_name"] == "Second"

    await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    late = await client.put(
        f"{api}/delivery-orders/{order['id']}/signature",
        data={"signed_by_name": "Third"},
        files={"file": ("s.png", _png(), "image/png")},
    )
    assert late.status_code == 409 and "final" in late.text


async def test_the_signature_picture_comes_back_as_a_png_to_the_warehouse_only(
    client: AsyncClient, client_for, api: str
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    url = f"{api}/delivery-orders/{order['id']}/signature"

    assert (await client.get(url)).status_code == 404, "no signature yet"
    await _sign(client, api, order)
    got = await client.get(url)
    assert got.status_code == 200 and got.headers["content-type"] == "image/png"
    assert got.content[:8] == b"\x89PNG\r\n\x1a\n"
    assert "no-store" in got.headers["cache-control"]

    other = await client_for(Role.SALES)  # signed in, but no warehouse module
    assert (await other.get(url)).status_code == 404


@pytest.mark.parametrize(
    ("filename", "content_type", "payload"),
    [
        ("sig.png", "image/png", b"not a picture at all"),
        ("sig.exe", "image/png", _png()),
        ("sig.svg", "image/svg+xml", b"<svg xmlns='http://www.w3.org/2000/svg'/>"),
        ("sig.jpg", "image/jpeg", b"\xff\xd8\xff\xe0" + bytes(100)),
        ("sig.png", "image/png", b""),
    ],
)
async def test_only_a_real_png_is_accepted_as_a_signature(
    client: AsyncClient, api: str, filename: str, content_type: str, payload: bytes
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    r = await client.put(
        f"{api}/delivery-orders/{order['id']}/signature",
        data={"signed_by_name": "Pak Hendra"},
        files={"file": (filename, payload, content_type)},
    )
    assert r.status_code in (400, 422), r.text
    assert (await client.get(f"{api}/delivery-orders")).json()[0]["has_signature"] is False


async def test_a_signature_needs_a_name_and_the_right_role(
    client: AsyncClient, client_for, api: str
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    nameless = await client.put(
        f"{api}/delivery-orders/{order['id']}/signature",
        data={"signed_by_name": "   "},
        files={"file": ("s.png", _png(), "image/png")},
    )
    assert nameless.status_code in (400, 422)

    other = await client_for(Role.SALES)
    forbidden = await other.put(
        f"{api}/delivery-orders/{order['id']}/signature",
        data={"signed_by_name": "x"},
        files={"file": ("s.png", _png(), "image/png")},
    )
    assert forbidden.status_code == 403 and forbidden.json()["action"] == "manage_do"


async def test_the_company_setting_allows_an_unsigned_dispatch_and_says_so(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    assert (await client.get(f"{api}/settings")).json()["allow_unsigned_dispatch"] is False

    on = await client.patch(f"{api}/settings", json={"allow_unsigned_dispatch": True})
    assert on.status_code == 200 and on.json()["allow_unsigned_dispatch"] is True
    sent = await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    assert sent.status_code == 200
    assert sent.json()["status"] == "Dispatched"
    assert sent.json()["signed"] is False, "an unsigned dispatch must not claim to be signed"


async def test_signing_and_dispatching_are_in_the_audit_log(
    client: AsyncClient, api: str, db: AsyncSession
) -> None:
    project = await _confirmed(client, api)
    order = await _order(client, api, project, [{"item": "Truss", "qty": "2"}])
    await _sign(client, api, order)
    await client.post(f"{api}/delivery-orders/{order['id']}/advance")
    actions = set(
        (
            await db.execute(
                select(AuditEvent.action).where(AuditEvent.entity_id == str(order["id"]))
            )
        ).scalars()
    )
    assert {"delivery_order.sign", "delivery_order.advance"} <= actions
