# Client feedback round 3: plan

> **Historical record.** Written before the 17 Oct 2026 restructure. Paths and deploy steps below are as they were (`erp-prototype/` is now `erp-frontend/`, `oscenia-web/` is now `website/`, and Vercel is no longer used). Current state: [GO-LIVE-STATUS](./GO-LIVE-STATUS.md).


## Context
The client sent four requests after the invitations v2 deploy (saved verbatim in `docs/Client-Feedback-Round-3.md`). Exploring the code showed that **items 1–3 are already built but hidden or confusing**, and **item 4 is new**:
1. **Google Calendar.** It exists, but you only reach it through CRM → *Relationship calendar* tab → switch to *Month* → the card on the right. The client can't find it.
2. **Chat replies.** Quoted replies at the bottom of the stream already work. But the toolbar has two buttons, and the familiar reply-arrow icon is **"Reply in thread"**, which hides the reply in a side panel. That is what the client hit.
3. **PO pipeline.** A board with exactly the five requested stages exists (`lib/vendors.js` `PIPELINE`/`pipelineStage`). It is only on the Purchase Orders page, though. The "Pipeline" toggle on the Vendors screen shows a *different* board, the vendor lifecycle.
4. **Own invitation designs.** Templates are six hard-coded skins. The design team has no way to add their own. The client picked the **Template Studio** approach.

Goal: fix all four so the client finds them where they looked, then update the guide, rebuild `/erp`, push and deploy.

Work happens on `feature/pm-events-prototype` in the main folder (its tree is clean). There are four units, built in order, each with checks and its own commit. Each unit is built by a fresh-context agent in sequence, because they share `useProto.js`, `dict.js`, `Sidebar.jsx` and `roles.js`.

---

## Unit 1: PO pipeline tab inside Vendor Management (item 3)
- Move `PipelineBoard`, `PoCard`, `advance()`/`actionFor` and the settle dialog out of `src/pages/PurchaseOrders.jsx` (lines ~299–455) into a shared `src/components/PoPipeline.jsx`. The Purchase Orders page then uses it unchanged.
- In `src/pages/Vendors.jsx`, the view switch (lines ~152–155, 368–380) becomes three options: **Vendors** (table) · **Vendor lifecycle** (renamed from "Pipeline", `?view=pipeline` kept) · **PO pipeline** (`?view=po`, the new board).
- Each PO card gets a small **five-step progress strip** (PO Issued → DP Paid → In Progress → Delivered → Fully Paid), so you can read each order's progression at a glance. A no-DP order shows DP as skipped.
- Purchase Orders' own Table/Pipeline toggle also gets a URL parameter (`?view=pipeline`) so it can be linked.
- The PO pipeline option shows only if `canSee(role, 'purchaseorders')`. Every role that sees Vendors (ceo, finance, pm) has it today, but the gate keeps it right if that changes.
- Stages come from the existing `pipelineStage(po, delivery)`; there is no new data.

## Unit 2: Google Calendar section under CRM & Clients (item 1)
- A new sidebar sub-item under CRM & Clients: **Google Calendar**, at `/google-calendar`. A separate path is needed because `/crm/calendar` would collide with `crm/:id`.
  - Add a `gcal` key to `ROLE_MODULES` in `src/lib/roles.js` for the same roles as `crm` (ceo, finance, sales).
  - Add a route in `src/App.jsx` and a NAV entry in `src/components/Sidebar.jsx`.
- New page `src/pages/GoogleCalendar.jsx`:
  - Shows the connect / disconnect card plus a month calendar that combines Google events (blue) with CRM dates and events.
  - Reuses `MonthView` and `GoogleCard`, exported from `src/components/crm/CalendarView.jsx` (lines ~52–70, 142–194).
  - Reuses the existing store actions `connectGoogle`, `disconnectGoogle`, `setGoogleOption` and `seedGoogleEvents`.
  - Stays clearly labelled as a simulated sync.
- The Relationship calendar tab keeps its card and gains a link to the new page.

## Unit 3: one Reply that posts in the main chat with a quote (item 2)
- In `src/pages/Chat.jsx`, the hover toolbar (lines ~579–580) has a **single Reply**: the reply-arrow icon, calling the existing quote path. Clicking it focuses the composer (`Composer.jsx` gets a focus effect on `quote?.id`).
  - The reply posts at the bottom of the main stream with the quote block above the text. That is the existing `postMessage(..., quoteId)` path at `useProto.js:437`.
- **Threads are removed.** Delete `threadOf` / `ThreadPanel` / the "N replies" link, and set `topLevel = inChannel`.
  - Any saved message with a `parentId` is shown in the stream as a quote of its parent (`quoted = m.quoteId || m.parentId`).
  - "Create task from message" (`Chat.jsx:320`) posts its note as a quoted message in the stream.
  - The seed thread reply (`protoSeed.js:284–287`) becomes a quoted reply.
- The quote block shows up to 2 lines (`line-clamp-2`, longer `snippet`) and still jumps to the original on click.
- The store keeps accepting `parentId`, so old data stays valid, but the UI no longer creates it.
- **No `VERSION` bump.** A bump would wipe every viewer's saved demo, including invitations the client has built.
  - Saved copies with the old thread reply already render it as a quote, through the `m.quoteId || m.parentId` fallback.
  - Only new visitors get the changed seed.

