"""Invitation templates: the sections they may place, the six built-ins, and the studio rules.

Ported from ``erp-frontend/src/lib/templates.js``. A template is a skin over shared
sections — colours, fonts, a cover layout, an ornament and the fixed order of its sections.
Content lives on the event, keyed by section, so switching template never loses anything.

Built-ins and the design team's own (Template Studio) share one table,
``invitation_templates``, so an invitation's ``template_id`` is a real foreign key whichever
kind it names. The built-ins are inserted by their migration and are read-only here.

Fonts are stored as *keys* (``playfair``), never as CSS stacks: the frontend owns which
Google Fonts it loads, and a key is what ``validate_template`` can check.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from typing import Any

#: Every section a template can place. ``family`` limits where it is offered.
SECTIONS: dict[str, dict[str, Any]] = {
    "cover": {"label": "Cover", "family": "both", "required": True},
    "message": {"label": "Welcome message", "family": "both"},
    "couple": {"label": "Couple", "family": "private"},
    "hosts": {"label": "Hosts & sponsors", "family": "corporate"},
    "countdown": {"label": "Countdown", "family": "both"},
    "details": {"label": "Date & venue", "family": "both", "required": True},
    "agenda": {"label": "Agenda", "family": "corporate"},
    "speakers": {"label": "Speakers", "family": "corporate"},
    "story": {"label": "Our story", "family": "private"},
    "dresscode": {"label": "Dress code", "family": "both"},
    "gallery": {"label": "Gallery", "family": "both"},
    "video": {"label": "Video", "family": "both"},
    "rsvp": {"label": "RSVP & QR access card", "family": "both", "required": True},
    "wishes": {"label": "Wishes", "family": "both"},
    "gift": {"label": "Gifts", "family": "private"},
}

REQUIRED_SECTIONS = frozenset(k for k, v in SECTIONS.items() if v.get("required"))

#: Not a page section: a play/pause control over the whole invitation.
MUSIC = "music"

FAMILIES = {"corporate": "Corporate", "private": "Wedding & private"}
FONT_KEYS = frozenset({"cinzel", "cormorant", "inter", "playfair", "montserrat", "vibes"})
COVERS = ("centered", "split", "framed", "fullbleed")
ORNAMENTS = ("gold-rule", "floral", "leaf", "grid", "none")
#: Artwork a studio template may carry: stored-file references, each optional.
ART_SLOTS = ("coverBg", "pageBg", "frame", "ornament")
STATUSES = ("draft", "published", "archived")

_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def _builtin(
    id_: str,
    family: str,
    name: str,
    tagline: str,
    palette: tuple[str, str, str, str],
    fonts: tuple[str, str, str],
    cover: str,
    ornament: str,
    sections: list[str],
    off: list[str],
) -> dict[str, Any]:
    bg, surface, accent, text = palette
    heading, body, script = fonts
    return {
        "id": id_,
        "family": family,
        "name": name,
        "tagline": tagline,
        "palette": {"bg": bg, "surface": surface, "accent": accent, "text": text},
        "fonts": {"heading": heading, "body": body, "script": script},
        "cover": cover,
        "ornament": ornament,
        "sections": sections,
        "off": off,
        "art": {slot: None for slot in ART_SLOTS},
        "status": "published",
    }


#: The six templates, as ``templates.js`` defines them (fonts as keys). The migration that
#: creates ``invitation_templates`` inserts exactly these rows; keep the two in step.
BUILTIN_TEMPLATES: list[dict[str, Any]] = [
    _builtin(
        "gala",
        "corporate",
        "Gala",
        "Midnight and gold, framed like an engraved card.",
        ("#0b1426", "#132038", "#c6a15b", "#f5f0e6"),
        ("cinzel", "cormorant", "cinzel"),
        "framed",
        "gold-rule",
        [
            "cover",
            "message",
            "countdown",
            "details",
            "agenda",
            "speakers",
            "hosts",
            "dresscode",
            "gallery",
            "video",
            "rsvp",
            "wishes",
        ],
        ["speakers", "hosts"],
    ),
    _builtin(
        "launch",
        "corporate",
        "Launch",
        "Bold, modern and video-first, for reveals and product nights.",
        ("#fbf1ef", "#ffffff", "#b76e79", "#3a2227"),
        ("montserrat", "inter", "playfair"),
        "fullbleed",
        "none",
        [
            "cover",
            "message",
            "video",
            "countdown",
            "details",
            "agenda",
            "speakers",
            "gallery",
            "hosts",
            "dresscode",
            "rsvp",
            "wishes",
        ],
        ["speakers", "hosts"],
    ),
    _builtin(
        "summit",
        "corporate",
        "Summit",
        "Clean and structured, with room for an agenda and speakers.",
        ("#f4f6fb", "#ffffff", "#2f5bea", "#13203d"),
        ("montserrat", "inter", "montserrat"),
        "split",
        "grid",
        [
            "cover",
            "message",
            "details",
            "countdown",
            "agenda",
            "speakers",
            "hosts",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
        ],
        [],
    ),
    _builtin(
        "royal",
        "private",
        "Royal",
        "Ornamental florals and script names, for a grand celebration.",
        ("#fbf7ef", "#ffffff", "#a8823c", "#3b2f1e"),
        ("cormorant", "cormorant", "vibes"),
        "centered",
        "floral",
        [
            "cover",
            "message",
            "couple",
            "countdown",
            "details",
            "story",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
            "gift",
        ],
        ["dresscode"],
    ),
    _builtin(
        "minimal",
        "private",
        "Minimal",
        "Quiet white space and a fine serif. Lets the photos speak.",
        ("#ffffff", "#f6f6f4", "#1f1f1f", "#1f1f1f"),
        ("playfair", "inter", "playfair"),
        "split",
        "none",
        [
            "cover",
            "couple",
            "message",
            "details",
            "countdown",
            "gallery",
            "story",
            "video",
            "dresscode",
            "rsvp",
            "gift",
            "wishes",
        ],
        ["dresscode"],
    ),
    _builtin(
        "garden",
        "private",
        "Garden",
        "Soft pastels and leaf sprigs, for garden and daytime events.",
        ("#f3f6ef", "#ffffff", "#6f8f5b", "#2c3a26"),
        ("cormorant", "inter", "vibes"),
        "centered",
        "leaf",
        [
            "cover",
            "message",
            "couple",
            "details",
            "countdown",
            "story",
            "gallery",
            "video",
            "dresscode",
            "rsvp",
            "wishes",
            "gift",
        ],
        ["dresscode"],
    ),
]

BUILTIN_IDS = frozenset(t["id"] for t in BUILTIN_TEMPLATES)


def is_file_ref(value: Any) -> bool:
    """A stored-file reference, ``{key, name, size, type}`` — the prototype's media shape."""
    return isinstance(value, Mapping) and isinstance(value.get("key"), str) and bool(value["key"])


