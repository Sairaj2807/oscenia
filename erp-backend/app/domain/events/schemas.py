"""Request and response shapes for the events module.

Field names follow the API's snake_case; the content documents inside an invitation keep
the prototype's own keys (``mapUrl``, ``trackId``) because the renderer reads them as-is.
"""

from __future__ import annotations

import datetime as dt
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.core.schemas import Schema

# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


class EventCreate(BaseModel):
    name: str = Field(min_length=1, max_length=160)
    date: dt.date
    time: str = "19:00"
    venue: str = Field(default="", max_length=300)
    client_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


class RsvpFields(BaseModel):
    email: bool | None = None
    allergies: bool | None = None
    pax: bool | None = None


class EventUpdate(BaseModel):
    """Every field optional; only the ones sent change.

    ``date``, ``time``, ``venue`` and ``status`` are **declared in order to be refused**: the
    date, time and venue move with the invitation's details (straight away before the first
    publish, at Publish after it — D8), and publishing is its own endpoint. Leaving them out
    would make Pydantic drop them silently and return 200, and the caller would believe the
    event had moved.
    """

    name: str | None = Field(default=None, max_length=160)
    date: dt.date | None = None
    time: str | None = None
    venue: str | None = Field(default=None, max_length=300)
    status: str | None = None
    rsvp_deadline: dt.date | None = None
    max_pax: int | None = None
    rsvp_fields: RsvpFields | None = None
    feedback_url: str | None = Field(default=None, max_length=500)
    hold_wishes: bool | None = None
    client_id: uuid.UUID | None = None
    project_id: uuid.UUID | None = None


class StatsOut(Schema):
    invited: int
    attending: int
    declined: int
    no_response: int
    pax: int
    allergies: int
    off_list: int
    checked_in: int
    walk_ins: int


class EventOut(Schema):
    id: uuid.UUID
    event_no: str
    name: str
    client_id: uuid.UUID | None
    project_id: uuid.UUID | None
    date: dt.date
    time: str
    venue: str
    status: str
    rsvp_deadline: dt.date
    max_pax: int
    rsvp_fields: dict[str, bool]
    feedback_url: str
    hold_wishes: bool
    rsvp_open: bool
    #: The guest numbers the events list shows (the same counting as the report's `stats`), so
    #: the list needs no guest fetch. Filled by the list and detail routes; None elsewhere.
    stats: StatsOut | None = None
    updated_at: dt.datetime


class InviteOut(BaseModel):
    template_id: str | None
    accent: str | None
    on: dict[str, bool]
    content: dict[str, Any]
    published: dict[str, Any] | None
    published_at: dt.datetime | None
    has_unpublished_changes: bool


class ReviewOut(BaseModel):
    state: Literal["editing", "submitted", "returned"]
    submitted_at: dt.datetime | None
    submitted_by: str | None
    note: str
    returned_at: dt.datetime | None


class QuestionOut(Schema):
    key: str
    label: str
    type: str
    options: list[str]
    multi: bool
    required: bool
    attending_only: bool


class CheckpointOut(Schema):
    id: uuid.UUID
    key: str
    name: str
    categories: list[str]


class EventDetail(EventOut):
    invite: InviteOut
    review: ReviewOut
    questions: list[QuestionOut]
    checkpoints: list[CheckpointOut]
    tables: list[str]


# ---------------------------------------------------------------------------
# Invitation editor and review
# ---------------------------------------------------------------------------


class TemplateChoice(BaseModel):
    template_id: str = Field(min_length=1, max_length=40)


class SectionToggle(BaseModel):
    on: bool


class SectionContent(BaseModel):
    value: dict[str, Any]


class AccentIn(BaseModel):
    accent: str | None


class ReturnIn(BaseModel):
    note: str = Field(max_length=2000)


class PublishIn(BaseModel):
    clamp_deadline: bool = False


class ClientLinkOut(BaseModel):
    token: str
    version: int
    expires_at: dt.datetime


# ---------------------------------------------------------------------------
# Template Studio
# ---------------------------------------------------------------------------


class TemplateOut(Schema):
    id: str
    builtin: bool
    family: str
    name: str
    tagline: str
    palette: dict[str, str]
    fonts: dict[str, str]
    cover: str
    ornament: str
    sections: list[str]
    off: list[str]
    art: dict[str, Any]
    status: str
    created_by_label: str
    updated_at: dt.datetime
    used_by_events: int = 0
    live_events: int = 0


class TemplateCreate(BaseModel):
    from_id: str | None = Field(default=None, max_length=40)
    family: Literal["corporate", "private"] = "private"


class TemplateUpdate(BaseModel):
    """The editor's settings. Unknown keys (``id``, ``status``) are ignored, not refused —
    the studio sends its whole working copy."""

    name: str | None = None
    tagline: str | None = None
    family: str | None = None
    palette: dict[str, Any] | None = None
    fonts: dict[str, Any] | None = None
    cover: str | None = None
    ornament: str | None = None
    sections: list[Any] | None = None
    off: list[Any] | None = None


