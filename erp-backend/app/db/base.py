"""Declarative base and the constraint naming convention.

The naming convention matters more than it looks. Alembic autogenerate cannot drop or
alter an unnamed constraint, and this schema leans on named CHECKs and triggers that will
be revised across eight phases. Setting it now avoids a class of migration that cannot be
written later.
"""

from __future__ import annotations

from sqlalchemy import MetaData
from sqlalchemy.ext.asyncio import AsyncAttrs
from sqlalchemy.orm import DeclarativeBase

NAMING_CONVENTION = {
    "ix": "ix_%(table_name)s_%(column_0_N_name)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(AsyncAttrs, DeclarativeBase):
    """Declarative base for every model.

    ``AsyncAttrs`` is mixed in so a relationship can be awaited explicitly —
    ``await obj.awaitable_attrs.some_collection``. Under asyncio a plain attribute access
    that has to hit the database raises ``MissingGreenlet`` instead of loading, and the
    place that bites is not a query but a **freshly created** object: eager ``selectin``
    loading fires when a row is *loaded*, and an object built with ``session.add()`` was
    never loaded, so its collections are simply absent. Awaiting is a no-op when the
    collection is already there, which makes it safe to use on both paths.
    """

    metadata = MetaData(naming_convention=NAMING_CONVENTION)
