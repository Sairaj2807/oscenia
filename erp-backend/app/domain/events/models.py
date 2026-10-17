"""Events, invitations, guests and check-in (BRD §4; the prototype's ``useProto`` events
slice, ``useProto.js`` ~797–1468).

What used to be one nested browser object per event is normalised where a list has its own
rules — questions keep ids that are never reused, checkpoints refuse deletion once scanned,
guests are matched and de-duplicated by phone — and kept as JSONB where it is a document
edited as a whole: the invitation's section content.

**Ids.** Rows are keyed by UUID. Events also carry ``event_no`` (``EV-01``) for people.
Questions and checkpoints carry a per-event ``key`` (``Q-3``, ``CP-2``) because guests'
answers are keyed by question key, exactly as in the prototype, and a removed question's key
is never handed out again (``events.question_seq``).

**Links.** Nothing secret is stored: guest and client links are HMAC-signed over the row's
id and its version (``app/core/links.py``). Bumping ``guests.link_version`` or
``events.edit_link_version`` revokes every copy of the old link — and the old QR code.
"""

from __future__ import annotations

import datetime as dt
import enum
import uuid
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base
from app.domain.masters.models import enum_column


class EventStatus(enum.StrEnum):
    DRAFT = "Draft"
    PUBLISHED = "Published"


class RsvpAnswer(enum.StrEnum):
    ATTENDING = "Attending"
    DECLINED = "Declined"


class GuestCategory(enum.StrEnum):
    VIP = "VIP"
    MEDIA = "Media"
    REGULAR = "Regular"
    VENDOR = "Vendor"


class InvitedVia(enum.StrEnum):
    PLATFORM = "platform"
    CLIENT = "client"


class ReviewState(enum.StrEnum):
    SUBMITTED = "submitted"
    RETURNED = "returned"
    #: Published (or otherwise resolved): the draft is back to plain editing.
    CLOSED = "closed"


# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------


class InvitationTemplate(Base):
    """A built-in (inserted by migration, never edited) or a Template Studio design.

    Nothing is ever hard-deleted: an archived template leaves the gallery but keeps drawing
    the invitations already on it.
    """

    __tablename__ = "invitation_templates"

    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    family: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(40))
    tagline: Mapped[str] = mapped_column(String(120), default="")
    palette: Mapped[dict[str, str]] = mapped_column(JSONB)
    #: Font *keys* (``playfair``), not CSS stacks — the frontend owns the font list.
    fonts: Mapped[dict[str, str]] = mapped_column(JSONB)
    cover: Mapped[str] = mapped_column(String(16))
    ornament: Mapped[str] = mapped_column(String(16))
    sections: Mapped[list[str]] = mapped_column(JSONB)
    off: Mapped[list[str]] = mapped_column(JSONB)
    #: Slot → stored-file reference or null.
    art: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(16), default="draft")

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    created_by_label: Mapped[str] = mapped_column(String(120), default="")

    __table_args__ = (
        CheckConstraint("family IN ('corporate', 'private')", name="family_known"),
        CheckConstraint("status IN ('draft', 'published', 'archived')", name="status_known"),
        CheckConstraint("NOT builtin OR status = 'published'", name="builtin_published"),
    )

    def as_dict(self) -> dict[str, Any]:
        """The stored shape ``validate_template`` and the renderer read."""
        return {
            "id": self.id,
            "family": self.family,
            "name": self.name,
            "tagline": self.tagline,
            "palette": dict(self.palette),
            "fonts": dict(self.fonts),
            "cover": self.cover,
            "ornament": self.ornament,
            "sections": list(self.sections),
            "off": list(self.off),
            "art": dict(self.art),
            "status": self.status,
        }


# ---------------------------------------------------------------------------
# Events
# ---------------------------------------------------------------------------


