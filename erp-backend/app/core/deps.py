"""Authentication and authorisation dependencies.

``require_action`` is a **dependency, not a decorator**, for one specific reason: it has to
reach the permitted-role list into the error body. A bare 403 tells a user nothing they can
act on; "Approve and disburse cash — restricted to CEO / Finance" tells them who to ask.
That mirrors the prototype's ``denialReason``, which exists for the same reason.

Authorisation is enforced here, server-side. The frontend's ``canDo`` checks decide whether
to render a button; they are a courtesy, not a control.
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from app.core.errors import PermissionDenied
from app.core.rbac import ROLE_META, ROLE_MODULES, can_do, can_see, denial_reason, roles_permitted
from app.core.security import AuthError, decode_token
from app.db.session import SessionDep
from app.domain.masters.models import User

# auto_error=False so a missing header raises our own 401 problem document rather than
# FastAPI's bare {"detail": "Not authenticated"}.
_bearer = HTTPBearer(auto_error=False, description="Access token from /auth/login")

BearerDep = Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)]


async def current_user(session: SessionDep, credentials: BearerDep) -> User:
    if credentials is None:
        raise AuthError("This endpoint needs an access token. Sign in at /auth/login.")

    payload = decode_token(credentials.credentials, expect="access")

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise AuthError("That token is not valid.") from exc

    user = (
        await session.execute(select(User).where(User.id == user_id))
    ).scalar_one_or_none()

    if user is None:
        raise AuthError("That account no longer exists.")
    if not user.active:
        # Checked against the database, not the token, so deactivating an account takes
        # effect immediately rather than at the next refresh.
        raise AuthError("That account has been deactivated.")

    return user


CurrentUser = Annotated[User, Depends(current_user)]


def require_action(action: str) -> Callable[[User], Coroutine[Any, Any, User]]:
    """Gate an endpoint on one of the named actions in ``app.core.rbac.ACTIONS``.

    Usage::

        @router.post("/journal-entries")
        async def post(user: Annotated[User, Depends(require_action("post_journal"))]): ...
    """

    async def dependency(user: CurrentUser) -> User:
        if not can_do(user.role, action):
            raise PermissionDenied(
                denial_reason(user.role, action) or "Not permitted.",
                action=action,
                permitted=[ROLE_META[r]["label"] for r in roles_permitted(action)],
            )
        return user

    return dependency


def require_module(module: str) -> Callable[[User], Coroutine[Any, Any, User]]:
    """Gate an endpoint on seeing a module, for screens whose edits are not a named action —
    the events module's guest list, say, which every role that sees events may work on."""

    async def dependency(user: CurrentUser) -> User:
        if not can_see(user.role, module):
            raise PermissionDenied(
                f"The {module} module is not available to this login.",
                action=f"module:{module}",
                permitted=[
                    ROLE_META[r]["label"] for r in ROLE_MODULES if can_see(r, module)
                ],
            )
        return user

    return dependency


async def chat_member(user: CurrentUser) -> User:
    """A login that is also in the workspace. The ``chat`` module is not enough: what a person
    may open inside chat is decided by their workspace persona, so no persona means no chat —
    and the message says who to ask, rather than a bare 403."""
    if not can_see(user.role, "chat"):
        raise PermissionDenied(
            "The chat module is not available to this login.",
            action="module:chat",
            permitted=[ROLE_META[r]["label"] for r in ROLE_MODULES if can_see(r, "chat")],
        )
    if user.workspace_role is None or user.member_no is None:
        raise PermissionDenied(
            "You are not in the workspace yet — ask the project manager to add you.",
            action="chat:member",
            permitted=[ROLE_META[r]["label"] for r in roles_permitted("manage_workspace")],
        )
    return user


async def workspace_member(user: CurrentUser) -> User:
    """A login that may use the workspace (tasks): the ``workspace`` module *and* a workspace
    persona. As with chat, what a person may see and do is decided by that persona, so no persona
    means no tasks — and the message says who to ask."""
    if not can_see(user.role, "workspace"):
        raise PermissionDenied(
            "The workspace module is not available to this login.",
            action="module:workspace",
            permitted=[ROLE_META[r]["label"] for r in ROLE_MODULES if can_see(r, "workspace")],
        )
    if user.workspace_role is None or user.member_no is None:
        raise PermissionDenied(
            "You are not in the workspace yet — ask the project manager to add you.",
            action="workspace:member",
            permitted=[ROLE_META[r]["label"] for r in roles_permitted("manage_workspace")],
        )
    return user


# Named aliases for the actions phase 1's endpoints need. Declaring them here rather than
# inline keeps the routers readable and means a permission change is a one-line edit in one
# place. The remaining actions get theirs as phases 4-7 land the endpoints that use them.
PostsJournal = Annotated[User, Depends(require_action("post_journal"))]
ManagesCoa = Annotated[User, Depends(require_action("manage_coa"))]
EditsTax = Annotated[User, Depends(require_action("edit_tax"))]
PublishesInvitation = Annotated[User, Depends(require_action("publish_invitation"))]
ManagesTemplates = Annotated[User, Depends(require_action("manage_templates"))]
ManagesUsers = Annotated[User, Depends(require_action("manage_users"))]
SeesEvents = Annotated[User, Depends(require_module("events"))]
ChatMember = Annotated[User, Depends(chat_member)]
WorkspaceMember = Annotated[User, Depends(workspace_member)]
ManagesWorkspace = Annotated[User, Depends(require_action("manage_workspace"))]
