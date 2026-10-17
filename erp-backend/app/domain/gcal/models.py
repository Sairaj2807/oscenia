"""Google Calendar: who has connected an account, and which CRM dates were pushed to it.

The refresh token is the long-lived credential, so it is stored encrypted (``crypto.py``) and never
returned by any endpoint. One connection per user: a person's calendar is theirs, not the company's.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class GoogleConnection(Base):
    __tablename__ = "google_connections"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    account_email: Mapped[str] = mapped_column(String(255))
    #: Fernet-encrypted. Never leaves the server.
    refresh_token_enc: Mapped[str] = mapped_column(Text)
    #: The scopes Google granted, space separated. Decides whether CRM dates can be written back.
    scopes: Mapped[str] = mapped_column(Text)
    #: Show this person's Google events beside the CRM dates.
    show_google: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    #: Push upcoming client birthdays and anniversaries to this person's Google calendar.
    add_crm_dates: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    connected_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class GoogleSyncedDate(Base):
    """A CRM date already written to a person's Google calendar.

    ``key`` is ``<client_no>:<kind>:<year>``: the same birthday in the same year is written once,
    however many times the sync runs.
    """

    __tablename__ = "google_synced_dates"

    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    google_event_id: Mapped[str] = mapped_column(String(255))
    synced_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
