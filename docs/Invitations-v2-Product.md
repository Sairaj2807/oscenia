# Invitations v2 — Template gallery, media and broadcasting (product spec)

> **Historical record.** Written before the 17 Oct 2026 restructure. Paths and deploy steps below are as they were (`erp-prototype/` is now `erp-frontend/`, `oscenia-web/` is now `website/`, and Vercel is no longer used). Current state: [GO-LIVE-STATUS](./GO-LIVE-STATUS.md).


Version 0.1 · 2 Oct 2026 · Status: **product confirmed pending sign-off** — technical plan next.
Reference: Invitato (invitato.id/design, invitato.net/template-rominadia, template-hendryclarissa).

Replaces the current single-layout invitation builder (`components/events/InvitationBuilder.jsx`).

## Decisions

| # | Topic | Decision |
|---|---|---|
| D1 | Who builds | Oscenia staff **and** the event client (client from a private link, no login). |
| D2 | Template families | **Corporate** and **Wedding / Private**, sharing common sections. |
| D3 | Video | Paste a YouTube/Vimeo link **or** upload MP4/MOV. Prototype: uploads kept for the session only (labelled); backend stores them (cap ~200 MB). |
| D4 | Layout freedom | Each template has a fixed section order; sections toggle on/off and are filled in. Accent colour editable. Switching template keeps all content. No reorder, no free builder. |
| D5 | Template count | 6: Corporate — Gala, Launch, Summit; Wedding/Private — Royal, Minimal, Garden. |
| D6 | Client entry | Staff create a blank event and send the client a private link that opens the gallery. (Public gallery on oscenia.com deferred.) |
| D7 | Publishing | Staff only. Client clicks *Submit for review*; staff *Publish* or *Send back with a note*. Edits to a live invitation stay a draft until re-approved; guests keep the last approved version. |
| D8 | Client edits details | Client may edit date, venue and sessions. Review shows staff what changed and what it shifts (reminders, RSVP deadline). |
| D9 | Broadcasting | Two modes: (a) client sends themselves — per-guest personal link + WhatsApp (`wa.me`) button + copy; (b) Oscenia sends via platform by WhatsApp and/or email with a custom message. Only once published. |
| D10 | Contacts hand-over | Client sends their file to Oscenia; **staff import** (existing CSV import). No client upload screen. |
| D11 | Client self-send list | Uses the staff-imported list (personal links, named cover, QR). No general/public link. |
| D12 | Existing events | Aurora Gala → *Gala*, Meridian Launch → *Launch*; content, questions, guests, reminders carried over. Old builder removed. |
| D13 | Wishes | Shown immediately by default; per-event switch "Hold wishes for approval". Staff or client can hide a wish (kept on record). |
| D14 | Client links | One client link: gallery → editor → Send invitations (once published). Staff can revoke and reissue. |

## Features (core)

1. **Template gallery** — 6 cards, filter by family, sort; cover thumbnail, tagline, *Live preview* (full screen, sample content), *Use this template*.
2. **Editor** — section list (on/off + content form) left, live phone/desktop preview right; *Change template*.
3. **Sections**
   - Shared: Cover (guest name from personal link, *Open invitation*), Countdown + Add to Calendar, Event details (multiple sessions, each with venue + map), Gallery (slider + full screen), Video (link or upload), Background music (upload MP3 or 3 built-in tracks; play/pause), RSVP (existing form + custom questions), Wishes, QR access card (existing check-in desk).
   - Corporate: Host/sponsor logos, Agenda, Speakers, Dress code.
   - Wedding/Private: Couple + parents, Our story timeline, Gift (bank/e-wallet with copy, delivery address).
4. **Media** — photos shrunk and saved; video/music session-only in the prototype.
5. **Review & publish** — Waiting for review state in the ERP; change summary; send back with note.
6. **Send invitations**
   - Message with placeholders `{name} {link} {event} {date} {venue}`; email subject; per-guest preview.
   - Audience: all / not yet invited / category. Send now or scheduled.
   - Per-guest status: queued → sent → delivered/read → failed (simulated); retry failed; send log.
   - Client self-send: guest list with personal link, WhatsApp button, copy, "Sent by client" mark.

## Deferred
Public gallery on the website, pricing/payment; section reordering; more templates; light/dark and ID/EN toggle; livestream section; real media storage (backend); client contact upload.

## User flows
- **Staff:** New event → pick template now *or* send client link → import guest list → review submission → Publish → Send invitations (platform) → guests / reminders / check-in / report as today.
- **Client:** client link → gallery → preview → use template → fill sections, upload media → Submit for review → after publish: send invitations themselves (WhatsApp per guest) or leave it to Oscenia.
- **Guest:** personal link → cover with name → Open invitation (music) → RSVP / wishes → QR access card → scanned at check-in.