## Unit 4: Template Studio for the design team (item 4)
**Data and lookup**
- `src/lib/templates.js` gets a resolver for custom templates:
  - `registerTemplates(list)` holds the custom templates in a module-level variable.
  - `allTemplates()` returns the built-ins followed by the custom ones.
  - `templateById`, `themeOf` and `sectionOn` search both.
  - `validateTemplate(t)` checks: cover first, required sections present, sections suited to the family, hex colours, font keys from `FONTS` (exported), and `cover`/`ornament` from the allowed values.
  - `lib/invites.js` and the Node scripts stay pure.
- The store (`useProto.js`) gets `customTemplates: []`.
  - Actions: `createTemplate({ from })` (blank, or duplicate a built-in via `structuredClone`), `updateTemplate`, `setTemplateArt`, `publishTemplate` / `unpublishTemplate` (the gallery shows published ones only), and `archiveTemplate`.
  - There is no hard delete while an event uses the template: archived templates disappear from the gallery but keep rendering existing invitations.
  - Each action checks `canDo(role, 'manage_templates')`.
  - `registerTemplates` runs at store creation and on every change or rehydrate, through `subscribe`.
- A new action `manage_templates` in `src/lib/roles.js`, granted to the CEO and PMs.

**Artwork** (uploaded to IndexedDB via `lib/mediaStore.js`; JPG/PNG/WebP only, no SVG)
- A template's `art` holds four optional media references:
  - `coverBg`: used when the client hasn't uploaded a cover photo.
  - `pageBg`: a texture on the whole invitation, set on the `InviteRenderer` root.
  - `frame`: a transparent PNG overlay on the cover.
  - `ornament`: an image under section titles, replacing the SVG ornament.
- Rendering uses `useMediaUrl` (`components/invite/media.jsx`) in small wrapper components. If a file is missing, the page falls back to the CSS colours and SVG ornaments, so another browser still renders.

**Screens**
- Route `/events/templates` in `src/App.jsx`. React Router ranks it above `events/:id` whatever the order.
- A sidebar sub-item under Events & Invitations: **Invitation templates** (`ROLE_MODULES` key for ceo and pm).
- Because the sidebar group starts folded, the Events page header also gets a **Templates** button.
- Routes are not role-guarded anywhere in the app; only the sidebar hides items. So the page itself shows a "not permitted" panel without `manage_templates`, and the store refuses too.
- New `src/components/invite/TemplateStudio.jsx` (page `src/pages/events/TemplateStudio.jsx`):
  - **List:** the design team's templates, with Draft / In gallery / Archived badges and "used by N events". The six built-ins each have **Duplicate**.
  - **Editor**, settings on the left:
    - name, family and tagline
    - four colours
    - heading, body and script fonts (dropdowns of the loaded Google Fonts)
    - cover layout (4) and ornament (5)
    - artwork uploads, reusing `UploadButton` from `SectionForms.jsx`
    - section order (up/down) and default on/off
  - **Live preview** on the right: `InviteRenderer` in sample mode inside `PreviewFrame`/`DeviceToggle` from `components/invite/preview.jsx`.
  - Save validates with `validateTemplate`; **Add to gallery** publishes.
- `TemplateGallery.jsx` lists `allTemplates()` that are built-in or published, and gives custom ones a **"Design team"** badge. It also fixes the preview-modal title lookup, which currently uses `TEMPLATES.find`.
- **Editing a template that live invitations use** shows a warning, e.g. "Used by 2 published invitations — changes show to their guests straight away". Templates aren't snapshotted at publish; that's a backend job.
- Limits, labelled in the UI:
  - **Templates and artwork are saved in this browser only (prototype).** The designer, staff and client must use the same browser to see a studio template, as with all demo data today.
  - New layouts or sections still need a developer.
- `customTemplates` is a new key with an empty default. The persist `merge` (`useProto.js:1663`) keeps that default for older saves, so there's no version bump.

---

## Then: guide, build, ship
- `docs/Prototype-Demo-Guide.md`:
  - a new **"What's new (round 3)"** table: one row per item with *How to check*
  - §4.4 updated (no threads), plus §6.3, §6b/6c and §5.1 (Template Studio)
  - status notes in `docs/Client-Feedback-Round-3.md`
- `dict.js`: Indonesian for the new strings.
- Rebuild into `oscenia-web/public/erp`, using the copy steps from `docs/ERP-Feedback-Analysis-and-Fix-Plan.md:304`. Then commit, push `feature/pm-events-prototype`, and deploy with `npx vercel --prod --yes` from `oscenia-web/`. Confirm the live bundle hash.

## Verification (each unit, then once at the end)
- `npm run verify` (ledger, flows, adapters, proto). New proto checks:
  - **PO pipeline:** the stage for each status.
  - **Chat:** no seeded `parentId`; the former thread reply has a `quoteId`; Reply posts top-level.
  - **Templates:** `validateTemplate` rejects bad input; custom templates resolve through `templateById` / `themeOf`; an archived one still renders; non-managers are refused; built-ins stay frozen and are still 6.
  - **Roles:** finance and sales can't manage templates.
- `npm run verify:render`, with new routes `/vendors?view=po`, `/google-calendar`, `/events/templates` and `/purchase-orders?view=pipeline`.
- `npx vite build`, and `PREVIEW_PORT=<free> npm run verify:mobile`.
- Browser walk-through: extend `scripts/invite-e2e.mjs` for Template Studio. A new studio template appears in the gallery with its badge; uploaded artwork shows; an event using it publishes and its guest page renders.
  - Quick Playwright checks for Vendors → PO pipeline, the Google Calendar page (connect → blue events), and chat Reply landing at the bottom with a quote and no thread panel.
  - Look at the screenshots.
- After deploy: `curl` `https://oscenia-web.vercel.app/erp/` and check the bundle hash matches.
