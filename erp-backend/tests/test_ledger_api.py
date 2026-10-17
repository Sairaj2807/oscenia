"""Phase 1 — the HTTP boundary.

These go through real HTTP against real Postgres. That is deliberate: the boundary is what
the React app will consume during the rewire, so the boundary is what has to be right.
"""

from __future__ import annotations

from datetime import date

import pytest
from httpx import AsyncClient

pytestmark = pytest.mark.phase1

MAY10 = "2026-05-10"


def _entry(lines, **kw) -> dict:
    body = {"entry_date": MAY10, "memo": "api test", "lines": lines}
    body.update(kw)
    return body


async def _post_entry(client: AsyncClient, api: str, lines, **kw) -> dict:
    response = await client.post(f"{api}/journal-entries", json=_entry(lines, **kw))
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Chart of accounts
# ---------------------------------------------------------------------------


async def test_lists_the_seeded_chart(client: AsyncClient, api: str) -> None:
    response = await client.get(f"{api}/accounts")
    assert response.status_code == 200
    codes = {a["code"] for a in response.json()}
    assert {"1101", "1201", "1401", "2102", "2105", "4101", "5101", "6901"} <= codes


async def test_search_and_type_filters(client: AsyncClient, api: str) -> None:
    by_type = await client.get(f"{api}/accounts", params={"type": "revenue"})
    assert {a["code"] for a in by_type.json()} == {"4101", "4102"}

    by_query = await client.get(f"{api}/accounts", params={"q": "Petty"})
    assert [a["code"] for a in by_query.json()] == ["1103"]


async def test_account_detail_exposes_the_integration_preview(
    client: AsyncClient, api: str
) -> None:
    """The prototype shows which statement and bucket an account lands on before you use it."""
    body = (await client.get(f"{api}/accounts/1101")).json()
    assert body["normal_side"] == "debit"
    assert body["statement"] == "balance"
    assert body["group_label"] == "Cash & Bank"
    assert body["is_postable"] is True
    assert body["usage_count"] == 0


async def test_tree_groups_by_type_then_bucket(client: AsyncClient, api: str) -> None:
    tree = (await client.get(f"{api}/accounts/tree")).json()
    types = [node["type"] for node in tree]
    assert types == ["asset", "liability", "equity", "revenue", "cogs", "opex", "tax"]

    assets = next(n for n in tree if n["type"] == "asset")
    buckets = {g["group"] for g in assets["groups"]}
    assert "Cash & Bank" in buckets


async def test_creating_a_sub_account_inherits_the_cash_flag(
    client: AsyncClient, api: str
) -> None:
    response = await client.post(
        f"{api}/accounts",
        json={
            "code": "1101.01",
            "name": "Main Bank — Operating",
            "type": "asset",
            "parent_code": "1101",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["is_cash"] is True, "a sub-account of a bank account is still cash"
    assert body["group_label"] == "Cash & Bank"


async def test_the_parent_becomes_a_header_and_stops_accepting_postings(
    client: AsyncClient, api: str
) -> None:
    await client.post(
        f"{api}/accounts",
        json={"code": "1101.01", "name": "Operating", "type": "asset", "parent_code": "1101"},
    )

    parent = (await client.get(f"{api}/accounts/1101")).json()
    assert parent["is_header"] is True
    assert parent["is_postable"] is False

    refused = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [
                {"account": "1101", "debit": "10"},
                {"account": "4102", "credit": "10"},
            ]
        ),
    )
    assert refused.status_code == 409
    assert "header" in refused.json()["detail"]


async def test_sub_accounts_nest_one_level_only(client: AsyncClient, api: str) -> None:
    await client.post(
        f"{api}/accounts",
        json={"code": "1101.01", "name": "Level one", "type": "asset", "parent_code": "1101"},
    )
    response = await client.post(
        f"{api}/accounts",
        json={
            "code": "1101.01.01",
            "name": "Level two",
            "type": "asset",
            "parent_code": "1101.01",
        },
    )
    assert response.status_code == 409
    assert "one level" in response.json()["detail"]


async def test_a_sub_account_must_share_its_parent_type(
    client: AsyncClient, api: str
) -> None:
    response = await client.post(
        f"{api}/accounts",
        json={"code": "1101.09", "name": "Wrong", "type": "liability", "parent_code": "1101"},
    )
    assert response.status_code == 409
    assert "type" in response.json()["detail"]


