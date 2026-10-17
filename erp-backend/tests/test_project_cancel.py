"""W3 — the project and quotation rules the screens depend on once they save for real.

Three behaviours the prototype had in the browser and the server lacked:

* cancelling a project takes its live purchase orders with it, refunds the client when asked
  (even if costs or orders exist), and cancels invoices nobody should still be chasing;
* stepping a project back out of Post-Event Feedback withdraws the client's rating, and with it
  the incentive pool — unless that pool was already paid;
* an accepted quotation that Finance has not converted yet can still be withdrawn.
"""

from __future__ import annotations

from decimal import Decimal

from httpx import AsyncClient
from test_ap import _vendor
from test_ar import _accepted, _balance, _confirmed

D = Decimal


async def _cancel(client: AsyncClient, api: str, project: dict, **body: object):
    return await client.post(f"{api}/projects/{project['id']}/cancel", json=body)


async def _po_on(client: AsyncClient, api: str, project: dict, *, pay_dp: bool) -> dict:
    vendor = await _vendor(client, api)
    order = (
        await client.post(
            f"{api}/purchase-orders",
            json={
                "vendor_id": vendor["id"],
                "project_id": project["id"],
                "order_date": "2026-06-12",
                "lines": [{"item_label": "LED wall", "qty": "10", "unit_price": "2400000"}],
            },
        )
    ).json()
    await client.post(f"{api}/purchase-orders/{order['id']}/approve")
    if pay_dp:
        paid = await client.post(f"{api}/purchase-orders/{order['id']}/pay-dp", json={})
        assert paid.status_code == 200, paid.text
    return order


async def _status_of(client: AsyncClient, api: str, order: dict) -> str:
    return (await client.get(f"{api}/purchase-orders/{order['id']}")).json()["status"]


async def test_cancelling_takes_the_live_orders_with_it(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    order = await _po_on(client, api, project, pay_dp=True)
    assert await _balance(client, api, "5101") != D("0.00")

    r = await _cancel(client, api, project, reason="postponed", refund_dp=False)
    assert r.status_code == 200, r.text
    assert await _status_of(client, api, order) == "Cancelled"
    assert await _balance(client, api, "5101") == D("0.00"), "the order's cost is unwound"
    assert await _balance(client, api, "4101") == D("240000000.00"), "unrefunded revenue stays"


async def test_a_refund_works_even_when_the_project_has_orders(
    client: AsyncClient, api: str
) -> None:
    """The first cut reused undo-down-payment, which refuses once anything else has happened."""
    project = await _confirmed(client, api)
    await _po_on(client, api, project, pay_dp=True)

    r = await _cancel(client, api, project, reason="client left", refund_dp=True)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["cancelled"] is True
    assert await _balance(client, api, "4101") == D("0.00"), "the revenue is reversed"
    assert await _balance(client, api, "1201") == D("0.00"), "nothing is still owed by the client"
    tb = (await client.get(f"{api}/reports/trial-balance", params={"period": "all"})).json()
    assert tb["balanced"] is True


async def test_open_invoices_are_cancelled_and_paid_ones_kept_without_a_refund(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    r = await _cancel(client, api, project, refund_dp=False)
    assert r.status_code == 200
    states = {
        i["stage_no"]: i["status"]
        for i in (await client.get(f"{api}/invoices")).json()
        if i["project_id"] == project["id"]
    }
    assert states[1] == "Paid", "the deposit was paid and is not refunded"
    assert all(v == "Cancelled" for k, v in states.items() if k != 1), states


async def test_a_refund_cancels_every_invoice(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    await _cancel(client, api, project, refund_dp=True)
    states = {
        i["status"]
        for i in (await client.get(f"{api}/invoices")).json()
        if i["project_id"] == project["id"]
    }
    assert states == {"Cancelled"}


async def test_cancelling_twice_is_refused(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    assert (await _cancel(client, api, project)).status_code == 200
    assert (await _cancel(client, api, project)).status_code == 409


# --- stepping back out of feedback -------------------------------------------------------


async def _to_feedback(client: AsyncClient, api: str) -> dict:
    project = await _confirmed(client, api)
    for _ in range(5):
        r = await client.post(f"{api}/projects/{project['id']}/advance-stage")
        assert r.status_code == 200, r.text
    assert r.json()["stage"] == "Post-Event Feedback"
    rated = await client.put(f"{api}/projects/{project['id']}/feedback", json={"score": "9.1"})
    assert rated.status_code == 200, rated.text
    return project


async def _score(client: AsyncClient, api: str, project: dict) -> str | None:
    pool = (await client.get(f"{api}/projects/{project['id']}/incentives")).json()
    return pool["event_score"]


async def test_stepping_back_out_of_feedback_withdraws_the_rating(
    client: AsyncClient, api: str
) -> None:
    project = await _to_feedback(client, api)
    assert await _score(client, api, project) is not None

    r = await client.post(f"{api}/projects/{project['id']}/revert-stage")
    assert r.json()["stage"] == "Execution Event"
    assert await _score(client, api, project) is None, "the rating went with the stage"


async def test_dragging_back_across_the_boundary_withdraws_it_too(
    client: AsyncClient, api: str
) -> None:
    project = await _to_feedback(client, api)
    await client.post(
        f"{api}/projects/{project['id']}/move-to-stage", json={"stage": "Design Uploaded"}
    )
    assert await _score(client, api, project) is None


async def test_moving_between_stages_after_feedback_keeps_the_rating(
    client: AsyncClient, api: str
) -> None:
    project = await _to_feedback(client, api)
    await client.post(f"{api}/projects/{project['id']}/advance-stage")  # -> Finished
    await client.post(f"{api}/projects/{project['id']}/revert-stage")  # -> Post-Event Feedback
    assert await _score(client, api, project) is not None


# --- withdrawing an accepted-but-unconverted quotation ----------------------------------


async def test_an_accepted_quotation_nobody_converted_can_be_declined(
    client: AsyncClient, api: str
) -> None:
    quote = await _accepted(client, api)
    r = await client.post(f"{api}/quotations/{quote['id']}/decline")
    assert r.status_code == 200 and r.json()["status"] == "Declined"


async def test_once_it_is_a_project_the_project_is_cancelled_instead(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    quote_id = next(
        q["id"] for q in (await client.get(f"{api}/quotations")).json() if q["status"] == "Accepted"
    )
    r = await client.post(f"{api}/quotations/{quote_id}/decline")
    assert r.status_code == 409 and "project" in r.text
    assert project["cancelled"] is False
