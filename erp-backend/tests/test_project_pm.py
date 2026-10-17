"""A project's PM, readable by anyone signed in and assignable by CEO or PM (``manage_workspace``).

The column existed but nothing set it and the API never returned it, so every live project showed
no PM. It is now returned with the person's name, and set through ``PUT /projects/{id}/pm``.
"""

from __future__ import annotations

import uuid

from httpx import AsyncClient
from test_ar import _confirmed

from app.domain.masters.models import Role


async def _me(client: AsyncClient, api: str) -> dict:
    return (await client.get(f"{api}/auth/me")).json()


async def _project_row(client: AsyncClient, api: str, project: dict) -> dict:
    rows = (await client.get(f"{api}/projects")).json()
    return next(r for r in rows if r["id"] == project["id"])


async def test_a_new_project_has_no_pm(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    row = await _project_row(client, api, project)
    assert row["pm_user_id"] is None
    assert row["pm_name"] is None


async def test_setting_the_pm_names_them_in_the_list_and_the_detail(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    me = await _me(client, api)

    r = await client.put(f"{api}/projects/{project['id']}/pm", json={"user_id": me["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["pm_user_id"] == me["id"]
    assert r.json()["pm_name"] == me["full_name"]

    row = await _project_row(client, api, project)
    assert row["pm_name"] == me["full_name"]
    detail = (await client.get(f"{api}/projects/{project['id']}")).json()
    assert detail["pm_name"] == me["full_name"]


async def test_the_pm_can_be_cleared(client: AsyncClient, api: str) -> None:
    project = await _confirmed(client, api)
    me = await _me(client, api)
    await client.put(f"{api}/projects/{project['id']}/pm", json={"user_id": me["id"]})

    r = await client.put(f"{api}/projects/{project['id']}/pm", json={"user_id": None})
    assert r.status_code == 200, r.text
    assert r.json()["pm_user_id"] is None
    assert (await _project_row(client, api, project))["pm_name"] is None


async def test_an_unknown_user_is_a_404_and_changes_nothing(
    client: AsyncClient, api: str
) -> None:
    project = await _confirmed(client, api)
    r = await client.put(f"{api}/projects/{project['id']}/pm", json={"user_id": str(uuid.uuid4())})
    assert r.status_code == 404
    assert (await _project_row(client, api, project))["pm_user_id"] is None


async def test_finance_may_read_but_not_assign_the_pm(
    client: AsyncClient, api: str, client_for
) -> None:
    project = await _confirmed(client, api)
    me = await _me(client, api)

    finance = await client_for(Role.FINANCE)
    refused = await finance.put(f"{api}/projects/{project['id']}/pm", json={"user_id": me["id"]})
    assert refused.status_code == 403
    assert (await finance.get(f"{api}/projects/{project['id']}")).status_code == 200


async def test_a_pm_may_assign_the_pm(client: AsyncClient, api: str, client_for) -> None:
    project = await _confirmed(client, api)

    pm = await client_for(Role.PM)
    me = await _me(pm, api)
    r = await pm.put(f"{api}/projects/{project['id']}/pm", json={"user_id": me["id"]})
    assert r.status_code == 200, r.text
    assert r.json()["pm_name"] == me["full_name"]