def _strs(value: Any) -> list[str] | None:
    """``value`` as a list of strings, or ``None`` if it is anything else. Membership tests
    against dicts and sets raise on unhashable items, so shapes are checked first."""
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
        return None
    return value


def validate_template(t: Mapping[str, Any]) -> str | None:
    """``None`` when a studio template (as stored) is usable; otherwise what is wrong.

    The same checks, in the same order and words, as the prototype's ``validateTemplate``,
    so the studio shows the server's reason verbatim. Never raises on a malformed value.
    """
    if not isinstance(t, Mapping):
        return "Not a template."
    tid = t.get("id")
    if not isinstance(tid, str) or not tid or tid in BUILTIN_IDS:
        return "The template needs its own id."
    name = t.get("name")
    if not isinstance(name, str) or not name.strip():
        return "Give the template a name."
    tagline = t.get("tagline") or ""
    if not isinstance(tagline, str):
        return "The tagline must be text."
    if len(name) > 40 or len(tagline) > 120:
        return "The name or tagline is too long."
    family = t.get("family")
    if not isinstance(family, str) or family not in FAMILIES:
        return "Choose a family."
    palette = t.get("palette")
    if not isinstance(palette, Mapping) or not all(
        isinstance(palette.get(k), str) and _HEX.match(palette[k])
        for k in ("bg", "surface", "accent", "text")
    ):
        return "Every colour must be a hex colour like #c6a15b."
    fonts = t.get("fonts")
    if not isinstance(fonts, Mapping) or not all(
        isinstance(fonts.get(k), str) and fonts[k] in FONT_KEYS
        for k in ("heading", "body", "script")
    ):
        return "Choose fonts from the list."
    if t.get("cover") not in COVERS:
        return "Choose a cover layout."
    if t.get("ornament") not in ORNAMENTS:
        return "Choose an ornament."
    sections = _strs(t.get("sections"))
    if not sections or sections[0] != "cover" or len(set(sections)) != len(sections):
        return "The cover comes first, and no section twice."
    if not all(s in SECTIONS and SECTIONS[s]["family"] in ("both", family) for s in sections):
        return "A section does not suit this family."
    if not REQUIRED_SECTIONS.issubset(sections):
        return "Cover, date & venue and RSVP are required."
    off = _strs(t.get("off"))
    if off is None or not all(s in sections and s not in REQUIRED_SECTIONS for s in off):
        return "Only optional sections can start switched off."
    art = t.get("art")
    if not isinstance(art, Mapping) or not all(
        isinstance(k, str) and k in ART_SLOTS and (v is None or is_file_ref(v))
        for k, v in art.items()
    ):
        return "Artwork must be uploaded files."
    if t.get("status") not in STATUSES:
        return "Unknown template status."
    return None