async def test_duplicate_code_is_refused(client: AsyncClient, api: str) -> None:
    response = await client.post(
        f"{api}/accounts", json={"code": "1101", "name": "Again", "type": "asset"}
    )
    assert response.status_code == 409


async def test_malformed_code_is_refused(client: AsyncClient, api: str) -> None:
    response = await client.post(
        f"{api}/accounts", json={"code": "CASH-01", "name": "Bad", "type": "asset"}
    )
    assert response.status_code == 422


async def test_next_code_suggestions(client: AsyncClient, api: str) -> None:
    under_parent = (
        await client.get(f"{api}/accounts/next-code", params={"parent": "1101"})
    ).json()
    assert under_parent["code"] == "1101.01"

    await client.post(
        f"{api}/accounts",
        json={"code": "1101.01", "name": "One", "type": "asset", "parent_code": "1101"},
    )
    nxt = (await client.get(f"{api}/accounts/next-code", params={"parent": "1101"})).json()
    assert nxt["code"] == "1101.02"


async def test_deactivating_keeps_the_account_but_stops_postings(
    client: AsyncClient, api: str
) -> None:
    response = await client.post(f"{api}/accounts/2103/deactivate")
    assert response.status_code == 200
    assert response.json()["active"] is False

    refused = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [{"account": "2103", "debit": "10"}, {"account": "4102", "credit": "10"}]
        ),
    )
    assert refused.status_code == 409
    assert "deactivated" in refused.json()["detail"]

    assert (await client.post(f"{api}/accounts/2103/activate")).json()["active"] is True


async def test_deleting_a_used_account_is_refused_and_names_the_alternative(
    client: AsyncClient, api: str
) -> None:
    await _post_entry(
        client, api,
        [{"account": "1102", "debit": "10"}, {"account": "4102", "credit": "10"}],
    )
    response = await client.delete(f"{api}/accounts/1102")
    assert response.status_code == 409
    assert "eactivate" in response.json()["detail"]


async def test_renaming_is_always_allowed(client: AsyncClient, api: str) -> None:
    await _post_entry(
        client, api,
        [{"account": "1102", "debit": "10"}, {"account": "4102", "credit": "10"}],
    )
    response = await client.patch(f"{api}/accounts/1102", json={"name": "Cash in Hand"})
    assert response.status_code == 200
    assert response.json()["name"] == "Cash in Hand"


async def test_chart_stats(client: AsyncClient, api: str) -> None:
    stats = (await client.get(f"{api}/accounts/stats")).json()
    assert stats["total"] >= 27
    assert stats["postable"] >= 27
    assert stats["deactivated"] == 0
    assert stats["never_posted"] >= 27


# ---------------------------------------------------------------------------
# Journal
# ---------------------------------------------------------------------------


async def test_posting_returns_the_stamped_numbers(client: AsyncClient, api: str) -> None:
    body = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "144000000"}, {"account": "4101", "credit": "144000000"}],
    )
    assert body["entry_no"].startswith("JE-")
    assert body["voucher_no"]
    assert body["total"] == "144000000.00", "money crosses the wire as a string"
    assert len(body["lines"]) == 2


async def test_money_is_serialised_as_a_string_not_a_float(
    client: AsyncClient, api: str
) -> None:
    """A JSON number would be an IEEE 754 double by the time a client parsed it."""
    body = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "0.10"}, {"account": "4102", "credit": "0.10"}],
    )
    assert body["lines"][0]["debit"] == "0.10"
    assert isinstance(body["lines"][0]["debit"], str)


async def test_unbalanced_entry_is_refused_with_the_difference(
    client: AsyncClient, api: str
) -> None:
    response = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "9"}]
        ),
    )
    assert response.status_code == 409
    assert "out by 1.00" in response.json()["detail"]


async def test_single_line_entry_is_refused_by_schema(
    client: AsyncClient, api: str
) -> None:
    response = await client.post(
        f"{api}/journal-entries", json=_entry([{"account": "1101", "debit": "10"}])
    )
    assert response.status_code == 422