class Event(Base):
    __tablename__ = "events"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_no: Mapped[str] = mapped_column(String(16), unique=True)
    name: Mapped[str] = mapped_column(String(160))

    #: Both optional: the prototype allows an event with no project (``createEvent``).
    client_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("clients.id"), nullable=True
    )
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id"), nullable=True
    )

    #: Wall-clock at the venue. Reminders, the RSVP deadline and check-in key off these.
    #: Until the first publish an edit to the invitation's details moves them; after it,
    #: only publishing does (D8).
    date: Mapped[dt.date] = mapped_column(Date)
    time: Mapped[str] = mapped_column(String(5), default="")
    venue: Mapped[str] = mapped_column(String(300), default="")

    status: Mapped[EventStatus] = mapped_column(
        enum_column(EventStatus, "event_status"), default=EventStatus.DRAFT
    )
    rsvp_deadline: Mapped[dt.date] = mapped_column(Date)
    max_pax: Mapped[int] = mapped_column(Integer, default=2)
    #: Which optional RSVP fields the form shows: ``{email, allergies, pax}``.
    rsvp_fields: Mapped[dict[str, bool]] = mapped_column(
        JSONB, default=lambda: {"email": True, "allergies": True, "pax": True}
    )
    feedback_url: Mapped[str] = mapped_column(String(500), default="")
    #: While on, new wishes wait for approval. Wishes already showing stay up.
    hold_wishes: Mapped[bool] = mapped_column(Boolean, default=False)

    #: Highest question / checkpoint number ever issued, so a removed one's key is never
    #: reused and its old answers or scans cannot reattach to a newcomer.
    question_seq: Mapped[int] = mapped_column(Integer, default=0)
    checkpoint_seq: Mapped[int] = mapped_column(Integer, default=0)

    #: The client edit link's version. Regenerating the link bumps it (D14).
    edit_link_version: Mapped[int] = mapped_column(Integer, default=1)

    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        CheckConstraint("max_pax BETWEEN 1 AND 50", name="max_pax_range"),
        CheckConstraint("edit_link_version >= 1", name="edit_link_version_positive"),
        CheckConstraint(
            "\"time\" = '' OR \"time\" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'",
            name="time_hhmm",
        ),
        Index("ix_events_date", "date"),
    )


class EventInvite(Base):
    """The invitation: the draft staff and the client edit, and the copy guests see (D7).

    ``published`` is a snapshot of the draft at Publish — ``{template_id, accent, on,
    content}`` — and ``published_template`` the template as it was then, so what guests saw
    can always be reconstructed even after the studio edits or archives it.

    Both store Python ``None`` as SQL NULL (``none_as_null``). JSONB otherwise writes the JSON
    value ``null``, which ``published_has_time`` rightly refuses for a never-published invite.
    """

    __tablename__ = "event_invites"

    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    #: Null until staff or the client pick one in the gallery.
    template_id: Mapped[str | None] = mapped_column(
        String(40), ForeignKey("invitation_templates.id"), nullable=True
    )
    accent: Mapped[str | None] = mapped_column(String(7), nullable=True)
    #: Section toggles the user set; untouched sections follow the template's default.
    toggles: Mapped[dict[str, bool]] = mapped_column(JSONB, default=dict)
    content: Mapped[dict[str, Any]] = mapped_column(JSONB)

    published: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    published_template: Mapped[dict[str, Any] | None] = mapped_column(
        JSONB(none_as_null=True), nullable=True
    )
    published_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    published_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        CheckConstraint("accent IS NULL OR accent ~ '^#[0-9a-fA-F]{6}$'", name="accent_hex"),
        CheckConstraint("(published IS NULL) = (published_at IS NULL)", name="published_has_time"),
    )


class EventReview(Base):
    """One hand-over of the draft to Oscenia for review, and how it ended.

    The latest row is the current state: none or ``closed`` means plain editing. A history,
    rather than three columns on the event, because "sent back twice before it was right" is
    worth being able to see.
    """

    __tablename__ = "event_reviews"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )
    state: Mapped[ReviewState] = mapped_column(enum_column(ReviewState, "review_state"))
    submitted_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    #: ``client`` for the edit link, otherwise the staff member's name.
    submitted_by: Mapped[str] = mapped_column(String(120))
    note: Mapped[str] = mapped_column(String(500), default="")
    returned_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    returned_by: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )
    closed_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint("state <> 'returned' OR length(btrim(note)) > 0", name="return_has_note"),
        Index("ix_event_reviews_event", "event_id", "id"),
    )


