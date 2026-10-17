# Invitations v2: template gallery, media, review & broadcasting

## Context
The client wants invitations to work like Invitato: pick from a gallery of designed templates, add their own photos, video and music, and get a shareable link with personalised guest invites. Today `/erp` has one fixed layout (`InvitationBuilder.jsx` + `InvitationView.jsx`) with a palette, fonts and copy. Product decisions D1–D14 are in `docs/Invitations-v2-Product.md`. In short:
- Staff and the client both build. The client works from one private link.
- 6 templates in 2 families (Corporate, Wedding/Private).
- Sections toggle on/off and are filled in. There is no reordering.
- Video and music: a link or an upload. Uploads are saved in this browser (IndexedDB) in the prototype, which is better than the session-only plan agreed in D3.
- Staff-only publishing with a review step. The client can edit the date, venue and sessions.
- Invitations are sent either by the client (WhatsApp per guest) or by Oscenia (WhatsApp/email with a custom message). Staff import the contacts.
- Wishes have a per-event hold switch.
- The two seed events move to the new templates, and the old builder is removed.

Everything stays a front-end prototype (zustand + localStorage), and sending is simulated, as it is for reminders today.

## Architecture

### 1. Templates = shared sections + a skin (not 6 separate pages)
- `src/lib/templates.js` is a registry. Each entry has `{ id, family:'corporate'|'private', name, tagline, palette:{bg,surface,accent,text,muted}, fonts:{heading,body,script?}, sections:[ordered ids], cover:'centered'|'split'|'framed'|'fullbleed', ornament:'gold-rule'|'floral'|'leaf'|'grid'|'none', sample:{…demo content} }`.
  - Corporate: **gala** (dark/gold, framed cover), **launch** (bold, full-bleed video cover), **summit** (clean, split cover, agenda/speakers).
  - Private: **royal** (ornamental floral, script names), **minimal** (white, serif), **garden** (pastel, leaf illustrations).
- Section components in `src/components/invite/sections/*.jsx` are written once and themed by CSS variables (`--inv-bg`, `--inv-accent`, `--inv-heading`, …) set by `InviteRenderer`. Ornaments are inline SVG in `src/components/invite/ornaments.jsx`.
- `src/components/invite/InviteRenderer.jsx` replaces `InvitationView.jsx`. It takes `(event, invite, {guest, mode:'live'|'preview'|'sample', device})`, walks `template.sections`, renders the enabled ones, and passes `children`-style slots for RSVP. It is used by the guest page, the editor preview and the gallery live preview, so preview = live.
- New fonts go in the `index.html` Google Fonts link: Great Vibes (script), Playfair Display, Montserrat. The existing Cinzel, Cormorant and Inter stay.

### 2. Section catalogue
- Shared: `cover` (guest name from `?g=`, "Open invitation" gate), `countdown` (+ Add to Calendar `.ics` via a Blob download), `details` (main session + extra `sessions`, each with a map link), `gallery` (slider + full-screen lightbox), `video`, `rsvp` (the existing form moved out of `InvitePage.jsx`), `wishes`, `access` (the existing QR card), and `music` (a floating play/pause control, not a page section).
- Corporate: `hosts` (logos), `agenda`, `speakers`, `dresscode`.
- Private: `couple` (+ parents, Instagram), `story` (timeline), `gift` (bank/e-wallet with copy, address).
- `message` is a free text block shared by both families.

