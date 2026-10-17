# Oscenia ERP — Presenter Script

**Goal of this demo:** prove the pitch — *"a status change in one module automatically triggers the next."* Everything hangs off one **Project ID**. Aim for ~7 minutes. Let the automations do the talking.

**Before you start:** open `http://localhost:5273/`, role = **CEO** (top-right), full-screen the browser. If you've clicked around, **refresh once** to reset the data (every live automation fires once per session by design).

**Bilingual:** the top-bar **EN / ID** toggle switches the entire UI between English and Bahasa Indonesia (nav, headings, buttons, table headers, statuses). For an Indonesian audience, flip to **ID** before you begin. Seeded content (names, notes, drafts) stays as authored.

---

## The 4 live automations (the spine of the demo)
| # | Trigger | Where | What fires |
|---|---------|-------|-----------|
| 1 | Confirm Down Payment | Finance | Project auto-created → pipeline started → ledger updated |
| 2 | Advance to Post-Event Feedback | Projects board | Client survey sent → rating recorded → crew bonuses recalculated |
| 3 | Log unplanned cost | Budgeting | Category over ceiling → red-flag alarm to CEO + PM |
| 4 | Run daily jobs | Automated Cron | Birthday scan → reminder drafts queued for Sales |

---

### 0 · Frame (15 sec)
> "This isn't a record-keeping app — it's a central engine. One project moves through seven stages, and each status change fires the next department automatically. Watch."

### 1 · The company at a glance — **Dashboard** (30 sec)
- Four KPIs: **Pipeline value, avg margin (~30%), receivables, active projects.**
- "Every number here traces back to a Project ID. Nothing is typed in twice."

### 1.5 · Where deals begin — **Quotations & MoU** (45 sec)
- Open **Quotations & MoU**. Show the pipeline of quotes (Draft → Sent → Accepted).
- On the **Nimbus Retail** quote (Sent), click **Mark accepted** → toast *"MoU generated → Deal sent to Finance."* Click **PDF/MoU** to download the branded contract.
- "Sales closes the quote; the system writes the MoU and hands Finance a ready deal — no re-keying." (This makes the deal that Finance confirms next.)
- *You can also click **New Quotation** to build one live: client, line items → contract value + margin computed.*

### 2 · Pull the trigger — **Finance** (45 sec) ⭐ AUTOMATION #1
- The pending deal in Finance is the quote you just accepted (or the seeded *Aurora Bank Investor Summit*).
- Say: *"The client just paid their deposit. I confirm it once, here."* → click **Confirm Down Payment.**
- **Pause. Let the three toasts land** (each stamped *auto*): project `EVT-2026-GALA-02` created → milestone pipeline started → ledger updated.
- Bonus: click **PDF** on any invoice row → a branded Oscenia invoice downloads. "Real documents, Project-ID tagged."

### 3 · Prove it's real — **Projects** (60 sec) ⭐ AUTOMATION #2
- The new card sits on the Kanban at **DP Paid**, highlighted gold. "No one moved it here — the payment did."
- Toggle to the **Timeline** tab (top-right) → a **Gantt** of every project against its event date; filter **by division** (Sales/Design/Warehouse/Field). "Same data, planned across the calendar."
- Back on **Board**, on **Aurora Bank Annual Gala** (in *Execution Event*), click **advance** → it lands in **Post-Event Feedback**, firing: survey sent → **rated 9.4/10** → crew incentives recalculated.

### 4 · Follow the money — **Accounting**, **P&L**, **Payroll** (60 sec)
- **Finance → Accounting**: three tabs — **Journal** (double-entry, Debit = Credit), auto **Income Statement**, and a **Balance Sheet that ties out**. "Statements generate themselves from the transactions."
- **Finance → Project P&L**: pick a project → per-event profit + cost pie. "Real-time micro P&L, separate from office overhead."
- **Crew & Incentives**: the gold banner shows the recalculated **incentive pool** from that 9.4 rating. "Pay follows performance, automatically."