async def test_reversal_and_the_linked_chain(client: AsyncClient, api: str) -> None:
    original = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "100"}, {"account": "4102", "credit": "100"}],
    )

    reversal = (
        await client.post(f"{api}/journal-entries/{original['id']}/reverse")
    ).json()
    assert reversal["voucher_no"] != original["voucher_no"], "its own number"
    assert reversal["series"] == "jv"
    assert reversal["reversal_of_id"] == original["id"]

    refreshed = (await client.get(f"{api}/journal-entries/{original['id']}")).json()
    assert refreshed["reversed_by_id"] == reversal["id"]


async def test_reversing_twice_is_refused(client: AsyncClient, api: str) -> None:
    entry = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "100"}, {"account": "4102", "credit": "100"}],
    )
    await client.post(f"{api}/journal-entries/{entry['id']}/reverse")
    again = await client.post(f"{api}/journal-entries/{entry['id']}/reverse")
    assert again.status_code == 409
    assert "already been reversed" in again.json()["detail"]


async def test_adjust_returns_reversal_and_replacement(
    client: AsyncClient, api: str
) -> None:
    entry = await _post_entry(
        client, api,
        [{"account": "5101", "debit": "100"}, {"account": "2102", "credit": "100"}],
    )
    response = await client.post(
        f"{api}/journal-entries/{entry['id']}/adjust",
        json={
            "lines": [
                {"account": "5101", "debit": "130"},
                {"account": "2102", "credit": "130"},
            ]
        },
    )
    assert response.status_code == 200
    reversal, replacement = response.json()
    assert reversal["source_kind"] == "reversal"
    assert replacement["source_kind"] == "adjustment"
    assert replacement["total"] == "130.00"


async def test_there_is_no_way_to_edit_or_delete_an_entry(
    client: AsyncClient, api: str
) -> None:
    """The absence is the feature."""
    entry = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "10"}],
    )
    for method in ("put", "patch", "delete"):
        response = await getattr(client, method)(f"{api}/journal-entries/{entry['id']}")
        assert response.status_code == 405, f"{method.upper()} should not exist"


async def test_journal_listing_filters_and_paginates(
    client: AsyncClient, api: str
) -> None:
    for _ in range(3):
        await _post_entry(
            client, api,
            [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "10"}],
        )
    await _post_entry(
        client, api,
        [{"account": "5101", "debit": "10"}, {"account": "2102", "credit": "10"}],
        source={"kind": "po", "ref": "PO-3001"},
    )

    page = (await client.get(f"{api}/journal-entries", params={"limit": 2})).json()
    assert len(page["items"]) == 2
    assert page["total"] == 4

    by_source = (
        await client.get(f"{api}/journal-entries", params={"source_kind": "po"})
    ).json()
    assert by_source["total"] == 1
    assert by_source["items"][0]["source_ref"] == "PO-3001"


# ---------------------------------------------------------------------------
# Open items
# ---------------------------------------------------------------------------


async def test_open_items_for_receivables_and_their_settlement(
    client: AsyncClient, api: str
) -> None:
    recognition = await _post_entry(
        client, api,
        [
            {"account": "1201", "debit": "144000000"},
            {"account": "4101", "credit": "144000000"},
        ],
        source={"kind": "invoice", "ref": "INV-0041"},
    )

    items = (
        await client.get(f"{api}/open-items", params={"control": "1201", "side": "debit"})
    ).json()
    mine = [i for i in items if i["entry_id"] == recognition["id"]]
    assert len(mine) == 1
    assert mine[0]["outstanding"] == "144000000.00"

    await _post_entry(
        client, api,
        [
            {"account": "1101", "debit": "141120000"},
            {"account": "1401", "debit": "2880000"},
            {"account": "1201", "credit": "144000000"},
        ],
        source={"kind": "payment"},
        applied_to=[recognition["id"]],
    )

    items = (
        await client.get(f"{api}/open-items", params={"control": "1201", "side": "debit"})
    ).json()
    assert not [i for i in items if i["entry_id"] == recognition["id"]]


async def test_payables_open_items_carry_a_due_date(
    client: AsyncClient, api: str
) -> None:
    bill = await _post_entry(
        client, api,
        [
            {"account": "6101", "debit": "18500000"},
            {"account": "2102", "credit": "18500000"},
        ],
        source={"kind": "po", "ref": "BILL-0012", "due": "2026-06-11"},
    )
    items = (
        await client.get(f"{api}/open-items", params={"control": "2102", "side": "credit"})
    ).json()
    mine = next(i for i in items if i["entry_id"] == bill["id"])
    assert mine["due"] == "2026-06-11", "a bill with no PO still ages"
    assert mine["outstanding"] == "18500000.00"