class FileRef(BaseModel):
    key: str = Field(min_length=1, max_length=200)
    name: str = Field(default="", max_length=200)
    size: int = Field(default=0, ge=0)
    type: str = Field(default="", max_length=100)


class ArtIn(BaseModel):
    ref: FileRef | None


class MediaOut(BaseModel):
    """An uploaded file as content holds it: ``key`` is the upload's id."""

    key: str
    name: str
    size: int
    type: str


# ---------------------------------------------------------------------------
# Guests, questions, tables, checkpoints
# ---------------------------------------------------------------------------


class GuestIn(BaseModel):
    name: str = Field(max_length=160)
    phone: str = Field(max_length=64)
    email: str = Field(default="", max_length=200)
    table: str = Field(default="", max_length=200)
    category: str = Field(default="", max_length=40)


class GuestsIn(BaseModel):
    guests: list[GuestIn] = Field(max_length=5000)


class CsvIn(BaseModel):
    #: About a megabyte: tens of thousands of rows, far beyond any guest list.
    csv: str = Field(max_length=1_000_000)


class AddResultOut(BaseModel):
    added: int
    skipped: int


class GuestOut(Schema):
    id: uuid.UUID
    event_id: uuid.UUID
    name: str
    phone: str
    email: str
    category: str
    on_master_list: bool
    rsvp: str | None
    pax: int
    allergies: str
    answers: dict[str, Any]
    consent: bool
    consent_at: dt.datetime | None
    responded_at: dt.datetime | None
    table: str
    note: str
    note_by: str | None
    note_at: dt.datetime | None
    checked_in_at: dt.datetime | None
    walk_in: bool
    invited_at: dt.datetime | None
    invited_via: str | None
    erased_at: dt.datetime | None
    #: The personal-link key (``?g=``) and the access-card QR, both revoked together.
    link_token: str
    qr: str


class TableIn(BaseModel):
    table: str = Field(max_length=200)


class CategoryIn(BaseModel):
    category: str = Field(max_length=40)


class NoteIn(BaseModel):
    note: str = Field(max_length=5000)


class EmailIn(BaseModel):
    email: str = Field(max_length=320)


class QuestionCreate(BaseModel):
    type: str = "text"


class QuestionUpdate(BaseModel):
    label: str | None = Field(default=None, max_length=1000)
    type: str | None = None
    options: list[Any] | None = Field(default=None, max_length=200)
    multi: bool | None = None
    required: bool | None = None
    attending_only: bool | None = None


class MoveIn(BaseModel):
    direction: Literal[-1, 1]


class NameIn(BaseModel):
    name: str = Field(max_length=200)


class CheckpointUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    categories: list[str] | None = Field(default=None, max_length=20)


# ---------------------------------------------------------------------------
# Check-in, walk-ins, wishes, report
# ---------------------------------------------------------------------------


class ScanIn(BaseModel):
    """Either a guest picked from the list, or a scanned access-card code."""

    guest_id: uuid.UUID | None = None
    qr: str | None = Field(default=None, max_length=300)
    #: Omitted: the event's first checkpoint (the entrance).
    checkpoint_id: uuid.UUID | None = None


class ScanOut(BaseModel):
    scan_id: int
    at: dt.datetime
    checkpoint_id: uuid.UUID
    checkpoint_name: str
    #: For the desk to judge; the scan is logged either way.
    first_arrival: bool
    repeat_here: bool
    admitted: bool
    guest: GuestOut


class ScanLogOut(Schema):
    id: int
    guest_id: uuid.UUID
    checkpoint_id: uuid.UUID
    at: dt.datetime


class WalkInIn(BaseModel):
    name: str = Field(max_length=160)
    phone: str = Field(max_length=64)
    email: str = Field(default="", max_length=200)
    consent: bool = False


class WalkInOut(BaseModel):
    walk_in: bool
    guest: GuestOut


class WishOut(BaseModel):
    id: int
    guest_id: uuid.UUID | None
    name: str
    text: str
    at: dt.datetime
    hidden: bool
    approved: bool
    state: Literal["shown", "waiting", "hidden"]


class HiddenIn(BaseModel):
    hidden: bool


class AnswerCountOut(BaseModel):
    key: str
    label: str
    counts: dict[str, int]
    no_answer: int


class CheckpointCountOut(BaseModel):
    id: uuid.UUID
    name: str
    scans: int


class ReportOut(BaseModel):
    stats: StatsOut
    #: Guest ids in each cell of the post-event grid.
    grid: dict[str, list[uuid.UUID]]
    answers: list[AnswerCountOut]
    checkpoints: list[CheckpointCountOut]