### 5 · Model the future — **Profit Simulator** (45 sec)
- **Finance → Profit Simulator**: drag the sliders (contract value, vendor %, crew %) → the **margin gauge**, net profit and break-even recompute live; colour flips green/gold/red vs. the 30% target.
- "Before we ever sign, we can see whether an event makes money."

### 6 · Control the spend — **Budgeting** (30 sec) ⭐ AUTOMATION #3
- **Finance → Budgeting**: ceilings vs. realized per category.
- Click **Log unplanned cost** → Vendors blows past its ceiling → a **red ⚠ alarm** fires: "CEO + PM notified." "Overspend can't hide."

### 7 · Never miss a client — **CRM**, **Cron**, **Client 360** (75 sec)
- **CRM**: LTV (computed from actual spend), preferences, satisfaction. Click **any row** (e.g. **Aurora Bank**) → **Client 360**:
  - **Personal / Company Profile** — name, contact, email, phone, birthday, **company anniversary**, **personal brand**.
  - **Interaction History** timeline, **vendors used across events**, preferred types, and **project history with per-event satisfaction** (live projects + past events; LTV = the sum of them). "Sales walks into any pitch knowing the client's whole history."
- **CRM → Automated Cron**: click **Run daily jobs now** → the **7-day scan** finds upcoming milestones and queues drafts. Click **Preview draft** on a reminder → the actual **WhatsApp & Email** message opens (client/event merged in), editable, with **Send**. "It notifies Sales 7 days before every client date, message already written."

### 8 · Breadth + control — **role switch** (30 sec)
- Skim the sidebar: Vendors, Procurement, Warehouse, Sales — "the full operation."
- Top-right role switcher → **Sales & Marketing** (modules shrink) → **Warehouse & Ops** (a different slice). "Same system, permissioned per role — that's the RBAC layer."

### 9 · Close (15 sec)
> "That's the concept working end-to-end — four automations, financials that generate themselves, and a full 360° on every client. What you saw is a clickable prototype on mock data; the real build wires these same triggers to a live database and WhatsApp/email APIs. Shall we talk scope?"

---

## Feature coverage vs. the deck (for Q&A)
- **Quotations & MoU** — Sales builds a quote → sends → client accepts → auto-generates MoU/contract PDF and pushes the deal to Finance (front of the state machine).
- **Project Management** — 7-stage Kanban + Timeline/Gantt (by division), per-project detail (milestone timeline, versioned assets, threaded @mention discussion).
- **Finance** — installment invoicing + PDF, Accounting (GL / Income Statement / Balance Sheet, double-entry), Project P&L, Budgeting + red-flag, Profit Simulator.
- **CRM** — client DB, Client 360 history, birthday **cron** with WhatsApp/Email drafts.
- **Vendors** — 3-vendor cost-estimator matrix (auto lowest-quote), 1–5 scorecards.
- **Warehouse** — dual-logic inventory (consumables → expense; fixed assets → in-transit, stay on balance sheet), **check-in** of returned in-transit assets, delivery orders + signed PDF.
- **Procurement** — Draft → Pending → Approved → **Paid** (auto petty-cash deduction), **proof-of-payment** upload, live petty-cash balance.
- **Vendors** — approved index, `vendor_inventories` third-party availability catalog, 3-vendor cost estimator, 1–5 scorecards.
- **Incentives** — client survey portal (1–10) → performance-based crew bonuses.
- **RBAC** — CEO / Sales & Marketing / Warehouse & Ops.

## If someone asks "is this live?" — be honest
> "It's a front-end prototype: real UI, real workflow logic, mock data that resets on refresh. No backend yet — that's Phase 2. The point today is to confirm the concept and the scope."

## Recovery
- Anything looks off → **refresh the page** (resets to the seeded starting state).
- The live automations (#1–#4) each fire **once per session** by design — refresh to re-run them.
- PDF downloads and the Profit Simulator can be used repeatedly.