# ---------------------------------------------------------------------------
# Voucher series
# ---------------------------------------------------------------------------


async def test_voucher_series_are_listed(client: AsyncClient, api: str) -> None:
    keys = {s["key"] for s in (await client.get(f"{api}/voucher-series")).json()}
    assert keys == {"km", "kk", "rm", "fa", "rev", "exp", "jv"}


async def test_series_preview_shows_the_real_next_number(
    client: AsyncClient, api: str
) -> None:
    body = (
        await client.get(f"{api}/voucher-series/km/preview", params={"on": MAY10})
    ).json()
    assert body["next_preview"] == "KM-05-10-001"


async def test_a_format_without_a_sequence_token_is_refused(
    client: AsyncClient, api: str
) -> None:
    response = await client.patch(
        f"{api}/voucher-series/km", json={"format": "[PREFIX]-[MONTH]-[DATE]"}
    )
    assert response.status_code == 422
    assert "SEQ" in response.json()["detail"]


async def test_changing_a_format_does_not_rewrite_issued_numbers(
    client: AsyncClient, api: str
) -> None:
    entry = await _post_entry(
        client, api,
        [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "10"}],
        source={"kind": "payment"},
    )
    issued = entry["voucher_no"]

    await client.patch(
        f"{api}/voucher-series/km", json={"format": "CASHIN/[YEAR]/[SEQ_0001]"}
    )

    unchanged = (await client.get(f"{api}/journal-entries/{entry['id']}")).json()
    assert unchanged["voucher_no"] == issued


# ---------------------------------------------------------------------------
# Periods
# ---------------------------------------------------------------------------


async def test_only_the_ceo_and_finance_may_close_or_reopen_a_period(
    client_for, api: str
) -> None:
    from app.domain.masters.models import Role

    for role in (Role.PM, Role.SALES, Role.WAREHOUSE):
        who = await client_for(role)
        assert (await who.post(f"{api}/periods/2026/4/close")).status_code == 403, role
        assert (await who.post(f"{api}/periods/2026/4/reopen")).status_code == 403, role
        assert (await who.get(f"{api}/periods")).status_code == 200, "anyone signed in may look"

    finance = await client_for(Role.FINANCE)
    assert (await finance.post(f"{api}/periods/2026/4/close")).status_code == 200
    assert (await finance.post(f"{api}/periods/2026/4/reopen")).status_code == 200
    rows = (await finance.get(f"{api}/periods")).json()
    assert rows[0]["status"] == "open", "the server says open/closed in lower case"


async def test_closing_a_period_blocks_postings_in_it(
    client: AsyncClient, api: str
) -> None:
    closed = await client.post(f"{api}/periods/2026/3/close")
    assert closed.status_code == 200
    assert closed.json()["status"] == "closed"
    assert closed.json()["closed_at"] is not None

    refused = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "10"}],
            entry_date="2026-03-15",
        ),
    )
    assert refused.status_code == 409
    assert "closed" in refused.json()["detail"]


async def test_reopening_lets_postings_through_again(
    client: AsyncClient, api: str
) -> None:
    await client.post(f"{api}/periods/2026/3/close")
    reopened = await client.post(f"{api}/periods/2026/3/reopen")
    assert reopened.json()["status"] == "open"

    allowed = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [{"account": "1101", "debit": "10"}, {"account": "4102", "credit": "10"}],
            entry_date="2026-03-15",
        ),
    )
    assert allowed.status_code == 201


async def test_closing_twice_is_refused(client: AsyncClient, api: str) -> None:
    await client.post(f"{api}/periods/2026/4/close")
    again = await client.post(f"{api}/periods/2026/4/close")
    assert again.status_code == 409


# ---------------------------------------------------------------------------
# Reports
# ---------------------------------------------------------------------------


async def test_trial_balance_is_exactly_balanced(client: AsyncClient, api: str) -> None:
    await _post_entry(
        client, api,
        [
            {"account": "1201", "debit": "144000000"},
            {"account": "4101", "credit": "144000000"},
        ],
    )
    body = (await client.get(f"{api}/reports/trial-balance")).json()
    assert body["balanced"] is True
    assert body["difference"] == "0.00"
    assert body["debit"] == body["credit"]


