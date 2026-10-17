"""add events and invitations

Phase 1 of the backend build (events core, staff side). The six built-in invitation
templates are inserted here as frozen data — the copy in ``app/domain/events/templates.py``
is what the code validates against, and the two must agree (``test_events_rules`` checks).

Revision ID: 5d6a2f57d1b5
Revises: 393218d4b5ff
Create Date: 2026-10-05 15:50:49.170430
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "5d6a2f57d1b5"
down_revision: str | None = "393218d4b5ff"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


BUILTIN_TEMPLATES = [
    {
        "id": "gala",
        "family": "corporate",
        "name": "Gala",
        "tagline": "Midnight and gold, framed like an engraved card.",
        "palette": {"bg": "#0b1426", "surface": "#132038", "accent": "#c6a15b", "text": "#f5f0e6"},
        "fonts": {"heading": "cinzel", "body": "cormorant", "script": "cinzel"},
        "cover": "framed",
        "ornament": "gold-rule",
        "sections": [
            "cover",
            "message",
            "countdown",
            "details",
            "agenda",
            "speakers",
            "hosts",
            "dresscode",
            "gallery",
            "video",
            "rsvp",
            "wishes",
        ],
        "off": ["speakers", "hosts"],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
    {
        "id": "launch",
        "family": "corporate",
        "name": "Launch",
        "tagline": "Bold, modern and video-first, for reveals and product nights.",
        "palette": {"bg": "#fbf1ef", "surface": "#ffffff", "accent": "#b76e79", "text": "#3a2227"},
        "fonts": {"heading": "montserrat", "body": "inter", "script": "playfair"},
        "cover": "fullbleed",
        "ornament": "none",
        "sections": [
            "cover",
            "message",
            "video",
            "countdown",
            "details",
            "agenda",
            "speakers",
            "gallery",
            "hosts",
            "dresscode",
            "rsvp",
            "wishes",
        ],
        "off": ["speakers", "hosts"],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
    {
        "id": "summit",
        "family": "corporate",
        "name": "Summit",
        "tagline": "Clean and structured, with room for an agenda and speakers.",
        "palette": {"bg": "#f4f6fb", "surface": "#ffffff", "accent": "#2f5bea", "text": "#13203d"},
        "fonts": {"heading": "montserrat", "body": "inter", "script": "montserrat"},
        "cover": "split",
        "ornament": "grid",
        "sections": [
            "cover",
            "message",
            "details",
            "countdown",
            "agenda",
            "speakers",
            "hosts",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
        ],
        "off": [],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
    {
        "id": "royal",
        "family": "private",
        "name": "Royal",
        "tagline": "Ornamental florals and script names, for a grand celebration.",
        "palette": {"bg": "#fbf7ef", "surface": "#ffffff", "accent": "#a8823c", "text": "#3b2f1e"},
        "fonts": {"heading": "cormorant", "body": "cormorant", "script": "vibes"},
        "cover": "centered",
        "ornament": "floral",
        "sections": [
            "cover",
            "message",
            "couple",
            "countdown",
            "details",
            "story",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
            "gift",
        ],
        "off": ["dresscode"],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
    {
        "id": "minimal",
        "family": "private",
        "name": "Minimal",
        "tagline": "Quiet white space and a fine serif. Lets the photos speak.",
        "palette": {"bg": "#ffffff", "surface": "#f6f6f4", "accent": "#1f1f1f", "text": "#1f1f1f"},
        "fonts": {"heading": "playfair", "body": "inter", "script": "playfair"},
        "cover": "split",
        "ornament": "none",
        "sections": [
            "cover",
            "couple",
            "message",
            "details",
            "countdown",
            "gallery",
            "story",
            "video",
            "dresscode",
            "rsvp",
            "gift",
            "wishes",
        ],
        "off": ["dresscode"],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
    {
        "id": "garden",
        "family": "private",
        "name": "Garden",
        "tagline": "Soft pastels and leaf sprigs, for garden and daytime events.",
        "palette": {"bg": "#f3f6ef", "surface": "#ffffff", "accent": "#6f8f5b", "text": "#2c3a26"},
        "fonts": {"heading": "cormorant", "body": "inter", "script": "vibes"},
        "cover": "centered",
        "ornament": "leaf",
        "sections": [
            "cover",
            "message",
            "couple",
            "details",
            "countdown",
            "story",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
            "gift",
        ],
        "off": ["dresscode"],
        "art": {"coverBg": None, "pageBg": None, "frame": None, "ornament": None},
        "status": "published",
    },
]

CREATED = datetime(2026, 10, 5, tzinfo=UTC)

ENUMS = ("event_status", "review_state", "guest_category", "rsvp_answer", "invited_via")


def upgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.create_table(
        "invitation_templates",
        sa.Column("id", sa.String(length=40), nullable=False),
        sa.Column("builtin", sa.Boolean(), nullable=False),
        sa.Column("family", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("tagline", sa.String(length=120), nullable=False),
        sa.Column("palette", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("fonts", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("cover", sa.String(length=16), nullable=False),
        sa.Column("ornament", sa.String(length=16), nullable=False),
        sa.Column("sections", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("off", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("art", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by_label", sa.String(length=120), nullable=False),
        sa.CheckConstraint(
            "NOT builtin OR status = 'published'",
            name=op.f("ck_invitation_templates_builtin_published"),
        ),
        sa.CheckConstraint(
            "family IN ('corporate', 'private')", name=op.f("ck_invitation_templates_family_known")
        ),
        sa.CheckConstraint(
            "status IN ('draft', 'published', 'archived')",
            name=op.f("ck_invitation_templates_status_known"),
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_invitation_templates")),
    )
    op.create_table(
        "events",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("event_no", sa.String(length=16), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("client_id", sa.UUID(), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("time", sa.String(length=5), nullable=False),
        sa.Column("venue", sa.String(length=300), nullable=False),
        sa.Column("status", sa.Enum("Draft", "Published", name="event_status"), nullable=False),
        sa.Column("rsvp_deadline", sa.Date(), nullable=False),
        sa.Column("max_pax", sa.Integer(), nullable=False),
        sa.Column("rsvp_fields", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("feedback_url", sa.String(length=500), nullable=False),
        sa.Column("hold_wishes", sa.Boolean(), nullable=False),
        sa.Column("question_seq", sa.Integer(), nullable=False),
        sa.Column("checkpoint_seq", sa.Integer(), nullable=False),
        sa.Column("edit_link_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "\"time\" = '' OR \"time\" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'",
            name=op.f("ck_events_time_hhmm"),
        ),
        sa.CheckConstraint(
            "edit_link_version >= 1", name=op.f("ck_events_edit_link_version_positive")
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name=op.f("ck_events_name_present")),
        sa.CheckConstraint("max_pax BETWEEN 1 AND 50", name=op.f("ck_events_max_pax_range")),
        sa.ForeignKeyConstraint(
            ["client_id"], ["clients.id"], name=op.f("fk_events_client_id_clients")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_events_created_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name=op.f("fk_events_project_id_projects")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_events")),
        sa.UniqueConstraint("event_no", name=op.f("uq_events_event_no")),
    )
    op.create_index("ix_events_date", "events", ["date"], unique=False)
    op.create_table(
        "event_checkpoints",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=12), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("categories", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.CheckConstraint(
            "length(btrim(name)) > 0", name=op.f("ck_event_checkpoints_name_present")
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_checkpoints_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_event_checkpoints")),
        sa.UniqueConstraint("event_id", "key", name="uq_event_checkpoints_key"),
    )
    op.create_index(
        "uq_event_checkpoints_name",
        "event_checkpoints",
        ["event_id", sa.literal_column("lower(name)")],
        unique=True,
    )
    op.create_table(
        "event_invites",
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("template_id", sa.String(length=40), nullable=True),
        sa.Column("accent", sa.String(length=7), nullable=True),
        sa.Column("toggles", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("content", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("published", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("published_template", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_by", sa.UUID(), nullable=True),
        sa.CheckConstraint(
            "accent IS NULL OR accent ~ '^#[0-9a-fA-F]{6}$'",
            name=op.f("ck_event_invites_accent_hex"),
        ),
        sa.CheckConstraint(
            "(published IS NULL) = (published_at IS NULL)",
            name=op.f("ck_event_invites_published_has_time"),
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_invites_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["published_by"], ["users.id"], name=op.f("fk_event_invites_published_by_users")
        ),
        sa.ForeignKeyConstraint(
            ["template_id"],
            ["invitation_templates.id"],
            name=op.f("fk_event_invites_template_id_invitation_templates"),
        ),
        sa.PrimaryKeyConstraint("event_id", name=op.f("pk_event_invites")),
    )
    op.create_table(
        "event_questions",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=12), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("label", sa.String(length=200), nullable=False),
        sa.Column("type", sa.String(length=12), nullable=False),
        sa.Column("options", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("multi", sa.Boolean(), nullable=False),
        sa.Column("required", sa.Boolean(), nullable=False),
        sa.Column("attending_only", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            "NOT multi OR type = 'choice'", name=op.f("ck_event_questions_multi_only_for_choice")
        ),
        sa.CheckConstraint(
            "type IN ('text', 'choice', 'dropdown')", name=op.f("ck_event_questions_type_known")
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_questions_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_event_questions")),
        sa.UniqueConstraint("event_id", "key", name="uq_event_questions_key"),
    )
    op.create_table(
        "event_reviews",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column(
            "state", sa.Enum("submitted", "returned", "closed", name="review_state"), nullable=False
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("submitted_by", sa.String(length=120), nullable=False),
        sa.Column("note", sa.String(length=500), nullable=False),
        sa.Column("returned_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("returned_by", sa.UUID(), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "state <> 'returned' OR length(btrim(note)) > 0",
            name=op.f("ck_event_reviews_return_has_note"),
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_reviews_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["returned_by"], ["users.id"], name=op.f("fk_event_reviews_returned_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_event_reviews")),
    )
    op.create_index("ix_event_reviews_event", "event_reviews", ["event_id", "id"], unique=False)
    op.create_table(
        "event_tables",
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=30), nullable=False),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.CheckConstraint("length(btrim(name)) > 0", name=op.f("ck_event_tables_name_present")),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_tables_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("event_id", "name", name=op.f("pk_event_tables")),
    )
    op.create_table(
        "guests",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("phone", sa.String(length=64), nullable=False),
        sa.Column("phone_norm", sa.String(length=32), nullable=False),
        sa.Column("email", sa.String(length=200), nullable=False),
        sa.Column(
            "category",
            sa.Enum("VIP", "Media", "Regular", "Vendor", name="guest_category"),
            nullable=False,
        ),
        sa.Column("on_master_list", sa.Boolean(), nullable=False),
        sa.Column("rsvp", sa.Enum("Attending", "Declined", name="rsvp_answer"), nullable=True),
        sa.Column("pax", sa.Integer(), nullable=False),
        sa.Column("allergies", sa.String(length=500), nullable=False),
        sa.Column("answers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("consent", sa.Boolean(), nullable=False),
        sa.Column("consent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("table", sa.String(length=30), nullable=False),
        sa.Column("note", sa.Text(), nullable=False),
        sa.Column("note_by", sa.String(length=120), nullable=True),
        sa.Column("note_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("walk_in", sa.Boolean(), nullable=False),
        sa.Column("invited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("invited_via", sa.Enum("platform", "client", name="invited_via"), nullable=True),
        sa.Column("link_version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint(
            "NOT walk_in OR (checked_in_at IS NOT NULL AND NOT on_master_list)",
            name=op.f("ck_guests_walk_in_checked_in_off_list"),
        ),
        sa.CheckConstraint(
            "consent = (consent_at IS NOT NULL)", name=op.f("ck_guests_consent_dated")
        ),
        sa.CheckConstraint("length(btrim(name)) > 0", name=op.f("ck_guests_name_present")),
        sa.CheckConstraint("link_version >= 1", name=op.f("ck_guests_link_version_positive")),
        sa.CheckConstraint("pax BETWEEN 0 AND 50", name=op.f("ck_guests_pax_range")),
        sa.ForeignKeyConstraint(
            ["event_id"], ["events.id"], name=op.f("fk_guests_event_id_events"), ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_guests")),
        sa.UniqueConstraint("seq", name=op.f("uq_guests_seq")),
    )
    op.create_index("ix_guests_event", "guests", ["event_id", "seq"], unique=False)
    op.create_index(
        "uq_guests_event_phone",
        "guests",
        ["event_id", "phone_norm"],
        unique=True,
        postgresql_where=sa.text("phone_norm <> ''"),
    )
    op.create_table(
        "event_scans",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("guest_id", sa.UUID(), nullable=False),
        sa.Column("checkpoint_id", sa.UUID(), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("by_user_id", sa.UUID(), nullable=True),
        sa.ForeignKeyConstraint(
            ["by_user_id"], ["users.id"], name=op.f("fk_event_scans_by_user_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["checkpoint_id"],
            ["event_checkpoints.id"],
            name=op.f("fk_event_scans_checkpoint_id_event_checkpoints"),
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_scans_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["guest_id"],
            ["guests.id"],
            name=op.f("fk_event_scans_guest_id_guests"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_event_scans")),
    )
    op.create_index("ix_event_scans_event", "event_scans", ["event_id", "at"], unique=False)
    op.create_index("ix_event_scans_guest", "event_scans", ["guest_id", "at", "id"], unique=False)
    op.create_table(
        "event_wishes",
        sa.Column("id", sa.BigInteger(), sa.Identity(always=False), nullable=False),
        sa.Column("event_id", sa.UUID(), nullable=False),
        sa.Column("guest_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("text", sa.String(length=500), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("hidden", sa.Boolean(), nullable=False),
        sa.Column("approved", sa.Boolean(), nullable=False),
        sa.CheckConstraint(
            'length(btrim(name)) > 0 AND length(btrim("text")) > 0',
            name=op.f("ck_event_wishes_wish_present"),
        ),
        sa.ForeignKeyConstraint(
            ["event_id"],
            ["events.id"],
            name=op.f("fk_event_wishes_event_id_events"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["guest_id"],
            ["guests.id"],
            name=op.f("fk_event_wishes_guest_id_guests"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_event_wishes")),
    )
    op.create_index("ix_event_wishes_event", "event_wishes", ["event_id", "id"], unique=False)
    # ### end Alembic commands ###

    templates = sa.table(
        "invitation_templates",
        sa.column("id", sa.String),
        sa.column("builtin", sa.Boolean),
        sa.column("family", sa.String),
        sa.column("name", sa.String),
        sa.column("tagline", sa.String),
        sa.column("palette", postgresql.JSONB),
        sa.column("fonts", postgresql.JSONB),
        sa.column("cover", sa.String),
        sa.column("ornament", sa.String),
        sa.column("sections", postgresql.JSONB),
        sa.column("off", postgresql.JSONB),
        sa.column("art", postgresql.JSONB),
        sa.column("status", sa.String),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
        sa.column("created_by_label", sa.String),
    )
    op.bulk_insert(
        templates,
        [
            {
                **t,
                "builtin": True,
                "created_at": CREATED,
                "updated_at": CREATED,
                "created_by_label": "Oscenia",
            }
            for t in BUILTIN_TEMPLATES
        ],
    )


def downgrade() -> None:
    # ### commands auto generated by Alembic - please adjust! ###
    op.drop_index("ix_event_wishes_event", table_name="event_wishes")
    op.drop_table("event_wishes")
    op.drop_index("ix_event_scans_guest", table_name="event_scans")
    op.drop_index("ix_event_scans_event", table_name="event_scans")
    op.drop_table("event_scans")
    op.drop_index(
        "uq_guests_event_phone", table_name="guests", postgresql_where=sa.text("phone_norm <> ''")
    )
    op.drop_index("ix_guests_event", table_name="guests")
    op.drop_table("guests")
    op.drop_table("event_tables")
    op.drop_index("ix_event_reviews_event", table_name="event_reviews")
    op.drop_table("event_reviews")
    op.drop_table("event_questions")
    op.drop_table("event_invites")
    op.drop_index("uq_event_checkpoints_name", table_name="event_checkpoints")
    op.drop_table("event_checkpoints")
    op.drop_index("ix_events_date", table_name="events")
    op.drop_table("events")
    op.drop_table("invitation_templates")
    # ### end Alembic commands ###
    for name in ENUMS:
        op.execute(f"DROP TYPE IF EXISTS {name}")