### 3. Data model (on each event in `useProto`)
```
invite: {                       // the DRAFT, edited by staff and the client
  templateId: null|'gala'…,     // null → the gallery is shown
  accent: null|'#hex',
  on: { [sectionId]: bool },    // toggles; content is kept when a section is off or missing from the template
  content: { cover:{eyebrow,title,subtitle,image}, message:{body}, details:{date,time,venue,mapUrl,sessions:[{id,name,date,time,venue,mapUrl}]},
             gallery:{photos:[dataUrl]}, video:{kind:'link'|'upload',url,file?}, music:{kind:'builtin'|'upload',trackId,file?},
             hosts:{logos:[]}, agenda:{rows:[{time,label}]}, speakers:{people:[{name,role,photo}]}, dresscode:{text},
             couple:{a:{name,parents,photo,ig},b:{…}}, story:{items:[{date,title,text,photo}]}, gift:{accounts:[{bank,number,holder}],address} }
}
published: { …same shape } | null   // snapshot guests see; set on Publish
review: { state:'editing'|'submitted'|'returned', submittedAt, submittedBy:'client'|'staff', note, returnedAt }
holdWishes: bool,  wishes: [{ id, guestId|null, name, text, at, hidden, approved }]
broadcasts: [{ id, mode:'platform', channel:'whatsapp'|'email'|'both', subject, message, audience, scheduledAt, createdAt, by,
               recipients:[{ guestId, channel, status:'queued'|'sent'|'delivered'|'read'|'failed', reason, at }] }]
guest additions: invitedAt, invitedVia:'platform'|'client'|null
```
- `event.date/time/venue` stay the source for reminders, the RSVP deadline, check-in and reports. The draft holds `content.details`.
  - **Publish copies it onto the event**, so a client's date change only takes effect once staff approve it (D7/D8).
  - **Exception:** while the event has never been published (`published === null`), `updateContent('details')` writes through to the event fields immediately. Nothing guest-facing depends on it yet, and the Reminders and Check-in tabs stay correct for a draft event.
- `event.name` (the ERP identity) and the RSVP settings (`rsvpDeadline`, `rsvpFields`, `maxPax`, `feedbackUrl`, custom questions) stay **staff-only**, live fields. They move into a staff "RSVP settings" panel in the editor and are not part of the draft/review cycle, exactly as today.
- On publish, if `rsvpDeadline > new date`, the review panel offers to clamp it to the event date. This reuses the existing warning at `InvitationBuilder.jsx:150`.
- `longDate` moves from `InvitationView.jsx` to `src/lib/invites.js`. It is used by `InvitePage.jsx:76,123,250,264`.
- `design` and `src/components/events/InvitationView.jsx` are removed. Their readers move to `templateOf(event)` + `inviteContent(event)`: `Events.jsx:35-42`, `WalkInPage.jsx:29-48`, `InvitePage.jsx`, `useProto.createEvent` and `verify-proto.mjs:105-106`.
- Add a `templateOf(event)` helper in `src/lib/templates.js` that returns the palette and fonts. It replaces `paletteOf`.
- **Uploaded video/music go to IndexedDB, not an in-memory Map** (a correction from the earlier session-only idea).
  - An in-memory Map lives in one tab only. The demo's core flow is a client tab plus a staff tab, so staff would never see the client's video in review.
  - IndexedDB is shared by every tab on the same browser, survives reloads, and allows hundreds of MB.
  - `src/lib/mediaStore.js` (raw IndexedDB, no new dependency): `putMedia(file) → key`, `getMediaUrl(key)` (blob → objectURL, cached), `deleteMedia(key)`.
  - The content stores `{key, name, size, type}`.
  - Caps: video ≤ 200 MB (MP4/MOV/WebM), music ≤ 20 MB (MP3/M4A), checked by extension and MIME type (as `lib/attachments.js` `checkFile` does).
  - If the key is missing (site data cleared, or another browser or phone), the renderer shows a placeholder: "Uploaded on another device — available once the backend is live". The UI label becomes "Saved in this browser only (prototype)".
  - Reset demo data clears the store.
  - The guest page on another device still has no video. That's the same limit as RSVPs today, and the link option covers it. Photos keep using `shrinkImage` (`src/lib/images.js:10`), with a total photo budget (about 2.5 MB) enforced in the store, following the `addAttachment` budget pattern (`useProto.js:285`, `lib/attachments.js`).
