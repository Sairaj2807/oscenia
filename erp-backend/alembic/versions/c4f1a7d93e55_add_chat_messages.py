"""add chat messages, reactions, mentions and read state

Chat backend, phase C2. Messages are ordered by ``seq`` and carry a ``rev`` that moves when
the message does, both drawn from the channel's own counter under its row lock, so they
commit in the order they were handed out and a reconnecting client can resume without a gap.

Revision ID: c4f1a7d93e55
Revises: b8e24d6a1f93
Create Date: 2026-10-10 14:00:00.000000
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "c4f1a7d93e55"
down_revision: str | None = "b8e24d6a1f93"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Same list as ``REACTIONS`` in ``app/domain/chat/models.py`` and ``chat.js``.
_EMOJI = ("\U0001f44d", "\U0001f64c", "✅", "\U0001f440", "❤️")


def upgrade() -> None:
    op.create_table(
        "chat_messages",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("seq", sa.BigInteger(), nullable=False),
        sa.Column("rev", sa.BigInteger(), nullable=False),
        sa.Column("author_id", sa.UUID(), nullable=False),
        sa.Column("text", sa.Text(), nullable=False),
        sa.Column("kind", sa.String(length=12), server_default="text", nullable=False),
        sa.Column("quote_id", sa.UUID(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("edited_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("deleted_by", sa.UUID(), nullable=True),
        sa.Column("client_msg_id", sa.UUID(), nullable=True),
        sa.CheckConstraint("kind IN ('text', 'call')", name=op.f("ck_chat_messages_kind_known")),
        sa.CheckConstraint(
            "char_length(text) <= 4000", name=op.f("ck_chat_messages_text_not_too_long")
        ),
        sa.CheckConstraint(
            "deleted_at IS NOT NULL OR length(btrim(text)) > 0",
            name=op.f("ck_chat_messages_live_message_has_text"),
        ),
        sa.CheckConstraint(
            "deleted_at IS NULL OR text = ''",
            name=op.f("ck_chat_messages_deleted_message_is_empty"),
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_messages_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["author_id"], ["users.id"], name=op.f("fk_chat_messages_author_id_users")
        ),
        sa.ForeignKeyConstraint(
            ["deleted_by"], ["users.id"], name=op.f("fk_chat_messages_deleted_by_users")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_chat_messages")),
        sa.UniqueConstraint("channel_id", "seq", name="uq_chat_messages_channel_seq"),
        sa.UniqueConstraint("channel_id", "id", name="uq_chat_messages_channel_id"),
        sa.UniqueConstraint("author_id", "client_msg_id", name="uq_chat_messages_client_msg"),
    )
    # Added after the unique key it points at exists. A quote must be in the same channel.
    op.create_foreign_key(
        "fk_chat_messages_quote_same_channel",
        "chat_messages",
        "chat_messages",
        ["channel_id", "quote_id"],
        ["channel_id", "id"],
    )
    op.create_index("ix_chat_messages_channel_rev", "chat_messages", ["channel_id", "rev"])

    emoji_list = "', '".join(_EMOJI)
    op.create_table(
        "chat_reactions",
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("emoji", sa.String(length=16), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint(
            f"emoji IN ('{emoji_list}')", name=op.f("ck_chat_reactions_emoji_is_offered")
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["chat_messages.id"],
            name=op.f("fk_chat_reactions_message_id_chat_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_chat_reactions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("message_id", "user_id", "emoji", name=op.f("pk_chat_reactions")),
    )

    op.create_table(
        "chat_mentions",
        sa.Column("message_id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["chat_messages.id"],
            name=op.f("fk_chat_mentions_message_id_chat_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_chat_mentions_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_mentions_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("message_id", "user_id", name=op.f("pk_chat_mentions")),
    )
    op.create_index("ix_chat_mentions_user", "chat_mentions", ["user_id", "created_at"])

    op.create_table(
        "chat_reads",
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("channel_id", sa.UUID(), nullable=False),
        sa.Column("last_read_seq", sa.BigInteger(), server_default="0", nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name=op.f("fk_chat_reads_user_id_users"), ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["channel_id"],
            ["chat_channels.id"],
            name=op.f("fk_chat_reads_channel_id_chat_channels"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", "channel_id", name=op.f("pk_chat_reads")),
    )


def downgrade() -> None:
    op.drop_table("chat_reads")
    op.drop_index("ix_chat_mentions_user", table_name="chat_mentions")
    op.drop_table("chat_mentions")
    op.drop_table("chat_reactions")
    op.drop_index("ix_chat_messages_channel_rev", table_name="chat_messages")
    op.drop_constraint("fk_chat_messages_quote_same_channel", "chat_messages", type_="foreignkey")
    op.drop_table("chat_messages")
