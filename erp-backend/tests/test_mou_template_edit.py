"""Backlog item 2 — editing MoU templates, and who may.

The wording of a contract was editable only in the browser, and `POST`/`DELETE /mou-templates` were
open to any signed-in user. Now one `PATCH` replaces a template's wording and clauses together, and
all three writes need the `manage_mou_templates` action (CEO and Sales).
"""

from __future__ import annotations

import pytest
from httpx import AsyncClient

from app.domain.masters.models import Role


async def _templates(client: AsyncClient, api: str) -> dict[str, dict]:
    rows = (await client.get(f"{api}/mou-templates")).json()
    return {t["id"]: t for t in rows}


async def test_a_template_can_be_edited_whole_and_its_clauses_are_replaced_in_order(
    client: AsyncClient, api: str
) -> None:
    r = await client.patch(
        f"{api}/mou-templates/corporate",
        json={
            "label": "  Corporate (2027)  ",
            "heading": "MEMORANDUM OF AGREEMENT",
            "validity": "Valid for 14 days.",
            "signatory": "Authorised Director",
            "clauses": ["First, now.", "  Second.  ", "Third."],
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["label"] == "Corporate (2027)" and body["heading"] == "MEMORANDUM OF AGREEMENT"
    assert body["validity"] == "Valid for 14 days." and body["signatory"] == "Authorised Director"
    assert [(c["clause_no"], c["text"]) for c in body["clauses"]] == [
        (1, "First, now."),
        (2, "Second."),
        (3, "Third."),
    ]
    again = (await _templates(client, api))["corporate"]
    assert [c["text"] for c in again["clauses"]] == ["First, now.", "Second.", "Third."]


async def test_what_is_not_sent_is_left_alone_and_null_clears_the_optional_lines(
    client: AsyncClient, api: str
) -> None:
    before = (await _templates(client, api))["wedding"]
    r = await client.patch(f"{api}/mou-templates/wedding", json={"validity": None})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["validity"] is None, "sending null clears it"
    assert body["label"] == before["label"] and body["heading"] == before["heading"]
    assert [c["text"] for c in body["clauses"]] == [c["text"] for c in before["clauses"]]


async def test_moving_a_clause_is_a_reordered_list(client: AsyncClient, api: str) -> None:
    clauses = [c["text"] for c in (await _templates(client, api))["government"]["clauses"]]
    assert len(clauses) >= 2
    swapped = [clauses[1], clauses[0], *clauses[2:]]
    r = await client.patch(f"{api}/mou-templates/government", json={"clauses": swapped})
    assert r.status_code == 200, r.text
    assert [c["text"] for c in r.json()["clauses"]] == swapped


async def test_a_blank_clause_a_blank_name_and_an_unknown_template_are_refused(
    client: AsyncClient, api: str
) -> None:
    ok = (await _templates(client, api))["corporate"]
    assert (
        await client.patch(f"{api}/mou-templates/corporate", json={"clauses": ["fine", "  "]})
    ).status_code == 422
    assert (
        await client.patch(f"{api}/mou-templates/corporate", json={"label": ""})
    ).status_code == 422
    assert (await client.patch(f"{api}/mou-templates/nope", json={"label": "x"})).status_code == 404
    after = (await _templates(client, api))["corporate"]
    assert after["clauses"] == ok["clauses"] and after["label"] == ok["label"]


async def test_an_empty_clause_list_leaves_a_template_with_no_clauses(
    client: AsyncClient, api: str
) -> None:
    r = await client.patch(f"{api}/mou-templates/corporate", json={"clauses": []})
    assert r.status_code == 200 and r.json()["clauses"] == []


@pytest.mark.parametrize("role", [Role.PM, Role.FINANCE, Role.WAREHOUSE])
async def test_roles_without_the_action_cannot_create_edit_or_delete(
    client: AsyncClient, client_for, api: str, role: Role
) -> None:
    other = await client_for(role)
    made = await other.post(
        f"{api}/mou-templates",
        json={"id": "mine", "label": "Mine", "heading": "H", "clauses": ["x"]},
    )
    assert made.status_code == 403
    assert made.json()["action"] == "manage_mou_templates"
    assert (
        await other.patch(f"{api}/mou-templates/corporate", json={"label": "Hacked"})
    ).status_code == 403
    assert (await other.delete(f"{api}/mou-templates/government")).status_code == 403
    # `client` and `client_for` share one HTTP client, so `other` has just replaced the CEO's
    # token. Sign the CEO back in before reading, or this reads as the role under test.
    ceo = await client_for(Role.CEO)
    assert (await _templates(ceo, api))["corporate"]["label"] != "Hacked"


async def test_sales_may_edit_contract_wording(client_for, api: str) -> None:
    sales = await client_for(Role.SALES)
    r = await sales.patch(f"{api}/mou-templates/corporate", json={"heading": "SALES WORDING"})
    assert r.status_code == 200 and r.json()["heading"] == "SALES WORDING"
    made = await sales.post(
        f"{api}/mou-templates",
        json={"id": "sales-made", "label": "Sales made", "heading": "H", "clauses": ["a"]},
    )
    assert made.status_code == 201
    assert (await sales.delete(f"{api}/mou-templates/sales-made")).status_code == 204