- **Built-in music:** 3 short ambient loops made with the Web Audio API (`src/lib/music.js`), so there are no audio files and no licensing. Flagged as placeholders; the backend uses licensed tracks.
- **Persist:** bump `VERSION` 5 → 6 (`useProto.js:79`). The existing `migrate: () => seedState()` resets old saves, as before.
- **Seeds** (`protoSeed.js:412+`): the Gala gets `gala`, Meridian gets `launch`. Their copy, programme (→ agenda), questions, guests and reminders are mapped over and both are published. Add a few seed wishes, plus one broadcast on the Gala. `PALETTES`/`FONT_PAIRS` are removed or replaced by the template registry.

### 4. Store actions (`src/store/useProto.js`, events section ~:468)
- `createEvent`: the starter `invite` has `templateId:null`, `content.details` taken from the form, and `review.state:'editing'`. `NewEventModal` loses the palette picker (`Events.jsx:77`).
- `chooseTemplate(id, templateId)`: sets the template. Content is kept, so this also covers "Change template".
  - Toggles the user has already set are kept.
  - Sections never toggled get the template's default.
  - Sections missing from the new template are hidden, not deleted, and come back if they switch back.
- `setSection(id, sectionId, on)`, `updateContent(id, sectionId, patch)` (validated per section: links via `safeLink`, images via `safeImage`, list caps), and `setAccent`.
- `submitForReview(id, by)`, `returnToClient(id, note)`, `publishInvite(id)` (copies draft → `published`, details → event fields, `status:'Published'`, `review.state:'editing'`), `unpublish(id)`, and `regenerateEditToken(id)`.
- `inviteChanges(event)` in `src/lib/invites.js` diffs the draft against `published` for the review panel. For a date change it lists the reminders that move, using `reminderDate` from `lib/events.js`.
- `addWish(eventId, {guestId,name,text})` (rate-capped per guest, length ≤ 500), `setWishHidden`, `approveWish`, `setHoldWishes`.
- `sendBroadcast(eventId, {channel, subject, message, audience, scheduledAt})`:
  - Builds recipients from the audience: all / not invited yet / category (`GUEST_CATEGORIES`).
  - Gives each a status deterministically: no phone → WA failed, no email → email failed, otherwise `delivered`/`read` from a token hash.
  - Stamps `invitedAt/invitedVia`, writes `sendLog` (same shape as `sendReminderNow`, `useProto.js:747`) and refuses unless the event is Published.
  - Related actions: `retryFailed(eventId, broadcastId)` and `markSentByClient(eventId, guestId)`.
  - **Scheduling:** the demo runs on a fixed day (`DEMO_TODAY = 2026-07-26`, `lib/format.js:86`), so a scheduled batch can't fire by itself. It is saved as **Scheduled**, with "Send now" and "Cancel", the same honesty as reminders ("with the backend, sends automatically").
  - Recipients get one row per guest per channel ("both" = WA + email rows).
  - The personal link is the existing `guest.token` (`addGuests` already issues one, `useProto.js:666`).