def new_template(
    template_id: str, *, base: Mapping[str, Any] | None = None, family: str = "private"
) -> dict[str, Any]:
    """A new studio template, as stored: a copy of ``base``, or a blank in the family's first
    built-in's section order."""
    if base is not None:
        return {
            "id": template_id,
            "family": base["family"],
            "name": f"{base['name']} copy"[:40],
            "tagline": base.get("tagline") or "",
            "palette": dict(base["palette"]),
            "fonts": dict(base["fonts"]),
            "cover": base["cover"],
            "ornament": base["ornament"],
            "sections": list(base["sections"]),
            "off": list(base["off"]),
            "art": {**{slot: None for slot in ART_SLOTS}, **dict(base.get("art") or {})},
            "status": "draft",
        }
    first = next((b for b in BUILTIN_TEMPLATES if b["family"] == family), BUILTIN_TEMPLATES[0])
    private = first["family"] == "private"
    return {
        "id": template_id,
        "family": first["family"],
        "name": "Untitled design",
        "tagline": "",
        "palette": {"bg": "#ffffff", "surface": "#f6f4ef", "accent": "#8a6d3b", "text": "#2a2520"},
        "fonts": (
            {"heading": "playfair", "body": "inter", "script": "vibes"}
            if private
            else {"heading": "montserrat", "body": "inter", "script": "montserrat"}
        ),
        "cover": "centered" if private else "split",
        "ornament": "none",
        "sections": list(first["sections"]),
        "off": list(first["off"]),
        "art": {slot: None for slot in ART_SLOTS},
        "status": "draft",
    }


def in_gallery(template: Mapping[str, Any] | None) -> bool:
    """May this template be picked for an invitation now? Built-ins always; studio ones once
    in the gallery."""
    if template is None:
        return False
    return template["id"] in BUILTIN_IDS or template.get("status") == "published"


def section_on(
    template: Mapping[str, Any] | None, toggles: Mapping[str, Any], section_id: str
) -> bool:
    """Is this section switched on? Toggles nobody touched follow the template's default."""
    if template is None or section_id not in template["sections"]:
        return False
    if section_id in REQUIRED_SECTIONS:
        return True
    value = toggles.get(section_id)
    return section_id not in template["off"] if value is None else bool(value)
