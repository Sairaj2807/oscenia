"""Backlog item 6 — a real file on a CRM note.

The screen used to record a typed file name. Now an uploaded file (the same store receipts use) is
filed against a note, listed on it, and can be taken off again; the stored file survives the removal
of one note's link (it may be filed elsewhere).
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from test_ar import _client_id
from test_cash import PDF, _upload

from app.domain.masters.models import Role


async def _note(
    client: AsyncClient, api: str, text: str = "Site visit", client_id: str | None = None
) -> dict:
    client_id = client_id or await _client_id(client, api)
    r = await client.post(f"{api}/clients/{client_id}/interactions", json={"note": text})
    assert r.status_code == 201, r.text
    return r.json()


async def test_a_new_note_has_no_files(client: AsyncClient, api: str) -> None:
    assert (await _note(client, api))["attachments"] == []


async def test_a_stored_file_can_be_filed_against_a_note_and_is_listed_with_it(
    client: AsyncClient, api: str
) -> None:
    note = await _note(client, api)
    stored = await _upload(client, api, "brief.pdf")

    r = await client.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    assert r.status_code == 200, r.text
    [ref] = r.json()["attachments"]
    assert ref["id"] == stored["id"] and ref["filename"] == "brief.pdf"
    assert ref["byte_size"] == len(PDF)

    listed = (await client.get(f"{api}/clients/{note['client_id']}/interactions")).json()
    assert [f["filename"] for f in listed[0]["attachments"]] == ["brief.pdf"]
    # And the bytes are still there to open.
    assert (await client.get(f"{api}/attachments/{stored['id']}")).status_code == 200


async def test_filing_the_same_file_twice_is_a_no_op(client: AsyncClient, api: str) -> None:
    note = await _note(client, api)
    stored = await _upload(client, api)
    body = {"attachment_id": stored["id"]}
    await client.post(f"{api}/interactions/{note['id']}/attachments", json=body)
    again = await client.post(f"{api}/interactions/{note['id']}/attachments", json=body)
    assert again.status_code == 200 and len(again.json()["attachments"]) == 1


async def test_a_file_comes_off_a_note_but_stays_stored_and_on_other_notes(
    client: AsyncClient, api: str
) -> None:
    first = await _note(client, api, "first")
    second = await _note(client, api, "second", client_id=first["client_id"])
    stored = await _upload(client, api, "shared.pdf")
    for n in (first, second):
        await client.post(
            f"{api}/interactions/{n['id']}/attachments", json={"attachment_id": stored["id"]}
        )

    gone = await client.delete(f"{api}/interactions/{first['id']}/attachments/{stored['id']}")
    assert gone.status_code == 204
    notes = {
        n["id"]: n
        for n in (await client.get(f"{api}/clients/{first['client_id']}/interactions")).json()
    }
    assert notes[first["id"]]["attachments"] == []
    assert [f["id"] for f in notes[second["id"]]["attachments"]] == [stored["id"]]
    assert (await client.get(f"{api}/attachments/{stored['id']}")).status_code == 200
    # Taking it off again is harmless.
    assert (
        await client.delete(f"{api}/interactions/{first['id']}/attachments/{stored['id']}")
    ).status_code == 204


async def test_deleting_a_note_removes_the_link_and_not_the_file(
    client: AsyncClient, api: str
) -> None:
    note = await _note(client, api)
    stored = await _upload(client, api)
    await client.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    assert (await client.delete(f"{api}/interactions/{note['id']}")).status_code == 204
    assert (await client.get(f"{api}/attachments/{stored['id']}")).status_code == 200


async def test_an_unknown_note_or_file_is_a_404(client: AsyncClient, api: str) -> None:
    note = await _note(client, api)
    ghost = str(uuid.uuid4())
    assert (
        await client.post(f"{api}/interactions/{ghost}/attachments", json={"attachment_id": ghost})
    ).status_code == 404
    assert (
        await client.post(
            f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": ghost}
        )
    ).status_code == 404
    assert (
        await client.delete(f"{api}/interactions/{ghost}/attachments/{ghost}")
    ).status_code == 404


async def test_editing_a_note_keeps_its_files_in_the_answer(client: AsyncClient, api: str) -> None:
    note = await _note(client, api)
    stored = await _upload(client, api, "kept.pdf")
    await client.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    edited = await client.patch(
        f"{api}/interactions/{note['id']}", json={"note": "Site visit, revised"}
    )
    assert edited.status_code == 200
    assert [f["filename"] for f in edited.json()["attachments"]] == ["kept.pdf"]


async def test_only_people_who_may_edit_clients_can_file_or_remove_files(
    client: AsyncClient, client_for, api: str
) -> None:
    note = await _note(client, api)
    stored = await _upload(client, api)
    await client.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    warehouse = await client_for(Role.WAREHOUSE)
    r = await warehouse.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    assert r.status_code == 403 and r.json()["action"] == "edit_client"
    assert (
        await warehouse.delete(f"{api}/interactions/{note['id']}/attachments/{stored['id']}")
    ).status_code == 403
    sales = await client_for(Role.SALES)
    ok = await sales.post(
        f"{api}/interactions/{note['id']}/attachments", json={"attachment_id": stored["id"]}
    )
    assert ok.status_code == 200
