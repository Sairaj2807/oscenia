"""A stand-in WebSocket for driving the chat handler in-process.

Starlette's ``TestClient`` runs the app on its own event loop, and the test database
connection belongs to the test's loop — so the handler is driven directly instead, in the same
loop as everything else, with this object playing the browser.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

from starlette.websockets import WebSocketDisconnect


class FakeWS:
    def __init__(self, origin: str | None = None) -> None:
        self.headers: dict[str, str] = {} if origin is None else {"origin": origin}
        self._incoming: asyncio.Queue[str | None] = asyncio.Queue()
        self.sent: list[dict[str, Any]] = []
        self.accepted = False
        self.close_code: int | None = None

    # --- what the handler calls ----------------------------------------------------------

    async def accept(self) -> None:
        self.accepted = True

    async def receive_text(self) -> str:
        item = await self._incoming.get()
        if item is None:
            raise WebSocketDisconnect(1000)
        return item

    async def send_text(self, data: str) -> None:
        if self.close_code is not None:
            raise RuntimeError("send on a closed socket")
        self.sent.append(json.loads(data))

    async def close(self, code: int = 1000) -> None:
        self.close_code = code
        self._incoming.put_nowait(None)  # wake a receive loop that is waiting

    # --- what the test does ---------------------------------------------------------------

    def client_send(self, frame: dict[str, Any] | str) -> None:
        self._incoming.put_nowait(frame if isinstance(frame, str) else json.dumps(frame))

    def client_disconnect(self) -> None:
        self._incoming.put_nowait(None)

    def of(self, kind: str) -> list[dict[str, Any]]:
        return [f for f in self.sent if f.get("type") == kind]

    async def wait_for(self, kind: str, count: int = 1, timeout: float = 3.0) -> dict[str, Any]:
        """The ``count``-th frame of this type, waiting for it to arrive."""
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while True:
            found = self.of(kind)
            if len(found) >= count:
                return found[count - 1]
            if loop.time() > deadline:
                seen = [f["type"] for f in self.sent]
                raise AssertionError(f"no {kind!r} frame #{count} within {timeout}s; got {seen}")
            await asyncio.sleep(0.01)

    async def wait_closed(self, timeout: float = 3.0) -> int:
        loop = asyncio.get_running_loop()
        deadline = loop.time() + timeout
        while self.close_code is None:
            if loop.time() > deadline:
                raise AssertionError(f"not closed within {timeout}s; got {self.sent}")
            await asyncio.sleep(0.01)
        return self.close_code


async def settle(seconds: float = 0.15) -> None:
    """Give queued frames time to be delivered, before asserting that nothing arrived."""
    await asyncio.sleep(seconds)


class SharedSessions:
    """A session factory that hands out the test's one rolled-back session, never closing it."""

    def __init__(self, db: Any) -> None:
        self.db = db

    def __call__(self) -> SharedSessions:
        return self

    async def __aenter__(self) -> Any:
        return self.db

    async def __aexit__(self, *exc: object) -> bool:
        return False
