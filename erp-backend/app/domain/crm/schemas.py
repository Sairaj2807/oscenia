"""What the relationship endpoints accept and return."""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.schemas import Schema

Channel = Literal["whatsapp", "email", "both"]
GreetingKind = Literal["Birthday", "Company anniversary"]


class ContactIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    role: str = Field(default="", max_length=80)
    phone: str = Field(default="", max_length=64)
    email: str = Field(default="", max_length=200)
    #: ``MM-DD``. Checked by the rules, so ``02-30`` is refused and ``02-29`` is not.
    birthday: str | None = None
    greet: bool = True
    channel: Channel = "whatsapp"


class ContactPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    role: str | None = Field(default=None, max_length=80)
    phone: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=200)
    birthday: str | None = None
    greet: bool | None = None
    channel: Channel | None = None


class ContactOut(Schema):
    id: uuid.UUID
    name: str
    role: str
    phone: str
    email: str
    birthday: str | None
    greet: bool
    channel: str


class SettingsPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    anniversary: dt.date | None = None
    greet_anniversary: bool | None = None
    anniversary_channel: Channel | None = None
    nudge_lead_months: int | None = Field(default=None, ge=1, le=12)


class CycleIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=120)
    #: Months the event ran, ``YYYY-MM``.
    history: list[str] = Field(default_factory=list, max_length=60)


class CyclePatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=120)
    history: list[str] | None = Field(default=None, max_length=60)


class CycleOut(Schema):
    id: uuid.UUID
    name: str
    history: list[str]


class NudgeHandle(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=3, max_length=160)
    note: str = Field(default="", max_length=2000)


class HandledOut(Schema):
    key: str
    note: str
    handled_at: dt.datetime


class GreetingMark(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: GreetingKind
    #: The person (a birthday) or the company (an anniversary) it was for.
    to: str = Field(min_length=1, max_length=160)
    channel: Channel
    year: int = Field(ge=2000, le=2100)


class GreetingOut(Schema):
    id: uuid.UUID
    kind: str
    to: str
    channel: str
    occasion_year: int
    marked_at: dt.datetime


class RelationsOut(Schema):
    contacts: list[ContactOut]
    anniversary: dt.date | None
    greet_anniversary: bool
    anniversary_channel: str
    nudge_lead_months: int
    cycles: list[CycleOut]
    handled_nudges: list[HandledOut]
    greetings: list[GreetingOut]


class CalendarItem(Schema):
    kind: str
    client_id: uuid.UUID
    client_no: str
    client: str
    date: dt.date
    in_days: int
    #: ``<cycle>:<YYYY-MM>`` for a nudge; empty otherwise.
    key: str | None = None
    title: str
    detail: str = ""
    pic_id: uuid.UUID | None = None
    #: Whether the automatic greeting is switched on for this person or company.
    greet: bool = False
    channel: str | None = None
    already_sent: bool = False
    #: A greeting's text and the links that open it ready to send. Nothing is sent from here: a
    #: person opens the link and presses send, then marks it sent.
    message: str | None = None
    whatsapp_url: str | None = None
    email_url: str | None = None


# --- the contact list and campaigns -----------------------------------------------------------

CampaignChannel = Literal["whatsapp", "email"]


class ContactEventOut(Schema):
    #: The event's number (``EVT-0001``), as the screens route by it.
    event_id: str
    name: str
    date: str
    rsvp: str
    came: bool


class GuestContactOut(Schema):
    """One person pooled from every event's guests; ``key`` names them in a campaign."""

    key: str
    name: str
    phone: str
    email: str
    events: list[ContactEventOut]
    consent: bool
    consent_at: dt.datetime | None
    consent_source: str | None


class CampaignCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=160)
    channel: CampaignChannel
    message: str = Field(default="", max_length=2000)
    #: The contacts ticked. The server rebuilds the audience from these; nothing else is trusted.
    keys: list[str] = Field(min_length=1, max_length=5000)


class Unsubscribe(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=3, max_length=120)


class UnsubscribeOut(Schema):
    guests: int
    pending_recipients: int


class RecipientOut(Schema):
    id: uuid.UUID
    position: int
    name: str
    phone: str
    email: str
    consent_at: dt.datetime | None
    consent_source: str | None
    sent_at: dt.datetime | None
    unsubscribed_at: dt.datetime | None
    erased: bool
    #: ``sent``, ``unsubscribed``, ``erased`` or ``pending``.
    status: str
    #: A link that opens the message ready to send, for a recipient still to be reached. Nothing is
    #: sent from here.
    link: str | None = None


class CampaignOut(Schema):
    id: uuid.UUID
    campaign_no: str
    name: str
    channel: str
    message: str
    created_at: dt.datetime
    created_by: str | None = None
    requested_count: int
    skipped_count: int
    unreachable_count: int
    recipient_count: int
    sent_count: int


class CampaignDetail(CampaignOut):
    recipients: list[RecipientOut]
