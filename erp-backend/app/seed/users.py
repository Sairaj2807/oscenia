"""Add, deactivate and reactivate real users — the production replacement for demo accounts.

Run on the server, inside the API container::

    python -m app.seed.users add lina@oscenia.co.id "Lina Wijaya" finance
    python -m app.seed.users add rina@oscenia.co.id "Rina M." team \
        --workspace-role staff --division Field --title "Stage Manager"
    python -m app.seed.users deactivate lina@oscenia.co.id
    python -m app.seed.users activate lina@oscenia.co.id
    python -m app.seed.users list

``add`` prompts for the password twice, so it never lands in shell history or ``ps``. It
must be at least 12 characters, the same rule as ``set_password``. Adding an address that
already exists resets its password and role, which doubles as the password-reset path
until there is a screen for it.

Deactivating takes effect on the user's next request (``current_user`` reads ``active``
from the database every time) and also ends every refresh session.
"""

from __future__ import annotations

import argparse
import asyncio
import getpass
import sys

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.errors import DomainError
from app.db.session import dispose_engine, get_sessionmaker
from app.domain.auth.service import revoke_all, set_password
from app.domain.chat.workspace import set_workspace
from app.domain.masters.models import Role, User, WorkspaceRole
from app.seed.chart import SYSTEM_USER_EMAIL


def _initials(full_name: str) -> str:
    parts = [p for p in full_name.split() if p]
    return "".join(p[0] for p in parts[:2]).upper() or "?"


async def add_user(
    session: AsyncSession, email: str, full_name: str, role: Role, password: str
) -> tuple[User, bool]:
    """Create or update a user. Returns ``(user, created)``."""
    email = email.strip().lower()
    if email == SYSTEM_USER_EMAIL:
        raise ValueError("The system user is not a login.")

    user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
    created = user is None
    if user is None:
        user = User(email=email, full_name=full_name, initials=_initials(full_name), role=role)
        session.add(user)
        await session.flush()
    else:
        user.full_name = full_name
        user.initials = _initials(full_name)
        user.role = role
        user.active = True

    # Validates the length and signs out every existing session.
    await set_password(session, user, password)
    return user, created


async def set_active(session: AsyncSession, email: str, active: bool) -> User:
    email = email.strip().lower()
    user = (await session.execute(select(User).where(User.email == email))).scalar_one_or_none()
    if user is None or user.email == SYSTEM_USER_EMAIL:
        raise ValueError(f"No user {email}.")
    user.active = active
    if not active:
        await revoke_all(session, user.id)
    await session.flush()
    return user


def _prompt_password() -> str:
    first = getpass.getpass("Password (12+ characters): ")
    if first != getpass.getpass("Again: "):
        raise SystemExit("The passwords did not match.")
    return first


async def _main(args: argparse.Namespace) -> None:
    try:
        async with get_sessionmaker()() as session, session.begin():
            if args.command == "add":
                user, created = await add_user(
                    session, args.email, args.name, Role(args.role), _prompt_password()
                )
                if args.workspace_role:
                    await set_workspace(
                        session,
                        user,
                        workspace_role=WorkspaceRole(args.workspace_role),
                        division=args.division,
                        title=args.title,
                    )
                print(f"{'Added' if created else 'Updated'} {user.email} ({user.role.value}).")
                if user.member_no:
                    print(f"In the workspace as {user.member_no} ({user.workspace_role}).")
            elif args.command in ("activate", "deactivate"):
                user = await set_active(session, args.email, args.command == "activate")
                print(f"{user.email} is now {'active' if user.active else 'inactive'}.")
            else:
                users = (await session.execute(select(User).order_by(User.email))).scalars()
                for u in users:
                    state = "active" if u.active else "inactive"
                    member = f"{u.member_no or '-':<6}"
                    print(f"{u.email:<36} {u.role.value:<10} {state:<9} {member} {u.full_name}")
    except (ValueError, DomainError) as exc:
        raise SystemExit(str(exc)) from exc
    finally:
        await dispose_engine()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="python -m app.seed.users", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    add = sub.add_parser("add", help="add a user, or reset an existing one's password and role")
    add.add_argument("email")
    add.add_argument("name")
    add.add_argument("role", choices=[r.value for r in Role])
    add.add_argument(
        "--workspace-role",
        choices=[r.value for r in WorkspaceRole],
        help="also put them in the workspace and chat",
    )
    add.add_argument("--division", help="required for a leader (Field, Design, Production …)")
    add.add_argument("--title", help="job title shown in chat")

    for name in ("activate", "deactivate"):
        sub.add_parser(name).add_argument("email")
    sub.add_parser("list")

    asyncio.run(_main(parser.parse_args(argv)))


if __name__ == "__main__":
    main(sys.argv[1:])
