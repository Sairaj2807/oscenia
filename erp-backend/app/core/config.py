"""Application settings, read from the environment (and .env in development)."""

from functools import lru_cache
from typing import ClassVar, Literal

from pydantic import Field, PostgresDsn, ValidationInfo, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    env: Literal["development", "test", "production"] = "development"
    debug: bool = False

    # The company's operating timezone, and therefore what "today" means.
    #
    # This is a business setting, not a display preference. Oscenia is in Jakarta (UTC+7),
    # so an invoice ageing bucket, a DP payment countdown and a depreciation due date all
    # turn over at Jakarta midnight. Computing "today" in UTC would make the backend seven
    # hours behind the business for part of every day — an invoice due today would read as
    # due tomorrow, and a month-end depreciation run would fire on the wrong date.
    timezone: str = "Asia/Jakarta"

    # --- background jobs --------------------------------------------------
    #
    # Off by default, and deliberately so. An in-process scheduler that starts with the app
    # would post month-end depreciation to whatever database a developer happened to be
    # pointing at, and would fire inside the test suite. Production turns it on explicitly.
    scheduler_enabled: bool = False

    # --- chat -------------------------------------------------------------
    #: Authors may edit or delete their own message for this long (decision 5 in the BRD).
    #: The server's clock is the only authority; a client-supplied time is never trusted.
    chat_edit_window_minutes: int = 15
    #: Capped at 4000 because the database refuses more (``chat_messages.text_not_too_long``).
    chat_message_max_chars: int = Field(default=4000, ge=1, le=4000)
    #: At most this many messages per sender in the window, then blocked for a short while.
    chat_send_limit: int = 30
    chat_send_window_seconds: int = 10
    chat_send_block_seconds: int = 10
    #: The hub holds every WebSocket in this process, so a second worker would deliver half the
    #: events. This takes a Postgres advisory lock so a second one refuses upgrades instead.
    #: Off only for tests, which run several apps in one process.
    #: Uploads: per uploader, then a short block. A file is a bigger ask than a message.
    chat_upload_limit: int = 20
    chat_upload_window_seconds: int = 60
    chat_upload_block_seconds: int = 60
    #: How long a link to an attachment works. Short, because the link is the credential and
    #: outlives access removal until it expires; a client asks for a fresh one when it needs it.
    chat_attachment_url_seconds: int = 300
    chat_hub_single_worker_guard: bool = True
    chat_hub_lock_key: int = 7_204_001

    # --- Google Calendar --------------------------------------------------
    #: From a Google Cloud project with the Calendar API on (an OAuth client of type "web").
    #: All four are needed; with any missing the Google screen says the server is not set up and
    #: nothing else breaks.
    google_client_id: str = ""
    google_client_secret: str = ""
    #: Must be one of the client's authorised redirect addresses, for example
    #: ``https://<api host>/api/v1/google/callback``.
    google_redirect_uri: str = ""
    #: Encrypts the stored refresh tokens. Generate one with ``Fernet.generate_key()`` (see
    #: ``app/domain/gcal/crypto.py``).
    google_token_key: str = ""
    #: Where the browser lands after Google sends it back.
    google_return_url: str = "http://localhost:5173/google-calendar"

    # --- meeting minutes --------------------------------------------------
    #: Which AI service writes the minutes: ``deepseek`` or ``openai`` (both speak the same chat
    #: API). Empty means none: minutes are then made by rules from the transcript, labelled as
    #: such. The key lives only here — it never reaches a browser and is never logged.
    ai_provider: str = ""
    ai_api_key: str = ""
    #: Empty uses the provider's default model.
    ai_model: str = ""
    #: Empty uses the provider's own address; set for a compatible host (or a test double).
    ai_base_url: str = ""
    ai_timeout_seconds: float = 50.0
    #: The spend cap: AI minutes per person per day. Over it, the rule-based minutes (free) are
    #: written instead, and say why.
    ai_minutes_per_day: int = 10
    ai_minutes_window_seconds: int = 86_400

    # --- logging ----------------------------------------------------------
    log_level: str = "INFO"

    #: JSON lines for anything shipping logs somewhere; plain text for a terminal.
    log_json: bool = False

    # --- database ---------------------------------------------------------
    database_url: PostgresDsn = PostgresDsn(
        "postgresql+asyncpg://oscenia:oscenia@localhost:5433/oscenia_erp"
    )
    test_database_url: PostgresDsn = PostgresDsn(
        "postgresql+asyncpg://oscenia:oscenia@localhost:5433/oscenia_erp_test"
    )
    db_echo: bool = False
    db_pool_size: int = 5
    db_max_overflow: int = 10

    # --- auth (phase 2; declared now so .env.example is complete) ----------
    #: Development placeholder. At least 32 bytes, because HMAC-SHA256 keys shorter than
    #: the digest add no security and PyJWT rightly warns about it (RFC 7518 §3.2).
    jwt_secret: str = "dev-only-insecure-key-change-me-in-production"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 30
    refresh_token_days: int = 14

    #: Signs short-lived file URLs and invitation QR codes (``app.core.signing``). Separate
    #: from ``jwt_secret`` so either can be rotated alone; same length and production rules.
    signing_secret: str = "dev-only-insecure-signing-key-change-me-in-production"

    # --- storage (phase 6) ------------------------------------------------
    storage_dir: str = "./var/attachments"
    #: Finance attachments. Invitation media has per-kind limits in ``app.core.storage``.
    max_upload_bytes: int = 10 * 1024 * 1024
    #: How long a signed file URL stays usable.
    file_url_seconds: int = 3600
    #: The weekly orphan sweep (``core/storage_sweep.py``) only reports until this is switched on.
    storage_sweep_delete: bool = False
    #: A stored file nothing refers to is left alone this long first, so a file uploaded a moment
    #: before the row that will point at it is never taken.
    storage_sweep_grace_days: int = 7

    # --- events -----------------------------------------------------------
    #: How long a client edit link works before staff must regenerate it. Revoking early is
    #: always possible (``events.edit_link_version``); this only caps a forgotten link.
    client_link_days: int = 90

    # --- client survey ----------------------------------------------------
    #: How long the link a client is sent to rate an event works. Staff can revoke it sooner.
    survey_link_days: int = 30

    # --- accounts ---------------------------------------------------------
    #: How long an admin-issued password-reset link works. It is single-use either way.
    password_reset_hours: int = 24

    # --- api --------------------------------------------------------------
    api_prefix: str = "/api/v1"
    cors_origins: list[str] = ["http://localhost:5273", "http://localhost:5173"]

    #: Anything shorter than the SHA-256 digest weakens the MAC without saving anything.
    MIN_SECRET_BYTES: ClassVar[int] = 32

    @field_validator("jwt_secret", "signing_secret")
    @classmethod
    def _secret_is_usable(cls, v: str, info: ValidationInfo) -> str:
        name = info.field_name
        if len(v.encode()) < cls.MIN_SECRET_BYTES:
            raise ValueError(
                f"{name} must be at least {cls.MIN_SECRET_BYTES} bytes for HMAC-SHA256. "
                'Generate one with: python -c "import secrets; print(secrets.token_urlsafe(48))"'
            )

        # A published default in production would make every token forgeable by anyone who
        # has read this repository.
        if info.data.get("env") == "production" and v.startswith("dev-only-"):
            raise ValueError(f"{name} must be set explicitly when env=production")
        return v

    @property
    def sqlalchemy_url(self) -> str:
        """The URL for the current environment — tests never touch the dev database."""
        url = self.test_database_url if self.env == "test" else self.database_url
        return str(url)


@lru_cache
def get_settings() -> Settings:
    return Settings()
