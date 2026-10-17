"""add chat channels, members, blocks and join requests

Chat backend, phase C1. Channels carry a rule (who may open them by default); named members
let people in on top of it and blocks keep people out whatever it says. A direct message is
a channel with a sorted pair of users, unique, so one pair can only ever have one.

Revision ID: b8e24d6a1f93
Revises: a3c71e5b9d20
Create Date: 2026-10-10 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "b8e24d6a1f93"
down_revision: str | None = "a3c71e5b9d20"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_ACCESS = postgresql.ENUM("project", "divisions", "invite", name="chat_access", create_type=False)
_JOIN = postgresql.ENUM(
    "pending", "approved", "declined", name="chat_join_status", create_type=False
)
_VIA = postgresql.ENUM(
    "creator", "settings", "request", "dm", "seed", name="chat_added_via", create_type=False
)

_ZERO = "00000000-0000-0000-0000-000000000000"


def upgrade() -> None:
    op.execute("CREATE TYPE chat_access AS ENUM ('project', 'divisions', 'invite')")
    op.execute("CREATE TYPE chat_join_status AS ENUM ('pending', 'approved', 'declined')")
    op.execute(
        "CREATE TYPE chat_added_via AS ENUM ('creator', 'settings', 'request', 'dm', 'seed')"
    )

    op.create_table(
        "chat_channels",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=64), nullable=True),
        sa.Column("project_id", sa.UUID(), nullable=True),
        sa.Column("name", sa.String(length=40), nullable=False),
        sa.Column("topic", sa.String(length=120), nullable=False),
        sa.Column("access", _ACCESS, nullable=False),
        sa.Column(
            "divisions",
            postgresql.ARRAY(sa.String(length=64)),
            server_default=sa.text("'{}'"),
            nullable=False,
        ),
        sa.Column("listed", sa.Boolean(), nullable=False),
        sa.Column("is_dm", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("dm_lo", sa.UUID(), nullable=True),
        sa.Column("dm_hi", sa.UUID(), nullable=True),
        sa.Column("rev", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("created_by", sa.UUID(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "is_dm = (dm_lo IS NOT NULL AND dm_hi IS NOT NULL)",
            name=op.f("ck_chat_channels_dm_has_pair"),
        ),
        sa.CheckConstraint(
            "NOT is_dm OR dm_lo < dm_hi", name=op.f("ck_chat_channels_dm_pair_sorted")
        ),
        sa.CheckConstraint("is_dm OR name <> ''", name=op.f("ck_chat_channels_channel_has_name")),
        sa.CheckConstraint(
            "access <> 'divisions' OR cardinality(divisions) > 0",
            name=op.f("ck_chat_channels_divisions_rule_has_some"),
        ),
        sa.ForeignKeyConstraint(
            ["project_id"], ["projects.id"], name=op.f("fk_chat_channels_project_id_projects")
        ),
        sa.ForeignKeyConstraint(
            ["dm_lo"], ["users.id"], name=op.f("fk_chat_channels_dm_lo_users")
        ),
        sa.ForeignKeyConstraint(
            ["dm_hi"], ["users.id"], name=op.f("fk_chat_channels_dm_hi_users")
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name=op.f("fk_chat_channels_created_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_channels")),
        sa.UniqueConstraint("key", name=op.f("uq_chat_channels_key")),
    )
    op.create_index(op.f("ix_chat_channels_project_id"), "chat_channels", ["project_id"])
    op.create_index(
        "uq_chat_dm_pair",
        "chat_channels",
        ["dm_lo", "dm_hi"],
        unique=True,
        postgresql_where=sa.text("is_dm"),
    )
    op.create_index(
        "uq_chat_channel_name",
        "chat_channels",
        [sa.text(f"coalesce(project_id, '{_ZERO}'::uuid)"), sa.text("lower(name)")],
        unique=True,
        postgresql_where=sa.text("NOT is_dm AND archived_at IS NULL"),
    )

    op.create_table(
        "chat_channel_members",
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("added_via", _VIA, nullable=False),
        sa.Column(
            "added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_channel_members_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_chat_channel_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("channel_id", "user_id", name=op.f("pk_chat_channel_members")),
    )
    op.create_index("ix_chat_channel_members_user", "chat_channel_members", ["user_id"])

    op.create_table(
        "chat_channel_blocks",
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("blocked_by", sa.UUID(), nullable=True),
        sa.Column(
            "blocked_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_channel_blocks_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_chat_channel_blocks_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["blocked_by"], ["users.id"], name=op.f("fk_chat_channel_blocks_blocked_by_users")
        ),
        sa.PrimaryKeyConstraint("channel_id", "user_id", name=op.f("pk_chat_channel_blocks")),
    )

    op.create_table(
        "chat_join_requests",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("note", sa.String(length=200), nullable=False),
        sa.Column("status", _JOIN, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column("decided_by", sa.UUID(), nullable=True),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "(status = 'pending') = (decided_at IS NULL)",
            name=op.f("ck_chat_join_requests_decided_iff_not_pending"),
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_join_requests_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_chat_join_requests_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["decided_by"], ["users.id"], name=op.f("fk_chat_join_requests_decided_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_join_requests")),
    )
    op.create_index(op.f("ix_chat_join_requests_channel_id"), "chat_join_requests", ["channel_id"])
    op.create_index(
        "uq_chat_join_pending",
        "chat_join_requests",
        ["channel_id", "user_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_table("chat_join_requests")
    op.drop_table("chat_channel_blocks")
    op.drop_index("ix_chat_channel_members_user", table_name="chat_channel_members")
    op.drop_table("chat_channel_members")
    op.drop_table("chat_channels")
    # Alembic's generated downgrade leaves enum types behind; drop them or a
    # downgrade-then-upgrade fails with "type already exists".
    op.execute("DROP TYPE IF EXISTS chat_join_status")
    op.execute("DROP TYPE IF EXISTS chat_added_via")
    op.execute("DROP TYPE IF EXISTS chat_access")
