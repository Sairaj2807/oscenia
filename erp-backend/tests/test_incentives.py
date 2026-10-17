"""Phase 7 — crew incentives and the warehouse postings that reach the ledger.

Ports ``verify-flows.mjs`` §6 (a client rating recalculates the pool), §40 and §41 (the
project tag is mandatory, and disbursement is idempotent), and §3 (the dual-logic warehouse:
consumables are expensed on release, fixed assets are written down at book value).

The single most important assertion here is the negative one: disbursing without a project
tag is refused **with nothing posted**. It was optional in the prototype and posting
``project: null`` meant the bonus landed on no P&L at all — the word "mandatory" in the
client's deck is the whole point.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from httpx import AsyncClient

from app.core.money import ZERO
from app.domain.ar.models import Stage
from app.domain.masters.models import Role

pytestmark = pytest.mark.phase7

D = Decimal


async def _fund(client: AsyncClient, api: str, amount: str = "900000000") -> None:
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2025-12-01",
            "memo": "Opening capital",
            "source": {"kind": "opening", "ref": "FY2026"},
            "lines": [
                {"account": "1101", "debit": amount},
                {"account": "3102", "credit": amount},
            ],
        },
    )
    assert posted.status_code == 201, posted.text


async def _stock(client: AsyncClient, api: str, amount: str = "900000000") -> None:
    """Open the books with consumables and equipment already on the balance sheet."""
    posted = await client.post(
        f"{api}/journal-entries",
        json={
            "entry_date": "2025-12-01",
            "memo": "Opening stock",
            "source": {"kind": "opening", "ref": "FY2026-STOCK"},
            "lines": [
                {"account": "1301", "debit": "50000000"},
                {"account": "1302", "debit": "640000000"},
                {"account": "3102", "credit": "690000000"},
            ],
        },
    )
    assert posted.status_code == 201, posted.text


async def _balance(client: AsyncClient, api: str, code: str) -> Decimal:
    body = (
        await client.get(f"{api}/reports/general-ledger", params={"codes": [code], "period": "all"})
    ).json()
    return Decimal(body["closing"])


async def _crew(client: AsyncClient, api: str, name: str, rate: str, rating: str) -> dict:
    response = await client.post(
        f"{api}/crew", json={"name": name, "base_rate": rate, "last_rating": rating}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _item(client: AsyncClient, api: str, **overrides: object) -> dict:
    body: dict[str, object] = {
        "item": "Gaffer tape",
        "type": "Consumable",
        "qty": "100",
        "unit": "roll",
        "unit_value": "50000",
    }
    body.update(overrides)
    response = await client.post(f"{api}/inventory", json=body)
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# The pool
# ---------------------------------------------------------------------------


async def test_the_pool_is_base_rate_times_rating_over_ten(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project()
    await _crew(client, api, "Bagus", "5000000", "8")

    pool = (await client.get(f"{api}/projects/{project}/incentives")).json()

    assert pool["rows"][0]["bonus"] == "4000000.00", "5,000,000 × 8/10"
    assert pool["rows"][0]["total"] == "9000000.00", "base plus bonus"
    assert pool["pool"] == "4000000.00"


async def test_crew_below_the_threshold_earn_nothing(
    client: AsyncClient, api: str, make_project
) -> None:
    """The policy default is 7.0 out of 10, and it is editable rather than hardcoded."""
    project = await make_project()
    await _crew(client, api, "Bagus", "5000000", "8")
    await _crew(client, api, "Sari", "4000000", "6.5")

    pool = (await client.get(f"{api}/projects/{project}/incentives")).json()

    by_name = {row["name"]: row for row in pool["rows"]}
    assert by_name["Bagus"]["qualifies"] is True
    assert by_name["Sari"]["qualifies"] is False
    assert by_name["Sari"]["bonus"] == "0.00"
    assert pool["below_threshold"] == 1
    assert pool["pool"] == "4000000.00", "only the qualifying bonus is in the pool"


async def test_a_client_rating_rescores_everybody(
    client: AsyncClient, api: str, make_project
) -> None:
    """Flow §6.

    Before the event each crew member is shown against their own last rating; once the client
    has rated the event, everyone is paid on that one score. That is what "performance
    bonuses updated from client rating" means on the Payroll screen.
    """
    project = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    await _crew(client, api, "Bagus", "5000000", "8")
    await _crew(client, api, "Sari", "4000000", "6.5")

    before = (await client.get(f"{api}/projects/{project}/incentives")).json()
    assert before["event_score"] is None
    assert {row["rating"] for row in before["rows"]} == {"8.0", "6.5"}

    after = (await client.put(f"{api}/projects/{project}/feedback", json={"score": "9.2"})).json()

    assert after["event_score"] == "9.2"
    assert {row["rating"] for row in after["rows"]} == {"9.2"}
    assert after["below_threshold"] == 0, "9.2 clears the threshold for everyone"
    assert after["pool"] == "8280000.00", "(5,000,000 + 4,000,000) × 9.2/10"


async def test_a_re_rating_replaces_rather_than_averages(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    await _crew(client, api, "Bagus", "5000000", "8")

    await client.put(f"{api}/projects/{project}/feedback", json={"score": "9.2"})
    again = await client.put(f"{api}/projects/{project}/feedback", json={"score": "7.5"})

    assert again.status_code == 200, again.text
    assert again.json()["event_score"] == "7.5"
    assert again.json()["pool"] == "3750000.00"


# ---------------------------------------------------------------------------
# Disbursement
# ---------------------------------------------------------------------------


async def test_disbursing_without_a_project_tag_is_refused_and_posts_nothing(
    client: AsyncClient, api: str, make_project
) -> None:
    """Flow §40 — the assertion this whole feature turns on.

    Without a tag the bonus lands on no project P&L at all, which is why the client's deck
    calls the Project ID mandatory. Refusing is the point of the word.
    """
    await _fund(client, api)
    await make_project()  # a real project exists; it is simply not named on the request
    await _crew(client, api, "Bagus", "5000000", "8")
    before = await _balance(client, api, "5102")

    refused = await client.post(f"{api}/incentives/disburse", json={"amount": "4000000"})

    assert refused.status_code == 422
    assert "Project ID" in refused.text
    assert await _balance(client, api, "5102") == before, "nothing posted"


async def test_disbursing_against_an_unknown_project_is_refused(
    client: AsyncClient, api: str
) -> None:
    await _fund(client, api)
    await _crew(client, api, "Bagus", "5000000", "8")

    refused = await client.post(
        f"{api}/incentives/disburse",
        json={"project_id": "00000000-0000-0000-0000-000000000000"},
    )

    assert refused.status_code == 404
    assert await _balance(client, api, "5102") == ZERO


async def test_disbursement_posts_crew_cogs_against_the_bank(
    client: AsyncClient, api: str, make_project
) -> None:
    await _fund(client, api)
    project = await make_project()
    await _crew(client, api, "Bagus", "5000000", "8")

    paid = await client.post(f"{api}/incentives/disburse", json={"project_id": project})
    assert paid.status_code == 201, paid.text
    assert paid.json()["amount"] == "4000000.00"

    assert await _balance(client, api, "5102") == D("4000000")
    assert await _balance(client, api, "1101") == D("900000000") - D("4000000")


async def test_the_bonus_lands_on_the_projects_own_p_and_l(
    client: AsyncClient, api: str, make_project
) -> None:
    """The reason the tag is mandatory, stated as an assertion rather than a comment."""
    await _fund(client, api)
    project = await make_project()
    other = await make_project(name="Someone Else")
    await _crew(client, api, "Bagus", "5000000", "8")

    await client.post(f"{api}/incentives/disburse", json={"project_id": project})

    tagged = (await client.get(f"{api}/reports/project-pnl", params={"project_id": project})).json()
    untagged = (await client.get(f"{api}/reports/project-pnl", params={"project_id": other})).json()

    assert Decimal(tagged["cost"]) == D("4000000")
    assert Decimal(untagged["cost"]) == ZERO


async def test_disbursing_twice_is_refused(client: AsyncClient, api: str, make_project) -> None:
    """Flow §41.

    The prototype relied on an in-memory ``incentivesPaid`` boolean, which a stateless API
    cannot. A unique constraint on the project replaces it.
    """
    await _fund(client, api)
    project = await make_project()
    await _crew(client, api, "Bagus", "5000000", "8")

    first = await client.post(f"{api}/incentives/disburse", json={"project_id": project})
    assert first.status_code == 201

    again = await client.post(f"{api}/incentives/disburse", json={"project_id": project})
    assert again.status_code == 409
    assert "already been disbursed" in again.text
    assert await _balance(client, api, "5102") == D("4000000"), "still paid exactly once"


async def test_a_pool_nobody_qualifies_for_cannot_be_disbursed(
    client: AsyncClient, api: str, make_project
) -> None:
    await _fund(client, api)
    project = await make_project()
    await _crew(client, api, "Sari", "4000000", "3")

    refused = await client.post(f"{api}/incentives/disburse", json={"project_id": project})

    assert refused.status_code == 422
    assert "nothing to disburse" in refused.text.lower()


async def test_sales_cannot_disburse_incentives(client_for, api: str, make_project) -> None:
    project = await make_project()
    sales = await client_for(Role.SALES)
    refused = await sales.post(f"{api}/incentives/disburse", json={"project_id": project})
    assert refused.status_code == 403


# ---------------------------------------------------------------------------
# Warehouse — flow §3, the dual-logic warehouse
# ---------------------------------------------------------------------------


async def test_releasing_consumables_expenses_them_and_reduces_stock(
    client: AsyncClient, api: str, make_project
) -> None:
    """Consumables do not come back, so stock drops permanently in the same step."""
    await _stock(client, api)
    project = await make_project()
    item = await _item(client, api)

    released = await client.post(
        f"{api}/inventory/{item['id']}/release", json={"qty": "20", "project_id": project}
    )
    assert released.status_code == 200, released.text

    assert Decimal(released.json()["item"]["qty"]) == D("80"), "stock permanently reduced"
    assert await _balance(client, api, "5104") == D("1000000"), "20 × 50,000"
    assert await _balance(client, api, "1301") == D("50000000") - D("1000000")


async def test_releasing_more_than_is_in_stock_is_refused(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(client, api)

    refused = await client.post(f"{api}/inventory/{item['id']}/release", json={"qty": "500"})

    assert refused.status_code == 422
    assert await _balance(client, api, "5104") == ZERO


async def test_a_fixed_asset_cannot_be_released_as_a_consumable(
    client: AsyncClient, api: str
) -> None:
    """The two halves of the warehouse behave differently on purpose."""
    await _stock(client, api)
    item = await _item(client, api, item="LED Wall", type="Fixed Asset", unit_value="8000000")

    refused = await client.post(f"{api}/inventory/{item['id']}/release", json={"qty": "1"})

    assert refused.status_code == 409
    assert "checked out, not released" in refused.text


async def test_lost_stock_posts_an_asset_loss(client: AsyncClient, api: str, make_project) -> None:
    await _stock(client, api)
    project = await make_project()
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )

    lost = await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "lost", "lost_qty": "1", "project_id": project},
    )
    assert lost.status_code == 200, lost.text

    assert await _balance(client, api, "6901") == D("8000000")
    assert await _balance(client, api, "1302") == D("640000000") - D("8000000")
    assert Decimal(lost.json()["item"]["qty"]) == D("3")


async def test_a_clean_return_posts_nothing(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )

    returned = await client.post(f"{api}/inventory/{item['id']}/return", json={"condition": "good"})

    assert returned.status_code == 200, returned.text
    assert returned.json()["entry_id"] is None
    assert await _balance(client, api, "6901") == ZERO


async def test_damaged_stock_goes_to_maintenance_and_posts_nothing_yet(
    client: AsyncClient, api: str
) -> None:
    """Damage is not yet a loss — it becomes one only if the repair fails."""
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )

    returned = await client.post(
        f"{api}/inventory/{item['id']}/return", json={"condition": "damaged"}
    )

    assert returned.json()["item"]["status"] == "maintenance"
    assert returned.json()["entry_id"] is None
    assert await _balance(client, api, "6901") == ZERO


async def test_repaired_stock_returns_without_posting(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    await client.post(f"{api}/inventory/{item['id']}/return", json={"condition": "damaged"})

    repaired = await client.post(f"{api}/inventory/{item['id']}/repair")

    assert repaired.status_code == 200, repaired.text
    assert repaired.json()["item"]["status"] == "in_stock"
    assert repaired.json()["entry_id"] is None
    assert await _balance(client, api, "6901") == ZERO


async def test_condemned_stock_is_written_off(client: AsyncClient, api: str) -> None:
    """The prototype could route kit *into* maintenance but never out — it was stranded."""
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    await client.post(f"{api}/inventory/{item['id']}/return", json={"condition": "damaged"})

    condemned = await client.post(f"{api}/inventory/{item['id']}/condemn")

    assert condemned.status_code == 200, condemned.text
    assert condemned.json()["item"]["status"] == "written_off"
    assert await _balance(client, api, "6901") == D("32000000"), "4 × 8,000,000"
    assert await _balance(client, api, "1302") == D("640000000") - D("32000000")


async def test_condemning_stock_that_is_not_in_maintenance_is_refused(
    client: AsyncClient, api: str
) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )

    refused = await client.post(f"{api}/inventory/{item['id']}/condemn")

    assert refused.status_code == 409
    assert await _balance(client, api, "6901") == ZERO


# ---------------------------------------------------------------------------
# The write-down hook — where the warehouse meets the register
# ---------------------------------------------------------------------------


async def test_losing_registered_stock_returns_its_accumulated_depreciation(
    client: AsyncClient, api: str
) -> None:
    """Only the **net book value** is a loss.

    Expensing the full cost would overstate the loss on any asset part-way through its life
    and leave the register claiming equipment the ledger has already removed.
    """
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    asset = await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "LED Wall",
            "acquired_on": "2026-01-15",
            "cost": "32000000",
            "useful_life_months": 32,
            "inventory_item_id": item["id"],
            # Already inside the opening 1302 balance, so registering it posts nothing.
            "post": False,
        },
    )
    assert asset.status_code == 201, asset.text
    await client.post(f"{api}/depreciation/run", json={})

    accumulated = -(await _balance(client, api, "1303"))
    assert accumulated > ZERO, "there is real depreciation to return"

    await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "lost", "lost_qty": "4"},
    )

    assert await _balance(client, api, "1303") == ZERO, "all of it came back"
    assert await _balance(client, api, "6901") == D("32000000") - accumulated
    assert await _balance(client, api, "6901") < D("32000000"), "less than the full cost"


async def test_a_partial_loss_shrinks_the_register_pro_rata(client: AsyncClient, api: str) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    created = await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "LED Wall",
            "acquired_on": "2026-01-15",
            "cost": "32000000",
            "useful_life_months": 32,
            "inventory_item_id": item["id"],
            "post": False,
        },
    )
    await client.post(f"{api}/depreciation/run", json={})
    accumulated = -(await _balance(client, api, "1303"))

    await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "lost", "lost_qty": "1"},
    )

    asset = (await client.get(f"{api}/fixed-assets/{created.json()['id']}")).json()
    assert Decimal(asset["cost"]) == D("24000000"), "a quarter of the cost gone"
    assert asset["status"] == "active", "three units remain"
    assert Decimal(asset["posted_accumulated"]) == accumulated - (accumulated / 4).quantize(
        D("0.01")
    )
    assert asset["schedule_from"] is not None, "and it rebased onto the smaller cost"


async def test_a_total_loss_disposes_the_asset_and_the_register_still_ties(
    client: AsyncClient, api: str
) -> None:
    await _stock(client, api)
    item = await _item(
        client, api, item="LED Wall", type="Fixed Asset", qty="4", unit_value="8000000"
    )
    created = await client.post(
        f"{api}/fixed-assets",
        json={
            "name": "LED Wall",
            "acquired_on": "2026-01-15",
            "cost": "32000000",
            "useful_life_months": 32,
            "inventory_item_id": item["id"],
            "post": False,
        },
    )
    await client.post(f"{api}/depreciation/run", json={})

    await client.post(
        f"{api}/inventory/{item['id']}/return",
        json={"condition": "lost", "lost_qty": "4"},
    )

    asset = (await client.get(f"{api}/fixed-assets/{created.json()['id']}")).json()
    assert asset["status"] == "disposed", "nothing left means gone, not merely smaller"

    register = (await client.get(f"{api}/fixed-assets/register")).json()
    assert register["count"] == 0
    assert Decimal(register["accumulated"]) == ZERO
    assert Decimal(register["ledger_accumulated"]) == ZERO


async def test_a_project_can_only_be_rated_once_it_has_reached_feedback(
    client: AsyncClient, api: str, make_project, db
) -> None:
    from app.domain.ar.models import Project

    early = await make_project()  # still at DP Paid
    refused = await client.put(f"{api}/projects/{early}/feedback", json={"score": "9"})
    assert refused.status_code == 409 and "Post-Event Feedback" in refused.json()["detail"]

    finished = await make_project(stage=Stage.FINISHED)
    assert (
        await client.put(f"{api}/projects/{finished}/feedback", json={"score": "9"})
    ).status_code == 200

    cancelled = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    row = await db.get(Project, uuid.UUID(cancelled))
    row.cancelled = True
    await db.flush()
    gone = await client.put(f"{api}/projects/{cancelled}/feedback", json={"score": "9"})
    assert gone.status_code == 409 and "cancelled" in gone.json()["detail"]


# ---------------------------------------------------------------------------
# Editing, deactivating and removing crew
# ---------------------------------------------------------------------------


async def test_a_crew_member_can_be_edited(client: AsyncClient, api: str) -> None:
    bagus = await _crew(client, api, "Bagus", "5000000", "8")
    r = await client.patch(
        f"{api}/crew/{bagus['id']}",
        json={
            "name": "  Bagus   Santoso ",
            "role": "Rigger",
            "base_rate": "5500000",
            "last_rating": "9",
        },
    )
    assert r.status_code == 200, r.text
    assert r.json()["name"] == "Bagus Santoso" and r.json()["role"] == "Rigger"
    assert r.json()["base_rate"] == "5500000.00" and r.json()["active"] is True

    assert (await client.patch(f"{api}/crew/{bagus['id']}", json={"name": " "})).status_code == 422
    assert (
        await client.patch(f"{api}/crew/{bagus['id']}", json={"base_rate": "-1"})
    ).status_code == 422
    assert (
        await client.patch(f"{api}/crew/{bagus['id']}", json={"last_rating": "11"})
    ).status_code == 422
    missing = await client.patch(f"{api}/crew/{uuid.uuid4()}", json={"name": "x"})
    assert missing.status_code == 404


async def test_only_those_who_approve_incentives_may_change_crew(
    client: AsyncClient, client_for, api: str
) -> None:
    bagus = await _crew(client, api, "Bagus", "5000000", "8")
    for role in (Role.SALES, Role.WAREHOUSE, Role.PM):
        who = await client_for(role)
        assert (await who.patch(f"{api}/crew/{bagus['id']}", json={"name": "X"})).status_code == 403
        assert (await who.post(f"{api}/crew/{bagus['id']}/deactivate")).status_code == 403
        assert (await who.delete(f"{api}/crew/{bagus['id']}")).status_code == 403


async def test_a_deactivated_member_is_left_out_of_new_pools_and_can_come_back(
    client: AsyncClient, api: str, make_project
) -> None:
    project = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    bagus = await _crew(client, api, "Bagus", "5000000", "8")
    await _crew(client, api, "Sari", "4000000", "9")

    off = await client.post(f"{api}/crew/{bagus['id']}/deactivate")
    assert off.status_code == 200 and off.json()["active"] is False
    assert off.json()["deactivated_on"] is not None
    pool = (await client.get(f"{api}/projects/{project}/incentives")).json()
    assert [r["name"] for r in pool["rows"]] == ["Sari"], "left out of the pool"
    listed = (await client.get(f"{api}/crew")).json()
    assert {c["name"] for c in listed} == {"Bagus", "Sari"}, "but still on the crew list"

    on = await client.post(f"{api}/crew/{bagus['id']}/reactivate")
    assert on.json()["active"] is True and on.json()["deactivated_on"] is None
    pool = (await client.get(f"{api}/projects/{project}/incentives")).json()
    assert {r["name"] for r in pool["rows"]} == {"Bagus", "Sari"}


async def test_a_pool_that_was_paid_is_frozen_whatever_happens_to_the_crew_after(
    client: AsyncClient, api: str, make_project
) -> None:
    await _fund(client, api)
    project = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    bagus = await _crew(client, api, "Bagus", "5000000", "8")
    await _crew(client, api, "Sari", "4000000", "9")
    paid = await client.post(f"{api}/incentives/disburse", json={"project_id": project})
    assert paid.status_code == 201, paid.text
    frozen = (await client.get(f"{api}/projects/{project}/incentives")).json()
    assert frozen["disbursed"] is True and frozen["pool"] == paid.json()["amount"]

    # Rate rise, re-rating, deactivation, and a new hire: none of it rewrites the paid pool.
    await client.patch(
        f"{api}/crew/{bagus['id']}", json={"base_rate": "9000000", "name": "Bagus Renamed"}
    )
    await client.post(f"{api}/crew/{bagus['id']}/deactivate")
    await _crew(client, api, "Newcomer", "1000000", "10")
    after = (await client.get(f"{api}/projects/{project}/incentives")).json()
    assert after["rows"] == frozen["rows"], "the paid pool still names who was paid, as they were"
    assert after["pool"] == frozen["pool"]
    assert {r["name"] for r in after["rows"]} == {"Bagus", "Sari"}


async def test_crew_can_be_deleted_only_while_they_cannot_have_been_paid(
    client: AsyncClient, api: str, make_project
) -> None:
    await _fund(client, api)
    mistake = await _crew(client, api, "Added By Mistake", "1000", "5")
    gone = await client.delete(f"{api}/crew/{mistake['id']}")
    assert gone.status_code == 204
    assert all(c["id"] != mistake["id"] for c in (await client.get(f"{api}/crew")).json())

    project = await make_project(stage=Stage.POST_EVENT_FEEDBACK)
    paid_member = await _crew(client, api, "Paid Member", "5000000", "9")
    await client.post(f"{api}/incentives/disburse", json={"project_id": project})
    refused = await client.delete(f"{api}/crew/{paid_member['id']}")
    assert refused.status_code == 409 and "Deactivate" in refused.json()["detail"]
    assert (await client.post(f"{api}/crew/{paid_member['id']}/deactivate")).status_code == 200


async def test_a_deactivated_member_is_not_found_by_search(client: AsyncClient, api: str) -> None:
    member = await _crew(client, api, "Zebulon Quartermain", "1000000", "7")
    found = (await client.get(f"{api}/search", params={"q": "Zebulon"})).json()
    assert found["total"] >= 1
    await client.post(f"{api}/crew/{member['id']}/deactivate")
    again = (await client.get(f"{api}/search", params={"q": "Zebulon"})).json()
    assert again["total"] == 0