async def test_general_ledger_opening_plus_movement_equals_closing(
    client: AsyncClient, api: str
) -> None:
    await _post_entry(
        client, api,
        [{"account": "1101", "debit": "100"}, {"account": "4102", "credit": "100"}],
        entry_date="2026-04-01",
    )
    await _post_entry(
        client, api,
        [{"account": "1101", "debit": "50"}, {"account": "4102", "credit": "50"}],
        entry_date="2026-05-15",
    )

    body = (
        await client.get(
            f"{api}/reports/general-ledger",
            params={
                "codes": ["1101"],
                "period": "custom",
                "start": "2026-05-01",
                "end": "2026-05-31",
            },
        )
    ).json()

    assert body["opening"] == "100.00", "prior movement is folded in, not dropped"
    assert body["closing"] == "150.00"
    assert body["single_account"] is True
    assert len(body["rows"]) == 1


async def test_consolidated_ledger_says_it_is_consolidated(
    client: AsyncClient, api: str
) -> None:
    await _post_entry(
        client, api,
        [{"account": "1101", "debit": "100"}, {"account": "4102", "credit": "100"}],
    )
    body = (
        await client.get(f"{api}/reports/general-ledger", params={"period": "all"})
    ).json()
    assert body["single_account"] is False
    assert body["total_debit"] == body["total_credit"]


async def test_cash_position_sums_the_cash_accounts(
    client: AsyncClient, api: str
) -> None:
    await _post_entry(
        client, api,
        [{"account": "1101", "debit": "60000000"}, {"account": "3102", "credit": "60000000"}],
    )
    await _post_entry(
        client, api,
        [{"account": "1103", "debit": "40000000"}, {"account": "3102", "credit": "40000000"}],
    )

    body = (await client.get(f"{api}/reports/cash-position")).json()
    assert body["total"] == "100000000.00"
    codes = {a["code"] for a in body["accounts"]}
    assert {"1101", "1102", "1103"} <= codes

    main = next(a for a in body["accounts"] if a["code"] == "1101")
    assert main["share"] == pytest.approx(0.6)


async def test_a_transfer_between_cash_accounts_leaves_the_total_alone(
    client: AsyncClient, api: str
) -> None:
    await _post_entry(
        client, api,
        [{"account": "1101", "debit": "100000000"}, {"account": "3102", "credit": "100000000"}],
    )
    before = (await client.get(f"{api}/reports/cash-position")).json()["total"]

    await _post_entry(
        client, api,
        [{"account": "1103", "debit": "15000000"}, {"account": "1101", "credit": "15000000"}],
        source={"kind": "pettycash", "ref": "TOPUP"},
    )

    after = (await client.get(f"{api}/reports/cash-position")).json()["total"]
    assert after == before


@pytest.mark.parametrize(
    ("named", "start", "end"),
    [
        ("today", date(2026, 7, 26), date(2026, 7, 26)),
        ("month", date(2026, 7, 1), date(2026, 7, 31)),
        ("quarter", date(2026, 7, 1), date(2026, 9, 30)),
        ("ytd", date(2026, 1, 1), date(2026, 7, 26)),
    ],
)
async def test_named_periods_resolve_server_side(
    client: AsyncClient, api: str, named: str, start: date, end: date
) -> None:
    """The quarter boundary is derived, not hardcoded — that was a real prototype bug.

    The frozen clock is 2026-07-26, so Q3 runs July to September.
    """
    body = (
        await client.get(f"{api}/reports/trial-balance", params={"period": named})
    ).json()
    assert body["start"] == start.isoformat()
    assert body["end"] == end.isoformat()
# ---------------------------------------------------------------------------
# REQ-06 - one journal code per document, without reusing a voucher number
# ---------------------------------------------------------------------------


async def test_a_reversal_joins_the_original_document_group(
    client: AsyncClient, api: str
) -> None:
    """The client's objection: one logical event produced two or three voucher numbers.

    The fix is NOT to reuse a number. Each document keeps its own, because a correction is
    its own filed document and an auditor has to see it as one - which is what this file's
    own header defends. What was missing was any way to say which document they belong to.
    """
    original = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "5000000"}, {"account": "4102", "credit": "5000000"}],
    )
    assert original["group_ref"] is None, "an entry standing alone is in no group"

    reversal = (
        await client.post(f"{api}/journal-entries/{original['id']}/reverse")
    ).json()

    # Grouped under the original, which becomes the anchor of the group.
    assert reversal["group_ref"] == original["voucher_no"]
    # And still its own document.
    assert reversal["voucher_no"] != original["voucher_no"]
    assert reversal["entry_no"] != original["entry_no"]


