"""add chat attachments

Chat backend, phase C4. A file is uploaded to a channel first and linked to a message when
that message is posted. The row is the only thing chat owns: the stored bytes are
content-addressed and may be shared with other modules, so deleting an attachment never
deletes the file.

Revision ID: d7a93c2e6b18
Revises: c4f1a7d93e55
Create Date: 2026-10-10 18:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "d7a93c2e6b18"
down_revision: str | None = "c4f1a7d93e55"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "chat_attachments",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("message_id", sa.UUID(), nullable=True),
        sa.Column("uploader_id", sa.UUID(), nullable=False),
        sa.Column("storage_key", sa.String(length=200), nullable=False),
        sa.Column("filename", sa.String(length=120), nullable=False),
        sa.Column("content_type", sa.String(length=80), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("position", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("size_bytes > 0", name=op.f("ck_chat_attachments_has_bytes")),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_attachments_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["chat_messages.id"],
            name=op.f("fk_chat_attachments_message_id_chat_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["uploader_id"], ["users.id"], name=op.f("fk_chat_attachments_uploader_id_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_attachments")),
    )
    op.create_index("ix_chat_attachments_message", "chat_attachments", ["message_id"])
    op.create_index(
        "ix_chat_attachments_unlinked",
        "chat_attachments",
        ["created_at"],
        postgresql_where=sa.text("message_id IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_chat_attachments_unlinked", table_name="chat_attachments")
    op.drop_index("ix_chat_attachments_message", table_name="chat_attachments")
    op.drop_table("chat_attachments")
