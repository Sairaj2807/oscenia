"""A write must be committed before its response is sent.

FastAPI runs a ``yield`` dependency's exit code after the response is sent unless the
dependency says ``scope="function"``. The request session commits in that exit code, so without
the scope a client that read straight after a write was sometimes answered before the commit:
measured against a real uvicorn as 57 stale reads in 150 (the screens re-read right after every
save). The in-process test client overrides the session, so it cannot show the race; this pins
the setting that prevents it.
"""

from __future__ import annotations

from typing import get_args

from fastapi.params import Depends

from app.db.session import SessionDep


def test_the_request_session_commits_before_the_response_is_sent() -> None:
    depends = [m for m in get_args(SessionDep)[1:] if isinstance(m, Depends)]
    assert len(depends) == 1
    assert depends[0].scope == "function"