class EventQuestion(Base):
    """A custom RSVP question (R7). Staff only; the client's link cannot change them."""

    __tablename__ = "event_questions"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(String(12))
    position: Mapped[int] = mapped_column(Integer)
    label: Mapped[str] = mapped_column(String(200), default="")
    type: Mapped[str] = mapped_column(String(12))
    options: Mapped[list[str]] = mapped_column(JSONB, default=list)
    multi: Mapped[bool] = mapped_column(Boolean, default=False)
    required: Mapped[bool] = mapped_column(Boolean, default=False)
    attending_only: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (
        UniqueConstraint("event_id", "key", name="uq_event_questions_key"),
        CheckConstraint("type IN ('text', 'choice', 'dropdown')", name="type_known"),
        CheckConstraint("NOT multi OR type = 'choice'", name="multi_only_for_choice"),
    )


class EventCheckpoint(Base):
    """A place guests are scanned (R1). An empty category list admits everyone."""

    __tablename__ = "event_checkpoints"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )
    key: Mapped[str] = mapped_column(String(12))
    position: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(80))
    categories: Mapped[list[str]] = mapped_column(JSONB, default=list)

    __table_args__ = (
        UniqueConstraint("event_id", "key", name="uq_event_checkpoints_key"),
        Index("uq_event_checkpoints_name", "event_id", text("lower(name)"), unique=True),
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
    )


class EventTable(Base):
    """A table name offered as a suggestion. A guest's table is free text (round 4), so this
    is a list of names, not a constraint on guests."""

    __tablename__ = "event_tables"

    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    name: Mapped[str] = mapped_column(String(30), primary_key=True)
    position: Mapped[int] = mapped_column(Integer)

    __table_args__ = (CheckConstraint("length(btrim(name)) > 0", name="name_present"),)


# ---------------------------------------------------------------------------
# Guests, scans, wishes
# ---------------------------------------------------------------------------


class Guest(Base):
    __tablename__ = "guests"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    #: Insertion order — the list's natural order. Timestamps tie inside one transaction.
    seq: Mapped[int] = mapped_column(BigInteger, Identity(), unique=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )

    name: Mapped[str] = mapped_column(String(160))
    phone: Mapped[str] = mapped_column(String(64), default="")
    #: ``norm_phone(phone)`` — what matching and de-duplication compare.
    phone_norm: Mapped[str] = mapped_column(String(32), default="")
    email: Mapped[str] = mapped_column(String(200), default="")
    category: Mapped[GuestCategory] = mapped_column(
        enum_column(GuestCategory, "guest_category"), default=GuestCategory.REGULAR
    )
    #: On the client's list, as opposed to someone who RSVP'd through a forwarded link.
    on_master_list: Mapped[bool] = mapped_column(Boolean, default=False)

    rsvp: Mapped[RsvpAnswer | None] = mapped_column(
        enum_column(RsvpAnswer, "rsvp_answer"), nullable=True
    )
    pax: Mapped[int] = mapped_column(Integer, default=0)
    allergies: Mapped[str] = mapped_column(String(500), default="")
    #: Answers by question key. A removed question's answers stay, unseen.
    answers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    consent: Mapped[bool] = mapped_column(Boolean, default=False)
    consent_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    responded_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    table: Mapped[str] = mapped_column(String(30), default="")
    #: Staff only (R5), e.g. why they did not come.
    note: Mapped[str] = mapped_column(Text, default="")
    note_by: Mapped[str | None] = mapped_column(String(120), nullable=True)
    note_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    #: The first scan anywhere. Kept on the row so lists and reports need no scan join.
    checked_in_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    walk_in: Mapped[bool] = mapped_column(Boolean, default=False)
    invited_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    invited_via: Mapped[InvitedVia | None] = mapped_column(
        enum_column(InvitedVia, "invited_via"), nullable=True
    )

    link_version: Mapped[int] = mapped_column(Integer, default=1)
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    #: Set when the guest's personal data was erased (their own request, or staff on it). The row
    #: stays, anonymised, so the headcount, the report and the check-in history are unchanged.
    erased_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    __table_args__ = (
        CheckConstraint("length(btrim(name)) > 0", name="name_present"),
        CheckConstraint("pax BETWEEN 0 AND 50", name="pax_range"),
        CheckConstraint("consent = (consent_at IS NOT NULL)", name="consent_dated"),
        CheckConstraint(
            "NOT walk_in OR (checked_in_at IS NOT NULL AND NOT on_master_list)",
            name="walk_in_checked_in_off_list",
        ),
        CheckConstraint("link_version >= 1", name="link_version_positive"),
        # One row per phone per event — the rule addGuests, matching and the walk-in desk
        # all rely on, held by the database so two simultaneous RSVPs cannot both insert.
        Index(
            "uq_guests_event_phone",
            "event_id",
            "phone_norm",
            unique=True,
            postgresql_where=text("phone_norm <> ''"),
        ),
        Index("ix_guests_event", "event_id", "seq"),
    )


