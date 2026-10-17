"""What one search returns."""

from __future__ import annotations

import uuid
from datetime import date as date_type

from app.core.schemas import MoneyStr, Schema


class Hit(Schema):
    """One thing found, in the shape the result list renders.

    `id` is the business number (`EVT-0001`), `uuid` the key â€” the same split the rest of the
    API keeps, and the reason the client can route to a record without a second lookup.
    """

    kind: str
    id: str
    uuid: uuid.UUID
    title: str
    subtitle: str | None = None
    amount: MoneyStr | None = None
    #: Aliased import, because the field is called `date` and the annotation would otherwise
    #: resolve to the field rather than the type -- which Pydantic reports as an unreadable
    #: "unsupported operand for |".
    date: date_type | None = None
    #: Why this ranked where it did. Exposed because a search that cannot be explained cannot
    #: be tuned, and the frontend sorts groups by it.
    score: int
    #: Where to open a hit whose own id is not a page: ``channel:<uuid>``,
    #: ``project:<project no>`` or ``event:<event no>``, the ids the screens route by. A message,
    #: a task or a file is opened through its parent, never by a raw URL.
    ref: str | None = None


class HitGroup(Schema):
    kind: str
    label: str
    total: int
    hits: list[Hit]


class SearchOut(Schema):
    query: str
    total: int
    groups: list[HitGroup]
