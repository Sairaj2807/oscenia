"""Who we work with at a client, the events they run every year, and the greetings sent them.

The relationship layer of Client 360 (BRD 5.2), and marketing campaigns (BRD 5.1). Relations:

* ``client_contacts`` the people (PICs), with a birthday as ``MM-DD`` (no year: nobody asks).
* ``client_relation_settings`` one row per client: its anniversary, whether to greet it, and how
  many months before a usual event month to nudge.
* ``client_event_cycles`` and ``client_event_editions`` the recurring events a client runs and the
  months they actually ran, which is where "usually July" comes from.
* ``client_nudges_handled`` an edition's nudge that somebody acted on, so it leaves the calendar.
* ``greeting_log`` a greeting somebody marked as sent. Nothing here sends: it records, and the
  unique key stops the same person being greeted twice for the same occasion in a year.

Campaigns: ``campaigns`` and ``campaign_recipients``, a fixed snapshot of who was meant to be
reached.
"""

from __future__ import annotations

import datetime as dt
import uuid

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base

CHANNELS = ("whatsapp", "email", "both")
GREETING_KINDS = ("Birthday", "Company anniversary")

_MONTH_DAY = r"^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$"
_CHANNEL_SQL = "channel IN ('whatsapp', 'email', 'both')"


class ClientContact(Base):
    __tablename__ = "client_contacts"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))
    role: Mapped[str] = mapped_column(String(80), default="", server_default="")
    phone: Mapped[str] = mapped_column(String(64), default="", server_default="")
    email: Mapped[str] = mapped_column(String(200), default="", server_default="")
    #: ``MM-DD``, validated by the database as well as the rules (29 February is allowed).
    birthday: Mapped[str | None] = mapped_column(String(5), nullable=True)
    greet: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    channel: Mapped[str] = mapped_column(String(10), default="whatsapp", server_default="whatsapp")
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        CheckConstraint(f"birthday IS NULL OR birthday ~ '{_MONTH_DAY}'", name="birthday_mm_dd"),
        CheckConstraint(_CHANNEL_SQL, name="channel_known"),
    )


class ClientRelationSettings(Base):
    __tablename__ = "client_relation_settings"

    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True
    )
    anniversary: Mapped[dt.date | None] = mapped_column(Date, nullable=True)
    greet_anniversary: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    anniversary_channel: Mapped[str] = mapped_column(
        String(10), default="whatsapp", server_default="whatsapp"
    )
    nudge_lead_months: Mapped[int] = mapped_column(Integer, default=3, server_default="3")

    __table_args__ = (
        CheckConstraint("nudge_lead_months BETWEEN 1 AND 12", name="lead_months_range"),
        CheckConstraint(
            "anniversary_channel IN ('whatsapp', 'email', 'both')", name="anniversary_channel_known"
        ),
    )


class ClientEventCycle(Base):
    """A recurring event a client runs ("Annual Gala")."""

    __tablename__ = "client_event_cycles"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(120))

    __table_args__ = (
        UniqueConstraint("client_id", "name", name="uq_client_event_cycles_client_id_name"),
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        # The nudge key is ``<name>:<edition>``, so a colon in a name would make it ambiguous.
        CheckConstraint("position(':' in name) = 0", name="name_has_no_colon"),
    )


class ClientEventEdition(Base):
    """A month an event ran (``YYYY-MM``). The usual month is the most common of these."""

    __tablename__ = "client_event_editions"

    cycle_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True),
        ForeignKey("client_event_cycles.id", ondelete="CASCADE"),
        primary_key=True,
    )
    edition: Mapped[str] = mapped_column(String(7), primary_key=True)

    __table_args__ = (
        CheckConstraint(r"edition ~ '^\d{4}-(0[1-9]|1[0-2])$'", name="edition_yyyy_mm"),
    )


class ClientNudgeHandled(Base):
    """Somebody reached out about this edition; it leaves the calendar."""

    __tablename__ = "client_nudges_handled"

    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), primary_key=True
    )
    #: ``<cycle name>:<YYYY-MM>``, as the calendar keys it.
    key: Mapped[str] = mapped_column(String(160), primary_key=True)
    note: Mapped[str] = mapped_column(Text, default="", server_default="")
    handled_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    handled_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )


class GreetingLog(Base):
    """A greeting someone marked as sent by hand."""

    __tablename__ = "greeting_log"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    client_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(24))
    #: The person (a birthday) or the company (an anniversary) it was for.
    to_name: Mapped[str] = mapped_column(String(160))
    channel: Mapped[str] = mapped_column(String(10))
    #: The year of the occasion, so one person is greeted once per occasion per year.
    occasion_year: Mapped[int] = mapped_column(Integer)
    marked_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    marked_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        UniqueConstraint(
            "client_id",
            "kind",
            "to_name",
            "occasion_year",
            name="uq_greeting_log_client_id_kind_to_name_occasion_year",
        ),
        CheckConstraint("kind IN ('Birthday', 'Company anniversary')", name="kind_known"),
        CheckConstraint(_CHANNEL_SQL, name="channel_known"),
    )


class Campaign(Base):
    """A marketing campaign: a record of who was meant to be reached, with what, and by whom.

    Nothing is sent from here (there is no sending provider yet). The audience is fixed when the
    campaign is made, from the contacts ticked and the consent they had at that moment, and is never
    rewritten afterwards: what changes later is whether each person has been marked as reached, and
    whether they have since unsubscribed or been erased.
    """

    __tablename__ = "campaigns"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    campaign_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(160))
    channel: Mapped[str] = mapped_column(String(10))
    message: Mapped[str] = mapped_column(Text, default="", server_default="")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    #: How many contacts were ticked, how many of those were left out for having no marketing
    #: consent, and how many could not be reached on this channel (no phone for WhatsApp, no email
    #: for email).
    requested_count: Mapped[int] = mapped_column(Integer)
    skipped_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    unreachable_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    __table_args__ = (
        CheckConstraint("channel IN ('whatsapp', 'email')", name="channel_known"),
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        CheckConstraint("char_length(message) <= 2000", name="message_not_too_long"),
    )


class CampaignRecipient(Base):
    """One person in a campaign, as they were when it was made."""

    __tablename__ = "campaign_recipients"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    campaign_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("campaigns.id", ondelete="CASCADE"), index=True
    )
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(160), default="", server_default="")
    phone: Mapped[str] = mapped_column(String(64), default="", server_default="")
    email: Mapped[str] = mapped_column(String(200), default="", server_default="")
    #: The contact's key (``p:<phone>`` or ``e:<email>``), so an unsubscribe can find them. Personal
    #: data like the rest of the row, and cleared with it on erasure.
    contact_key: Mapped[str | None] = mapped_column(String(120), nullable=True, index=True)
    #: The guests this person was merged from, so erasing any one of them clears this row.
    source_guest_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(PgUUID(as_uuid=True)), default=list, server_default=text("'{}'")
    )
    #: The consent they had when the campaign was made. Kept as it was, never updated.
    consent_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    consent_source: Mapped[str | None] = mapped_column(String(160), nullable=True)
    sent_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    sent_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    #: Set when they unsubscribed after the campaign was made and before they were reached.
    unsubscribed_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: Set when a guest they were merged from was erased: name, phone and email are blanked.
    erased_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "campaign_id", "position", name="uq_campaign_recipients_campaign_id_position"
        ),
    )
