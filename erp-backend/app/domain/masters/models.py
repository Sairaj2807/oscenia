"""Users and roles.

Created in phase 1 because ``journal_entries.posted_by_user_id`` needs the foreign key —
every posting records who made it. Phase 2 adds the *behaviour* on top: argon2 hashing,
JWT issue and refresh, and the ``require_action`` dependency that enforces the role/action matrix
ported from ``erp-frontend/src/lib/roles.js``.
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    func,
)
from sqlalchemy import Enum as SAEnum
from sqlalchemy.dialects.postgresql import UUID as PgUUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class Role(enum.StrEnum):
    CEO = "ceo"
    FINANCE = "finance"
    PM = "pm"
    SALES = "sales"
    WAREHOUSE = "warehouse"
    #: Staff and interns: a login for the workspace and chat, with no finance access at all.
    TEAM = "team"


class WorkspaceRole(enum.StrEnum):
    """Where someone sits in the project workspace (``workspaceRole`` in the prototype).

    Independent of ``Role``: Dinda is *sales* to the ledger and a Field *leader* to chat.
    """

    PM = "pm"
    LEADER = "leader"
    STAFF = "staff"
    INTERN = "intern"


class ChatStatus(enum.StrEnum):
    """The status a person chose. Whether they are connected is presence, kept in memory."""

    ONLINE = "online"
    IDLE = "idle"
    DND = "dnd"
    INVISIBLE = "invisible"


def enum_column(py_enum: type[enum.Enum], name: str) -> SAEnum:
    """A native Postgres enum that stores the member *values*, not their names.

    ``values_callable`` is not optional. Without it SQLAlchemy persists ``Role.CEO`` as
    ``'CEO'`` while every fixture, seed and API payload says ``'ceo'`` — a mismatch that
    only surfaces the first time something compares the two.
    """
    return SAEnum(
        py_enum,
        name=name,
        native_enum=True,
        values_callable=lambda e: [m.value for m in e],
    )


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    email: Mapped[str] = mapped_column(String(200), unique=True)
    password_hash: Mapped[str | None] = mapped_column(String(200), nullable=True)
    full_name: Mapped[str] = mapped_column(String(120))
    initials: Mapped[str] = mapped_column(String(8))
    role: Mapped[Role] = mapped_column(enum_column(Role, "user_role"))
    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    # --- account administration ------------------------------------------------------
    #: A temporary password an admin handed over: the person must replace it before using the app.
    must_change_password: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    password_changed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    #: The version inside an admin-issued password-reset link. Bumped when the link is used and
    #: when a new one is issued, so each link works once and a new one replaces the old.
    password_link_version: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    #: The screen language, kept per person (``en`` or ``id``).
    language: Mapped[str] = mapped_column(String(5), default="en", server_default="en")

    # --- workspace identity (chat) ---------------------------------------------------
    # One account is both the ERP login and the chat persona. ``workspace_role`` NULL means
    # the person is not in the workspace and has no chat.
    #: ``M-05`` — the id that appears inside stored message text (``<@M-05>``). Assigned
    #: once and never reused, so an old mention can never point at someone else.
    member_no: Mapped[str | None] = mapped_column(String(8), unique=True, nullable=True)
    division: Mapped[str | None] = mapped_column(String(64), nullable=True)
    workspace_role: Mapped[WorkspaceRole | None] = mapped_column(
        enum_column(WorkspaceRole, "workspace_role"), nullable=True
    )
    title: Mapped[str | None] = mapped_column(String(80), nullable=True)
    chat_status: Mapped[ChatStatus] = mapped_column(
        enum_column(ChatStatus, "chat_status"),
        default=ChatStatus.ONLINE,
        server_default=ChatStatus.ONLINE.value,
    )

    __table_args__ = (
        CheckConstraint("language IN ('en', 'id')", name="language_known"),
        CheckConstraint("password_link_version >= 1", name="password_link_version_positive"),
        CheckConstraint(
            "workspace_role IS NULL OR member_no IS NOT NULL", name="workspace_needs_member_no"
        ),
        CheckConstraint(
            "workspace_role IS DISTINCT FROM 'leader' OR division IS NOT NULL",
            name="leader_needs_division",
        ),
    )

    def __repr__(self) -> str:  # pragma: no cover
        return f"<User {self.email} ({self.role})>"


class ProjectDivision(Base):
    """A division that works on a project — the PM assigns these (``projectDivisions``)."""

    __tablename__ = "project_divisions"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    division: Mapped[str] = mapped_column(String(64), primary_key=True)


class ProjectMember(Base):
    """Someone named on a project. Leaders and the PM are on it through their division or
    their role (see ``member_project_ids``); this lists the staff and interns."""

    __tablename__ = "project_members"

    project_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    added_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    __table_args__ = (Index("ix_project_members_user", "user_id"),)


class RefreshToken(Base):
    """A refresh token the server can revoke.

    JWTs are self-validating, which is the point of them and also the problem: a signed
    token stays valid until it expires, whatever happens afterwards. Recording the ``jti``
    here gives us a revocation list, so signing out actually signs you out rather than
    merely forgetting the token client-side.

    Rotation on every refresh means a stolen token is usable once at most — the legitimate
    client's next refresh invalidates it, and a replay of the old one is refused.
    """

    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    jti: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        PgUUID(as_uuid=True), ForeignKey("users.id"), index=True
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (Index("ix_refresh_tokens_user_active", "user_id", "revoked_at"),)


class TaxConfig(Base):
    """Configurable tax rates — ``seedTaxConfig`` in the prototype.

    Four keys ship: ``pph23`` (service withholding, 2%, **active**), ``pph21`` (employee
    withholding, 5%, inactive), ``ppn`` (VAT, 11%, inactive) and ``corporate`` (income tax,
    22%, **active**).

    Corporate tax is the odd one out and the important one: it has **no account** and is
    never posted. The income statement computes it live from this rate, which is what makes
    the client's "manual override prior to displaying Tax Expense & Net Profit" work —
    editing the rate moves NPAT immediately rather than requiring an adjusting entry.
    """

    __tablename__ = "tax_config"

    key: Mapped[str] = mapped_column(String(16), primary_key=True)
    label: Mapped[str] = mapped_column(String(80))

    #: Percent, not a fraction: 2 means 2%. Three decimals so 1.5% and 0.125% both fit.
    rate: Mapped[Decimal] = mapped_column(Numeric(6, 3))

    active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")

    #: The account this tax posts to. NULL for corporate income tax, which is derived.
    account_code: Mapped[str | None] = mapped_column(
        String(32), ForeignKey("accounts.code", onupdate="CASCADE"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
