"""add workspace identity to users

Chat backend, phase C0. One account becomes both the ERP login and the chat persona: a
member number (the ``M-05`` that appears inside stored message text), a division, a
workspace role and a chosen status — plus which divisions work on a project and which
staff and interns are named on it.

``team`` joins ``user_role`` for staff and interns, who have no finance access at all.
Postgres cannot drop an enum value, so the downgrade leaves ``team`` in the type; nothing
reads it once the columns that make it useful are gone.

Revision ID: a3c71e5b9d20
Revises: 5d6a2f57d1b5
Create Date: 2026-10-09 10:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "a3c71e5b9d20"
down_revision: str | None = "5d6a2f57d1b5"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_WORKSPACE_ROLE = postgresql.ENUM("pm", "leader", "staff", "intern", name="workspace_role", create_type=False)
_CHAT_STATUS = postgresql.ENUM("online", "idle", "dnd", "invisible", name="chat_status", create_type=False)


def upgrade() -> None:
    # ALTER TYPE ... ADD VALUE cannot run inside a transaction block on older servers, and
    # the new value must be committed before anything uses it.
    with op.get_context().autocommit_block():
        op.execute("ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'team'")

    op.execute("CREATE TYPE workspace_role AS ENUM ('pm', 'leader', 'staff', 'intern')")
    op.execute("CREATE TYPE chat_status AS ENUM ('online', 'idle', 'dnd', 'invisible')")

    op.add_column("users", sa.Column("member_no", sa.String(length=8), nullable=True))
    op.add_column("users", sa.Column("division", sa.String(length=64), nullable=True))
    op.add_column("users", sa.Column("workspace_role", _WORKSPACE_ROLE, nullable=True))
    op.add_column("users", sa.Column("title", sa.String(length=80), nullable=True))
    op.add_column(
        "users",
        sa.Column("chat_status", _CHAT_STATUS, server_default="online", nullable=False),
    )
    op.create_unique_constraint(op.f("uq_users_member_no"), "users", ["member_no"])
    op.create_check_constraint(
        op.f("ck_users_workspace_needs_member_no"),
        "users",
        "workspace_role IS NULL OR member_no IS NOT NULL",
    )
    op.create_check_constraint(
        op.f("ck_users_leader_needs_division"),
        "users",
        "workspace_role IS DISTINCT FROM 'leader' OR division IS NOT NULL",
    )

    op.create_table(
        "project_divisions",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("division", sa.String(length=64), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_project_divisions_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id", "division", name=op.f("pk_project_divisions")),
    )
    op.create_table(
        "project_members",
        sa.Column("project_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("added_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(
            ["project_id"],
            ["projects.id"],
            name=op.f("fk_project_members_project_id_projects"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_project_members_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("project_id", "user_id", name=op.f("pk_project_members")),
    )
    op.create_index("ix_project_members_user", "project_members", ["user_id"])

    # Member numbers come from a sequence so one is never handed out twice, even after a
    # user is deleted or a number is released by hand.
    op.execute("CREATE SEQUENCE member_no_seq START 1")


def downgrade() -> None:
    op.execute("DROP SEQUENCE IF EXISTS member_no_seq")
    op.drop_index("ix_project_members_user", table_name="project_members")
    op.drop_table("project_members")
    op.drop_table("project_divisions")
    op.drop_constraint(op.f("ck_users_leader_needs_division"), "users", type_="check")
    op.drop_constraint(op.f("ck_users_workspace_needs_member_no"), "users", type_="check")
    op.drop_constraint(op.f("uq_users_member_no"), "users", type_="unique")
    for column in ("chat_status", "title", "workspace_role", "division", "member_no"):
        op.drop_column("users", column)
    # Alembic's generated downgrade leaves enum types behind (see phase 6): drop explicitly,
    # or a downgrade-then-upgrade fails with "type already exists".
    op.execute("DROP TYPE IF EXISTS chat_status")
    op.execute("DROP TYPE IF EXISTS workspace_role")