class EventScan(Base):
    """One scan of a guest at one checkpoint (R1). Every scan is logged, repeats and
    not-admitted ones included: those are for the desk to judge."""

    __tablename__ = "event_scans"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )
    guest_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("guests.id", ondelete="CASCADE")
    )
    #: RESTRICT: a checkpoint with scans cannot be removed — its log would lose its place.
    checkpoint_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("event_checkpoints.id", ondelete="RESTRICT")
    )
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    #: The staff login at the desk; null for a walk-in registering themselves (Phase 2).
    by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), nullable=True
    )

    __table_args__ = (
        Index("ix_event_scans_guest", "guest_id", "at", "id"),
        Index("ix_event_scans_event", "event_id", "at"),
    )


class EventWish(Base):
    """A guest's wish on the invitation page (D13). Live, not part of the draft."""

    __tablename__ = "event_wishes"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE")
    )
    #: Set for a guest on a personal link, who signs with their listed name.
    guest_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("guests.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(80))
    text: Mapped[str] = mapped_column(String(500))
    at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)
    #: A wish left while the hold was off is approved as it arrives, so switching the hold
    #: on later does not take it down.
    approved: Mapped[bool] = mapped_column(Boolean, default=True)

    __table_args__ = (
        CheckConstraint(
            'length(btrim(name)) > 0 AND length(btrim("text")) > 0', name="wish_present"
        ),
        Index("ix_event_wishes_event", "event_id", "id"),
    )


class EventMedia(Base):
    """A file uploaded for an invitation: a photo, video or song on one event, or a template's
    artwork. The row's ``id`` is what the invitation's content holds as the file's ``key``.

    The stored file is content-addressed and shared with every other record that holds the same
    bytes, so its storage key is never put in content (anyone could then point an invitation at
    a finance receipt). Content may only name an id of its own event's or template's row, and
    guests fetch ``/public/media/{id}``. Exactly one of ``event_id`` and ``template_id`` is set.
    """

    __tablename__ = "event_media"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=True
    )
    template_id: Mapped[str | None] = mapped_column(
        String(40), ForeignKey("invitation_templates.id", ondelete="CASCADE"), nullable=True
    )
    storage_key: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(16))
    name: Mapped[str] = mapped_column(String(160))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    #: The staff member, or "client link" for the client's edit key.
    uploaded_by: Mapped[str] = mapped_column(String(120))
    created_at: Mapped[dt.datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint(
            "(event_id IS NOT NULL) <> (template_id IS NOT NULL)", name="one_owner"
        ),
        Index("ix_event_media_event", "event_id"),
        Index("ix_event_media_template", "template_id"),
    )