- **Countdown** counts down from `DEMO_TODAY` plus the wall-clock time (the store's demo clock), not the real date. Otherwise every event in the seed reads as long past.

### 5. Screens & routes
- **Staff:** `EventDetail.jsx` keeps its tabs and adds **Send invitations**.
  - The **Invitation** tab mounts `InviteStudio` (new, `src/components/invite/InviteStudio.jsx`). With no template it shows `TemplateGallery`; otherwise `InviteEditor`.
  - The header shows the review state badge ("Waiting for review" / "Unpublished changes"). Publish uses `ActionButton` with a new `publish_invitation` action in `src/lib/roles.js` (`ACTIONS` / `ROLE_ACTIONS` for ceo and pm). It opens a **review panel** with the change list and the date-shift warning, then Publish or Send back with a note.
  - Add a "Revoke client link" button.
- **TemplateGallery** (`src/components/invite/TemplateGallery.jsx`): family filter pills (`FilterPill`), cards with a cover rendered live in `sample` mode (no screenshots needed), **Live preview** (full-screen `Modal size="2xl"` with a phone/desktop toggle) and **Use this template**.
- **InviteEditor** (`src/components/invite/InviteEditor.jsx`): on the left, the template's section list with toggles and an expandable form per section (`src/components/invite/forms/*.jsx`), plus accent and Change template. On the right, the live preview (phone/desktop). It reuses `QuestionEditor` and the RSVP settings moved out of `InvitationBuilder.jsx:159-176`, staff only.
- **Client link** `/invite/:eventId/edit?key=` (`InviteEditPage.jsx`): the same `InviteStudio` in `clientMode`.
  - Tabs: **Design** | **Send invitations** (shown once published).
  - A footer bar with **Submit for review** and the state ("Oscenia is reviewing", or "Sent back: <note>").
  - Client mode hides only the RSVP form settings and custom questions. Details, sessions and media are editable (D8).
- **Send invitations** (`src/components/invite/SendInvitations.jsx`), shared by staff and client:
  - *Platform* (staff only): a message editor with placeholder chips `{name} {link} {event} {date} {venue}` (`fillTemplate` in `lib/events.js`, `personalLink`), email subject, audience, Send now / schedule, a per-guest preview, and a recipients table with status + Retry failed + history.
  - *Client self-send*: a guest table with the personal link, a **WhatsApp** button (`https://wa.me/<normPhone>?text=<encoded fillTemplate>`), Copy and Copy all, "Sent by client" marks and a coverage count.
- **Guest page** `InvitePage.jsx`: renders `InviteRenderer` from `published`.
  - The cover gate greets the guest by name when `?g=` is present, and Open starts the music.
  - The RSVP, confirmation, QR and Change-my-reply logic moves into `sections/Rsvp.jsx` and `sections/Access.jsx` unchanged.
  - Wishes: the form plus a list of visible or approved wishes.
- **Notifications:** add an "Invitation waiting for review" item to `notificationsFor()` (`src/lib/notifications.js`), derived from `review.state==='submitted'`, for roles that can publish.
- **Events list** (`Events.jsx`): the card header uses the template palette and cover title, with a badge for the review state.

### Files
- **New:**
  - `src/lib/templates.js`, `src/lib/invites.js` (content defaults, validation, diff), `src/lib/mediaStore.js`, `src/lib/music.js`
  - `src/components/invite/` (`InviteStudio`, `TemplateGallery`, `InviteEditor`, `InviteRenderer`, `SendInvitations`, `ReviewPanel`, `ornaments`, `sections/*`, `forms/*`)
- **Modified:**
  - `src/store/useProto.js`, `src/store/protoSeed.js`, `src/pages/events/EventDetail.jsx`, `src/pages/events/Events.jsx`, `src/pages/public/InvitePage.jsx`, `src/pages/public/InviteEditPage.jsx`, `src/pages/public/WalkInPage.jsx`
  - `src/lib/roles.js`, `src/lib/notifications.js`, `src/i18n/dict.js`, `index.html`
  - `scripts/verify-proto.mjs`, `scripts/smoke.jsx`, `docs/Prototype-Demo-Guide.md`
- **Removed:** `src/components/events/InvitationBuilder.jsx`, `src/components/events/InvitationView.jsx`

## Build phases (each one testable, with a commit and a check-in after each)
1. **Foundation:** registry, data model, 6 skins and all sections (read-only), `InviteRenderer`, seed migration and the guest page on the new renderer. *Test:* `/invite/EV-01` and `/invite/EV-02` render in their templates, RSVP/QR/Change-reply still work, verify-proto is updated and passes.
2. **Gallery + editor (staff):** gallery, live preview, choose/change template, section toggles and forms, photo uploads, video/music uploads (IndexedDB) or links, accent. *Test:* a new event → gallery → template → fill in → preview matches. Switching template keeps content. An uploaded video survives a template switch, a reload and a second tab; after clearing site data it shows the placeholder.
3. **Client link + review/publish:** `clientMode` studio, Submit for review, review panel with the diff and date-shift warning, publish/send back, `publish_invitation` permission, notification, revoke link. *Test:* client edits the live Gala and guests still see the old version; staff approve and guests see the new one; a date change shows the reminder shift and updates the event on publish; finance/warehouse can't publish.
4. **Guest experience:** cover gate with the name, music, countdown + `.ics`, gallery lightbox, wishes with hold/hide/approve, gift copy buttons. *Test:* the `?g=` link shows the name; hold on means the wish stays hidden until approved; the `.ics` opens in a calendar.
5. **Broadcasting:** platform send (message, placeholders, audience, schedule, statuses, retry, log) and client self-send (WhatsApp links, copy, sent-by-client). *Test:* the Draft event refuses to send; "not invited yet" excludes already-invited guests; a guest with no email fails on email only and can be retried; the `wa.me` text has the guest's own link.
6. **Polish & ship:** Indonesian strings in `dict.js`, mobile check, demo guide section 5 rewritten, rebuild into `oscenia-web/public/erp`. Deploy only when asked (`npx vercel --prod --yes` from `oscenia-web/`).

## Out of scope (explicitly)
- Per-session RSVP ("which session will you attend?").
- Livestream, light/dark mode, the ID/EN switch on the guest page.
- Section reordering.
- A public gallery.
- Real sending, and real cross-device media.

## Risks
- **SSR smoke test:** `verify:render` uses `renderToString`. `InviteRenderer`, `mediaStore`, `music.js` and the countdown must touch `window`, `indexedDB`, `AudioContext` and timers only inside effects or event handlers, never during render.
- **localStorage budget:** photos across 6 sections can fill the budget. Mitigations: a store budget with a clear message, shrinking on upload, and the existing quota toast (`useProto.js:43-60`).
- **Browser-only video/music:** an upload is missing on another device. Mitigations: a label ("saved in this browser only"), a clear placeholder, and the link option for demos on phones.
- **Saved demo data is wiped** for anyone with a local copy (the version bump resets to seed). This is the same as earlier rounds.
- **Visual design effort for 6 templates** is the largest cost. The shared-section approach keeps it to skins and ornaments.
- **Simulated sending:** real WhatsApp needs a WhatsApp Business API provider on the backend, and real email needs an email service. Flagged in the UI as today.

## Verification
- `npm run verify:proto` with new checks:
  - Template registry integrity (every section id has a component; every template's sections exist).
  - Seed events map onto templates.
  - The `publishInvite` draft→published copy, plus details → event fields.
  - A client draft is not visible to guests.
  - `inviteChanges` detects a date change and the reminder shifts.
  - Wish hold/hide.
  - `sendBroadcast` audience filtering, failure on a missing email or phone, refusal on a Draft event, and `retryFailed`.
  - The `wa.me` text contains the personal link.
  - The photo budget is enforced.
- `npm run verify:render`: add routes `/events/EV-03?tab=invitation` (gallery state), `/invite/EV-01/edit?key=aurora-7f2k` (editor), `/events/EV-01?tab=send`, and `/invite/EV-01?g=<seed token>`.
- `npm run verify:mobile`: the gallery, editor and guest page at phone width.
- Manual walk-through in `npm run dev` (port 5273), across two tabs (staff ERP + client link):
  - Create an event, send the client link, client picks Royal, uploads photos and a video, submits.
  - Staff review and publish, import the CSV, send by WhatsApp + email, check the statuses.
  - The client self-sends to one guest.
  - The guest opens the personal link, RSVPs, leaves a wish and gets the QR.
  - The check-in desk scans the QR.

## Build log (decisions made while building)
- **Worktree:** built on branch `feature/invitations-v2` in `E:\Master - slave\RR projects\Oscenia-invitations-v2` (its `erp-prototype/node_modules` is a junction to the main checkout's). Another session works on chat in the main folder — keep them apart.
- **Phase 1 (`2f7b8ea`):**
  - Sections live in one file, `components/invite/sections.jsx`, rather than one file per section.
  - The QR access card is part of the RSVP section; there is no separate `access` section.
  - The guest page renders `event.published`.
- **Phase 2 (`ddcf228`):**
  - **All uploads (photos too) go to IndexedDB** (`lib/mediaStore.js`), and content keeps `{key,name,size,type}`. Reason: publishing copies the invite, and inline photos would be stored twice in localStorage.
  - `cleanSection` caps text and lists; links are checked at render time.
  - Seed **EV-03** is a draft wedding with no template (client link key `wibowo-5h2m`).
  - Publish (interim, until phase 3) copies the current draft and its date, time and venue onto the event.
  - `scripts/invite-e2e.mjs` is a browser walk-through; it needs `npx vite --port 5291`.
- **Phase 3 (`5592048`):**
  - Status changes only through `submitForReview`, `returnToClient`, `publishInvite` (`clampDeadline`), `unpublish` and `regenerateEditToken`. `updateEvent` can no longer publish.
  - `inviteChanges` / `hasUnpublishedChanges` (lib/invites.js) feed the staff `ReviewPanel`.
  - The new `publish_invitation` action goes to the CEO and PM (sales can see events but not publish).
  - The bell shows "Invitation to review", pinned to the top.
  - The client page has a review bar.
  - An unpublished invitation can always be republished.
- **Phase 4 (`5d30c49`):**
  - The guest page's interactive pieces live in `components/invite/guest.jsx`: `useMusic` / `MusicButton`, `OpenButton`, `AddToCalendar`, `Lightbox`, `CopyButton` and `WishForm`.
  - **Cover gate:** the guest page draws the full invitation underneath, made `inert`, and lays a full-screen cover on top (`slots.open`). The server render therefore still covers the RSVP, QR and wishes. Open fades the cover out, starts the music inside the tap, and unlocks scrolling.
  - **Lightbox, copy and calendar are built into `InviteRenderer`.** The editor preview works like the live page; `slots` can override them.
  - **Music (`lib/music.js`):** `trackPlan` is pure data, checked by verify-proto. The synth (AudioContext with a look-ahead scheduler and a soft echo) and the `<audio>` player for uploads are created only in `play()`.
    - An uploaded song is looked up ahead of the tap, because Safari loses the gesture across an `await`.
    - A song this browser doesn't have means no music, not a stand-in track.
    - Music pauses when the tab is hidden.
    - The editor's music form has a Listen button.
  - The seed Gala opens to "Warm strings".
  - **`.ics` (`icsFile` in lib/invites.js):**
    - Times are taken as Jakarta time (TZID Asia/Jakarta with a VTIMEZONE block); the backend will store each event's zone.
    - Each entry lasts 3 hours (the model has no end time). A session with a date gets its own entry, and one with no time is all-day.
    - Lines are folded at 75 octets, and text is escaped.
    - The description and URL carry the guest's personal link, built from the event id, never the current page (the editor preview sits at an ERP URL).
  - **Wishes are live, not draft:**
    - `addWish`, `setHoldWishes`, `setWishHidden` and `approveWish` apply at once.
    - Only a published invitation whose published copy shows the wishes section takes a wish. A personal-link guest signs with their listed name.
    - Limits are in `WISH_LIMITS`: up to 3 wishes per guest (by name, any case, for guests not on the list), never the same words twice, 500 characters, 500 per event.
    - A wish left while the hold is off is approved as it arrives, so switching the hold on later doesn't take it down. Switching it off shows the waiting ones.
    - `visibleWishes` and `wishState` moved to lib/invites.js. Staff and the client moderate in the Wishes section form (D13).
  - Gift copy strips spaces and dashes from account numbers. The address has its own copy button.
  - `lib/exports.js` now exports `download`.
- **Phase 5 (`62aa17f`):**
  - Pure helpers live in a new `lib/broadcasts.js` (not `lib/events.js`, which `lib/crm.js` imports — importing `isEmail` back would make a cycle): `broadcastAudience`, `deliveryOf`, `recipientRows`, `statusCounts`, `inviteMessage`, `waLink` and `broadcastProblem`.
  - **One rule book:** `broadcastProblem` gives the reason a batch cannot go, in words. The screen shows it under the Send button, and the store refuses on the same rules. Refused: an event that is not Published, an event that is over, a message that is empty, over 1000 characters, or **without `{link}`**, email with no subject (or one over 150 characters), an unknown channel or audience, a group with nobody in it (send now only), and a schedule time that is malformed, not later than the demo clock, or after the event date.
  - **Audience = the client's list only** (`onMasterList`, not walk-ins). A guest who replied from a forwarded link already has the invitation. "Not invited yet" = listed guests with no `invitedAt`.
  - **Simulated outcome** (`deliveryOf`): no phone → WhatsApp failed "No phone number"; no email → "No email address"; a malformed one → "Email address is not valid"; otherwise an FNV hash of `token:channel` gives read (40%), delivered (50%) or sent (10%, phone off). `queued` exists in the status list but a simulated batch never stays in it.
  - **Invited** means at least one channel got through. A guest whose every message failed stays "not invited yet", so the next "not invited yet" batch picks them up. `invitedAt`/`invitedVia` record the latest send (`'platform'`, or `'client'` from `markSentByClient`).
  - Batch shape: `{ id:'BC-n', mode:'platform', channel, subject, message, audience, scheduledAt, createdAt, by, status:'scheduled'|'sent'|'cancelled', sentAt, recipients }`. The message is stored as the template, not filled in; recipients are built when the batch goes, so a scheduled batch reaches its audience as it is at "Send now". A send writes one `sendLog` line (label "Invitation", count = guests); a retry writes "Invitation (retry)".
  - Scheduled batches: `sendScheduledNow` and `cancelBroadcast`, with "Prototype: the demo stays on one day, so press Send now. With the backend, it sends automatically at this time."
  - **`setGuestEmail`** (new, small): a failed email row in the recipients table has an inline "Add email" box, so the retry flow can be shown without a re-import. `retryFailed` re-runs `deliveryOf` on the failed rows with the guest's current details.
  - The platform send is not role-gated (like Send now on reminders); publishing still is.
  - **Client self-send:** a WhatsApp button per guest (`wa.me/<normPhone>?text=` with the guest's own link), Copy message, Copy all links (`Name: link` per line) and a tick to mark one sent another way. Opening WhatsApp marks the guest "Sent by you" (the client can't confirm they pressed send). No un-marking. The client's message is local to the page (not saved).
  - Staff see the same guest table (link copy only, "Sent by client" / "Sent by Oscenia" marks). The client sees only the self-send part; the ERP tab adds the platform composer, a per-guest preview (WhatsApp bubble + email) and the batch history.
  - Client page: tabs Design | Send invitations once published; `&tab=send` opens it, and the review bar shows on Design only.
  - **Seed:** one Gala batch BC-1 (20 Jul, both channels, all 30 listed), matching send-log entry SL-1. Gala guest G-030 now has no email, so the seed shows one failed email row. Guests carry `invitedAt`/`invitedVia` (null by default). `VERSION` stays 6: v6 never shipped, and older v6 saves still fit (missing fields read as not invited).
  - `{date}` in invitation messages is written out ("Friday, 14 August 2026") by `inviteMessage`; `fillTemplate` (reminders) is unchanged.
  - invite-e2e: the phase-4 "Copied" check now waits for the button instead of racing the async clipboard write; wa.me is answered locally by a route.
- **Phase 6:**
  - **Indonesian:** 228 new `dict.js` entries for the ERP-side invitation screens: gallery, template families and taglines, editor, section names and forms, music tracks, wish moderation, review panel, client link page, Send invitations (both modes), the `broadcastProblem` and failure reasons, and the bell's "Invitation to review". They sit in their own block after "Back to events", not at the end of the file, because the chat branch appends there (fewer merge conflicts).
    - Strings that were not going through `t()` yet were wrapped: the client link page (`InviteEditPage`, header, invalid-link page, review bar), the template-changed toast, the review panel's toasts and the couple form's person headings.
    - Not translated, on purpose: the guest page (English only, per plan), template names (Gala, Royal…), example placeholders in inputs, the default invitation message (it goes to guests), the notification body (no body is translated) and the review panel's change list (built as sentences in `inviteChanges`). Messages built with numbers (`checkMedia`, "too long" limits) stay English.
    - Left as found: the existing key `Delivered` → "Terkirim" is the same word as `Sent`, so the two delivery pills read alike in Indonesian. It is shared with other screens, so it was not changed here.
  - **Mobile:** `mobile-check` now also covers the gallery (staff and client), its live preview, the guest cover gate with a name, the opened guest page (full-page shot), the staff Send invitations tab and the client's Send invitations tab.
    - **Fixed:** the client's guest table scrolled sideways on a phone, which put the WhatsApp button off-screen. Under `sm` it now fits: Category and the link column are hidden, cells are tighter, the WhatsApp button shows its icon only (same accessible name), and the sent time wraps under the status. Staff get a copy-link icon there instead of the hidden link column.
    - **Fixed in the checks:** `mobile-check` and `popover-check` used `--strictPort`, but they did not notice when the port was already taken. They then silently tested whatever was on that port (here, the other checkout's build). They also left Vite running on Windows. The new `scripts/preview-server.mjs` refuses to go on if its own server did not start, kills the whole process tree when it is done, and takes `PREVIEW_PORT` to move the port when two checkouts run their checks at once.
  - **Demo guide §5** rewritten for v2 (create → client link → gallery → template → fill & upload → RSVP settings → submit → review/publish or send back → send invitations from Oscenia and by the client → guest's personal link → wish moderation → check-in), with a prototype-limits box. §5.4–5.7 are kept and keep their numbers, so links from §0 and the checklist still work; the checklist rows for §4.1/§4.2 and the "RSVP form" mentions were updated.
  - **`/erp` not rebuilt on this branch** (coordinator's call): this branch will be merged into `feature/pm-events-prototype`, which already has a newer `/erp` build. Rebuilding here would ship an older ERP and conflict on the built assets.
- **Round 3: Template Studio (`adf5e88`, fixes `e05a177`, on `feature/pm-events-prototype`):** client round 3 asked for the design team's own designs in the gallery.
  - **Registry:** `registerTemplates(list)` in `lib/templates.js` keeps the studio templates (from `useProto` `customTemplates`) in a module-level list, re-registered on every store change and rehydrate. `templateById`, `themeOf`, `sectionOn` and `allTemplates()` read built-ins first, then valid custom ones; the six built-ins stay frozen. `validateTemplate` is the one rule book for the store and the registry.
  - **chooseTemplate gating:** a studio template can be chosen only while it is in the gallery (published), except re-choosing the one an event already has.
  - **Archive, not delete:** an archived template leaves the gallery but keeps rendering invitations already on it. Only Restore moves it back (to draft); archived → published is refused, and an archived template cannot be edited.
  - **Unknown id → first built-in:** an invitation whose template this browser doesn't know (e.g. a studio template made in another browser) draws as Gala rather than an empty page.
  - **Browser-only:** templates live in localStorage and artwork in IndexedDB, like all demo data; labelled in the studio. No snapshot of the template at publish (backend job).
- **Next:**
  - Merge `feature/invitations-v2` into `feature/pm-events-prototype`. Expect conflicts in `dict.js` (both add keys) and `docs/Prototype-Demo-Guide.md` (both edit it).
  - Rebuild `/erp` there (`vite build` in `erp-prototype/`, output copied to `oscenia-web/public/erp`, as in "Publish the round-2 prototype build to /erp"). Re-run the checks.
  - Deploy only on request: `npx vercel --prod --yes` from `oscenia-web/`.