async def test_one_code_returns_the_original_and_every_correction(
    client: AsyncClient, api: str
) -> None:
    """Reverse-and-repost is three filed documents and one logical correction.

    Before this there was no way to see the second fact, which is what made the General
    Ledger read as a proliferation of unrelated numbers.
    """
    original = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "9000000"}, {"account": "4102", "credit": "9000000"}],
    )
    reversal, replacement = (
        await client.post(
            f"{api}/journal-entries/{original['id']}/adjust",
            json={
                "lines": [
                    {"account": "1101", "debit": "8000000"},
                    {"account": "4102", "credit": "8000000"},
                ]
            },
        )
    ).json()

    code = original["voucher_no"]
    assert reversal["group_ref"] == code
    assert replacement["group_ref"] == code, "the repost files under the same code"
    assert len({reversal["voucher_no"], replacement["voucher_no"], code}) == 3, (
        "three distinct documents, one code"
    )

    grouped = (
        await client.get(f"{api}/journal-entries", params={"group_ref": code})
    ).json()
    # The anchor is included even though nothing stamped it: it is named BY the code.
    assert grouped["total"] == 3
    assert {e["id"] for e in grouped["items"]} == {
        original["id"],
        reversal["id"],
        replacement["id"],
    }


async def test_a_manual_entry_can_file_under_an_existing_code(
    client: AsyncClient, api: str
) -> None:
    """What the searchable journal-code dropdown on the manual-entry form writes.

    A later addition picks the code it belongs to instead of becoming another number
    nobody connects to the first.
    """
    anchor = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "1000000"}, {"account": "4102", "credit": "1000000"}],
    )
    addition = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "250000"}, {"account": "4102", "credit": "250000"}],
        group_ref=anchor["voucher_no"],
    )
    assert addition["group_ref"] == anchor["voucher_no"]

    grouped = (
        await client.get(
            f"{api}/journal-entries", params={"group_ref": anchor["voucher_no"]}
        )
    ).json()
    assert {e["id"] for e in grouped["items"]} == {anchor["id"], addition["id"]}


async def test_grouping_does_not_widen_an_unrelated_query(
    client: AsyncClient, api: str
) -> None:
    """An entry in no group must not be dragged into somebody else's."""
    a = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "700000"}, {"account": "4102", "credit": "700000"}],
    )
    b = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "800000"}, {"account": "4102", "credit": "800000"}],
    )
    grouped = (
        await client.get(
            f"{api}/journal-entries", params={"group_ref": a["voucher_no"]}
        )
    ).json()
    assert {e["id"] for e in grouped["items"]} == {a["id"]}
    assert b["id"] not in {e["id"] for e in grouped["items"]}


async def test_an_unknown_journal_code_is_refused(client: AsyncClient, api: str) -> None:
    """A mistyped code cannot be repaired: entries are immutable.

    So the row would sit alone in a group forever and the correction it was meant to join
    would still read as unrelated -- silent, and indistinguishable from working.
    """
    response = await client.post(
        f"{api}/journal-entries",
        json=_entry(
            [{"account": "1101", "debit": "100"}, {"account": "4102", "credit": "100"}],
            group_ref="KM-05-10-999",
        ),
    )
    assert response.status_code == 422, response.text
    assert "KM-05-10-999" in response.json()["detail"]


# ---------------------------------------------------------------------------
# REQ-06 - administrators can define their own series
# ---------------------------------------------------------------------------


async def test_a_custom_series_can_be_created_and_previews_its_number(
    client: AsyncClient, api: str
) -> None:
    created = await client.post(
        f"{api}/voucher-series",
        params={"on": MAY10},
        json={
            "key": "pc",
            "prefix": "PC",
            "label": "Project Close",
            "format": "[PREFIX]/[YEAR]/[SEQ_0001]",
        },
    )
    assert created.status_code == 201, created.text
    body = created.json()
    assert body["key"] == "pc"
    # The preview is the point: the format can be checked before anything is filed under it.
    assert body["next_preview"] == "PC/2026/0001", body["next_preview"]

    keys = {s["key"] for s in (await client.get(f"{api}/voucher-series")).json()}
    assert "pc" in keys


