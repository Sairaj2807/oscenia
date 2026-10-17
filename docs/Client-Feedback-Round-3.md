# Client feedback — round 3 (4 Oct 2026)

Received on WhatsApp after the invitations v2 deploy (https://oscenia-web.vercel.app/erp). Verbatim:

1. **Google Calendar under CRM & Clients** — "Please also add a Google Calendar section under CRM & Clients."
2. **Chat replies** — "Modify the reply mechanism in the Team Chat interface. Ensure that when a user replies to a message, the reply appears directly as a new message at the bottom of the main chat stream, displaying a quote block of the original message right above the reply text."
3. **PO pipeline in Vendor Management** — "Add a tab or visual Pipeline interface (Kanban board or Timeline-based) within the Vendor Management screen. This feature must visualize the progression of each purchase order document through distinct status stages. The recommended pipeline column stages include: PO Issued, DP Paid, In Progress, Delivered/Completed, and Fully Paid."
4. **Own invitation designs** — "Can we add a UI and our own designs to the invitation template? so our design team can add their design for invitation." (Screenshot: the Change template gallery on EV-03 showing the six built-in templates.)

## Notes
- Items 1–3 overlap round-1 work (C2 Google Calendar in the CRM calendar, CH1 quoted replies, V1 PO pipeline board). Check what exists and why the client does not see it, before rebuilding.
- Item 4 is new: a way for Oscenia's design team to add templates of their own design to the gallery.
- Plan: `docs/Client-Feedback-Round-3-Plan.md`. Status below.

## Status (5 Oct 2026)
All four items are built on `feature/pm-events-prototype`. How to check each one: `docs/Prototype-Demo-Guide.md` section 000.

| # | Item | What was done | Commit |
|---|---|---|---|
| 1 | Google Calendar under CRM & Clients | It already existed, but only inside CRM → Relationship calendar → Month. It now has its own page, `/google-calendar`: a sidebar item under CRM & Clients (same roles as the CRM), a button on the CRM header, and a link from the Relationship calendar tab. Same month view and connect card, one connection. | `e5c25a3` |
| 2 | Chat replies | Quoted replies already worked, but the reply-arrow icon was "Reply in thread". The toolbar now has a single **Reply** that quotes the message and focuses the box; the reply lands at the bottom with the quote above it. Threads are removed from the UI; older saved thread replies show as quotes, and the seeded thread reply is now a quoted reply. No storage version bump, so saved demos are kept. | `c7333c5` |
| 3 | PO pipeline in Vendor Management | The five-stage board existed only on Purchase Orders. It is now a shared component and a **PO pipeline** tab in Vendors (`/vendors?view=po`), next to the table and the vendor board, renamed **Vendor lifecycle**. Each card has a five-step progress strip (DP shown as skipped when an order has none). | `da19375` |
| 4 | Own invitation designs | **Template Studio** at `/events/templates` (sidebar: Events & Invitations → Invitation templates; **Templates** button on Events), for the CEO and PMs (`manage_templates`). Duplicate a built-in or start blank; colours, fonts, cover layout, ornament, artwork (cover, frame, ornament, page texture), section order and defaults; live preview. **Add to gallery** shows it in the Change template gallery with a "Design team" badge. Archive instead of delete. | `adf5e88`, review fixes `e05a177` |

**Known limits (prototype)**
- Studio templates and their artwork are saved in the browser they were made in. The designer, staff and the client must use the same browser to see one; elsewhere an invitation on a studio template draws as the first built-in (Gala).
- Templates are not snapshotted at publish: editing a template that published invitations use changes them for their guests at once (the editor warns). Snapshots are a backend job.
- A new cover layout or a new kind of section still needs a developer.
- Google Calendar is still a simulated sync.
- In the Template Studio, unsaved edits are guarded on tab close/reload and on "All templates", but not on in-app links (the app's BrowserRouter does not support `useBlocker`).
