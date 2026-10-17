"""Shared response types.

The one rule worth stating: **money crosses the wire as a decimal string**, never as a JSON
number. JSON numbers are IEEE 754 doubles, so ``144000000.00`` would survive but
``0.1 + 0.2`` would not, and a client parsing the payload gets a float back whatever we
intended. A string forces the consumer to make an explicit decision.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Annotated

from pydantic import BaseModel, ConfigDict, PlainSerializer

MoneyStr = Annotated[Decimal, PlainSerializer(str, return_type=str, when_used="json")]


class Schema(BaseModel):
    """Base for every response model."""

    model_config = ConfigDict(from_attributes=True)


class Page[T](Schema):
    items: list[T]
    total: int
