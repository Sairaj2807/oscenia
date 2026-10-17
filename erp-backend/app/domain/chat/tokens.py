"""Message text: cleaning it, and finding the mentions and task links inside it.

A stored message keeps mentions and task links as ids — ``<@M-05>``, ``<#T-102>`` — so a
renamed person or task still resolves and a mention can notify the right person. The client
turns what people type (``@Rina M.``) into these tokens before sending; the server stores the
text as given, but checks that every mention names a real person, because the only way to
send a token naming nobody is to have tampered with the request.

``parse_tokens`` is a port of ``parseTokens`` in ``erp-frontend/src/lib/chat.js``.
Stored text is escaped by the renderer, never interpreted: nothing here produces markup, and
nothing in a message may become a link without an explicit scheme allow-list.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Literal

from app.core.errors import Invalid

_TOKEN = re.compile(r"<([@#])((?:M|T)-\d+)>")
_MENTION = re.compile(r"<@(M-\d+)>")
_TASK = re.compile(r"<#(T-\d+)>")


@dataclass(frozen=True, slots=True)
class Part:
    type: Literal["text", "mention", "task"]
    value: str


def parse_tokens(text: str) -> list[Part]:
    """Stored text → segments to render: text, mention or task."""
    parts: list[Part] = []
    last = 0
    for m in _TOKEN.finditer(text):
        if m.start() > last:
            parts.append(Part("text", text[last : m.start()]))
        parts.append(Part("mention" if m.group(1) == "@" else "task", m.group(2)))
        last = m.end()
    if last < len(text):
        parts.append(Part("text", text[last:]))
    return parts


def mention_numbers(text: str) -> list[str]:
    """The member numbers mentioned, once each, in order of first appearance."""
    return list(dict.fromkeys(_MENTION.findall(text)))


def task_ids(text: str) -> list[str]:
    return list(dict.fromkeys(_TASK.findall(text)))


def clean_text(raw: str, *, max_chars: int) -> str:
    """Normalise what was typed: NFC, ``\\r\\n`` → ``\\n``, control characters dropped (but not
    newlines or tabs), trimmed. Raises ``Invalid`` for nothing, or too much.

    Zero-width joiners and variation selectors are *format* characters, not control ones, and
    are kept — emoji sequences need them.
    """
    text = unicodedata.normalize("NFC", raw).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch) != "Cc").strip()
    if not text:
        raise Invalid("A message cannot be empty.")
    if len(text) > max_chars:
        raise Invalid(f"A message can be at most {max_chars} characters.")
    return text
