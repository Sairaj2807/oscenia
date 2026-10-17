# The API image. Built by deploy/docker-compose.prod.yml; see deploy/README.md.
#
# Two stages so the compilers pip may need never reach the running image, and a non-root
# user because nothing here needs root and a compromised process should not have it.

FROM python:3.12-slim AS build

ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

WORKDIR /src
COPY pyproject.toml ./
COPY app ./app
RUN pip install .


FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/opt/venv/bin:$PATH" \
    ENV=production \
    STORAGE_DIR=/data/uploads

RUN groupadd --system app \
    && useradd --system --gid app --home-dir /app --no-create-home app \
    && mkdir -p /data/uploads \
    && chown -R app:app /data

COPY --from=build /opt/venv /opt/venv

WORKDIR /app
COPY --chown=app:app alembic.ini ./
COPY --chown=app:app alembic ./alembic
COPY --chown=app:app app ./app

USER app

EXPOSE 8000

# /health does a real database round-trip, so this goes unhealthy when Postgres does.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["python", "-c", "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"]

# One worker, deliberately: the scheduler runs in-process (app/jobs), so two workers would
# mean two schedulers. --proxy-headers makes request.client the real caller rather than
# Caddy, which the per-IP login throttle depends on. Uvicorn trusts X-Forwarded-For only
# from FORWARDED_ALLOW_IPS, which docker-compose.prod.yml pins to Caddy's fixed address — so
# another container on the edge network cannot forge its way past the throttle.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", \
     "--proxy-headers"]
