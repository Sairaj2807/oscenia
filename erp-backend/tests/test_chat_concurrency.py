"""Chat backend C2 — what only a real race can show.

The HTTP tests share one rolled-back session, so they cannot make two writers collide. These
use separate committed connections: several senders posting to one channel at the same moment,
and a retry racing its own twin. They commit real rows, so they clean up after themselves in a
``finally`` — and use their own e-mail addresses so nothing else is touched.
"""

from __future__ import annotations

import asyncio
import uuid

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncEngine, async_sessionmaker

from app.core.clock import FrozenClock
from app.domain.chat import messages
from app.domain.chat.models import ChannelAccess, ChatChannel, ChatMessage
from app.domain.chat.service import load_context
from app.domain.chat.workspace import set_workspace
from app.domain.masters.models import Role, User, WorkspaceRole
from app.seed.users import add_user

PASSWORD = "a-real-password-for-tests"
EMAILS = [f"race-{n}@oscenia.co.id" for n in range(3)]


async def test_simultaneous_posts_get_distinct_numbers_with_no_skips_and_a_twin_retry_posts_once(
    engine: AsyncEngine, frozen_clock: FrozenClock
) -> None:
    maker = async_sessionmaker(bind=engine, expire_on_commit=False)
    channel_id: uuid.UUID | None = None
    try:
        async with maker() as s:
            people = []
            for email in EMAILS:
                user, _ = await add_user(s, email, email.split("@")[0], Role.TEAM, PASSWORD)
                await set_workspace(s, user, workspace_role=WorkspaceRole.STAFF, division="Field")
                people.append(user.id)
            channel = ChatChannel(
                name="race", access=ChannelAccess.PROJECT, divisions=[], listed=True
            )
            s.add(channel)
            await s.commit()
            channel_id = channel.id

        async def post(n: int, who: uuid.UUID, client_msg_id: uuid.UUID | None = None):
            async with maker() as s:
                user = await s.get(User, who)
                assert user is not None
                ctx = await load_context(s, user)
                assert channel_id is not None
                msg, created = await messages.post_message(
                    s, ctx, frozen_clock, channel_id, f"m{n}", client_msg_id=client_msg_id
                )
                await s.commit()
                return msg.seq, msg.id, created

        # Twelve senders at once, three people, one channel.
        results = await asyncio.gather(*(post(n, people[n % 3]) for n in range(12)))
        assert sorted(seq for seq, _, _ in results) == list(range(1, 13))
        assert all(created for _, _, created in results)

        # A retry racing its own twin: both pass the "have I seen this id?" check before either
        # has committed, so it is the unique key and the savepoint that keep it to one message.
        key = uuid.uuid4()
        twins = await asyncio.gather(post(100, people[0], key), post(101, people[0], key))
        assert sorted(created for _, _, created in twins) == [False, True]
        assert twins[0][1] == twins[1][1]  # the same message, handed back to the loser

        async with maker() as s:
            count = (
                (await s.execute(select(ChatMessage).where(ChatMessage.channel_id == channel_id)))
                .scalars()
                .all()
            )
            assert len(count) == 13
            rev = (
                await s.execute(select(ChatChannel.rev).where(ChatChannel.id == channel_id))
            ).scalar_one()
            # The loser's number was handed back with its failed insert: the counter did not
            # skip, so the next change is exactly one past the last message.
            assert rev == 13
    finally:
        async with maker() as s:
            if channel_id is not None:
                for table in (
                    "chat_mentions",
                    "chat_reads",
                    "chat_messages",
                    "chat_channel_members",
                ):
                    await s.execute(
                        text(f"DELETE FROM {table} WHERE channel_id = :c"), {"c": channel_id}
                    )
                await s.execute(text("DELETE FROM chat_channels WHERE id = :c"), {"c": channel_id})
            await s.execute(text("DELETE FROM users WHERE email = ANY(:e)"), {"e": EMAILS})
            await s.commit()