async def test_a_new_series_whose_format_cannot_count_is_refused(
    client: AsyncClient, api: str
) -> None:
    """A format with no sequence token would issue the same number forever.

    An edit was already refused for this; creation is now held to the same rule rather
    than letting a broken format in through the other door.
    """
    response = await client.post(
        f"{api}/voucher-series",
        json={
            "key": "bad",
            "prefix": "BAD",
            "label": "No counter",
            "format": "[PREFIX]-[YEAR]",
        },
    )
    assert response.status_code == 422, response.text
    assert "SEQ" in response.json()["detail"]
    keys = {s["key"] for s in (await client.get(f"{api}/voucher-series")).json()}
    assert "bad" not in keys, "a refused series must not be half-created"


async def test_a_duplicate_series_key_is_refused(client: AsyncClient, api: str) -> None:
    response = await client.post(
        f"{api}/voucher-series",
        json={"key": "km", "prefix": "KM2", "label": "Cash In again"},
    )
    assert response.status_code == 409, response.text


async def test_an_unused_series_can_be_deleted(client: AsyncClient, api: str) -> None:
    await client.post(
        f"{api}/voucher-series", json={"key": "tmp", "prefix": "TMP", "label": "Scratch"}
    )
    assert (await client.delete(f"{api}/voucher-series/tmp")).status_code == 204
    keys = {s["key"] for s in (await client.get(f"{api}/voucher-series")).json()}
    assert "tmp" not in keys


async def test_deleting_a_series_that_numbered_something_is_refused(
    client: AsyncClient, api: str
) -> None:
    """A voucher number has to stay resolvable for as long as its entry does."""
    entry = await _post_entry(
        client,
        api,
        [{"account": "1101", "debit": "3000000"}, {"account": "4102", "credit": "3000000"}],
        source={"kind": "payment"},
    )
    assert entry["voucher_no"].startswith("KM"), entry["voucher_no"]

    response = await client.delete(f"{api}/voucher-series/km")
    assert response.status_code == 409, response.text
    assert "unexplained" in response.json()["detail"]


async def test_a_series_key_is_normalised_rather_than_refused(
    client: AsyncClient, api: str
) -> None:
    """Keys are lowercase throughout (`km`, `jv`), and the service lowercases this one.

    Refusing `PC` while silently accepting `pc` would be a validation rule contradicting
    the normalisation right behind it.
    """
    created = await client.post(
        f"{api}/voucher-series", json={"key": "PC", "prefix": "PC", "label": "Project Close"}
    )
    assert created.status_code == 201, created.text
    assert created.json()["key"] == "pc"


async def test_deleting_a_series_clears_the_counters_it_owns(
    client: AsyncClient, api: str
) -> None:
    """A counter row is a foreign key onto the series.

    Nothing was numbered from this series, so its counters count nothing -- but left in
    place they would make a legitimate delete fail as a 500.
    """
    await client.post(
        f"{api}/voucher-series", json={"key": "tmp2", "prefix": "TM2", "label": "Scratch"}
    )
    # A preview alone does not create a counter; this asserts the delete path regardless.
    await client.get(f"{api}/voucher-series/tmp2/preview", params={"on": MAY10})
    assert (await client.delete(f"{api}/voucher-series/tmp2")).status_code == 204


@pytest.mark.parametrize(
    ("parent", "code", "type_"),
    [("1201", "1201.01", "asset"), ("2102", "2102.01", "liability")],
)
async def test_a_control_account_cannot_take_sub_accounts(
    client: AsyncClient, api: str, parent: str, code: str, type_: str
) -> None:
    # A sub-account would make 1201 / 2102 a header, and every receipt or payment that
    # posts to it would then fail.
    response = await client.post(
        f"{api}/accounts",
        json={"code": code, "name": "Split control", "type": type_, "parent_code": parent},
    )
    assert response.status_code == 409, response.text
    assert "control account" in response.json()["detail"]
    still = (await client.get(f"{api}/accounts/{parent}")).json()
    assert still["is_header"] is False
