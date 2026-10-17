# Oscenia ERP — Prototype Walkthrough

> **Historical record.** Written before the 17 Oct 2026 restructure. Paths and deploy steps below are as they were (`erp-prototype/` is now `erp-frontend/`, `oscenia-web/` is now `website/`, and Vercel is no longer used). Current state: [GO-LIVE-STATUS](./GO-LIVE-STATUS.md).


**Prototype link:** **https://oscenia-web.vercel.app/erp**

Thank you for taking the time to review this. What you're looking at is an **interactive prototype** of the Oscenia ERP, built directly from your concept deck. It's meant to make the idea tangible — so you can *click through the actual screens* and tell us what feels right, what's missing, and what should work differently, before we build the real thing.

Please explore freely and jot down any thoughts as you go. There's nothing you can break.

---

## Before you start — 4 things to know

1. **It's a demonstration, not the live system.** The data (clients, projects, figures) is realistic sample data. Nothing is connected to a real database yet — so if you refresh the page, everything resets to the starting point. That's expected.
2. **Switch who you are.** Top-right corner has a **role switcher** — view the system as the **CEO**, **Sales & Marketing**, or **Warehouse & Operations**. Each role sees only the screens relevant to them.
3. **Two languages.** Top-right has an **EN / ID** toggle to switch the interface between English and Bahasa Indonesia.
4. **The big idea.** Everything in the system hangs off one **Project ID** (e.g. `EVT‑2026‑GALA‑01`), and a status change in one place automatically triggers the next step somewhere else. Watch for the small **"auto"** pop-up notifications — those show the system doing work on its own.

---

## The overall flow (how a job moves through the system)

A single event travels left-to-right through the whole business:

```
QUOTE  →  DOWN PAYMENT  →  PROJECT CREATED  →  DESIGN → APPROVAL → VENDORS
      →  EXECUTION  →  CLIENT FEEDBACK  →  CREW PAID  →  BOOKS UPDATED
```

Sales writes a quote → client accepts → the deposit creates the project → production runs through its milestones → the event happens → the client rates it → crew bonuses and the accounts all update — **without anyone re-typing the same information twice.**

The screens below follow that same order.

---

## Screen-by-screen guide

### 1. Dashboard *(CEO)*
**What it is:** The company at a glance — total pipeline value, average event margin, outstanding money owed to you, and active projects, with revenue and margin charts.
**Look for:** Whether these are the right top-level numbers a CEO wants to open the system to.

### 2. Quotations & MoU *(Sales)*
**What it is:** Where every deal begins. Sales drafts a quotation (line items → contract value + margin), sends it, and on client acceptance the system **generates the MoU/contract** and hands it to Finance as a ready deal.
**Try this:** Click **New Quotation** to build one, or on a "Sent" quote click **Mark accepted** → notice it generates the contract and pushes the deal forward. Download a **PDF/MoU** to see the branded document.
**Look for:** The line items and contract fields you actually use in your quotes.

### 3. Finance & Invoicing *(CEO / Sales)*
**What it is:** Installment invoicing (down payment / progress / final), accounts receivable, and the **key trigger**: confirming the down payment.
**Try this:** Click **Confirm Down Payment** on the pending deal → watch the "auto" notifications cascade — a new **Project ID** is created, the production pipeline starts, and the accounting is updated. Download any invoice as a **PDF**.
**Look for:** Your real invoicing stages and payment terms.

### 4. Projects — Pipeline Board *(everyone)*
**What it is:** Your production workflow as a board across the **seven milestones** (DP Paid → Design → Client Approval → Vendor Dispatch → Execution → Post-Event Feedback → Finished). A **Timeline** tab shows the same projects on a calendar (Gantt), filterable by division.
**Try this:** Click **advance** on a card to move it along; click a card to open its detail.
**Look for:** Whether these seven stages match how your projects really flow.

### 5. Project Detail
**What it is:** One project up close — milestone progress, uploaded design files with **version control** and approval status, and a **threaded discussion** with @mentions for the crew.
**Look for:** What information you'd want on a single project's page.

### 6. Project P&L *(CEO / Sales)*
**What it is:** A live profit-and-loss statement for a single event — revenue, cost breakdown, and margin — kept separate from office overheads.
**Look for:** Whether the cost categories reflect your real event costs.

### 7. Accounting *(CEO)*
**What it is:** The books, generated automatically — a **double-entry journal**, **Income Statement**, and **Balance Sheet** — all built from the day-to-day transactions.
**Look for:** Whether the account structure fits how your accountant works.

### 8. Budgeting *(CEO)*
**What it is:** Spending ceilings per cost category vs. actual spend, with an automatic **red-flag alert** when a category goes over budget.
**Try this:** Click **Log unplanned cost** → watch a category breach its ceiling and raise an alarm.

### 9. Profit Simulator *(CEO)*
**What it is:** A "what-if" tool — drag sliders for contract value, vendor cost, crew, etc., and watch the **margin, profit and break-even recalculate live**. Useful before committing to a job.
**Look for:** The levers you'd actually want to model.

### 10. CRM & Clients *(CEO / Sales)*
**What it is:** Your client database — lifetime value, preferences, satisfaction, birthdays.
**Try this:** **Click any client row** to open their **Client 360** — full profile (incl. company anniversary & "personal brand"), interaction history, vendors they've used, and every past event with its rating.
**Look for:** The client details your sales team relies on.

### 11. Automated Cron (Reminders) *(CEO / Sales)*
**What it is:** Background jobs that run daily on their own. The headline one scans for client birthdays/anniversaries and **notifies Sales ahead of time** with **ready-to-send WhatsApp & Email drafts**.
**Try this:** Click **Run daily jobs now**, then **Preview draft** on a reminder to see (and edit) the actual message.

### 12. Client Survey *(reached from Crew & Incentives → "Open client survey")*
**What it is:** The post-event rating form (1–10) sent to the client. Their score feeds crew bonuses automatically.
**Try this:** Submit a rating and notice it updates the incentive pool on the Payroll screen.

### 13. Vendors *(CEO)*
**What it is:** Your approved-supplier list, a **3-vendor cost comparison** that flags the lowest quote, a **third-party equipment catalog** with live availability, and **1–5 performance scorecards** (delays, quality).
**Look for:** The vendor information and rating factors that matter to you.

### 14. Procurement & Petty Cash *(CEO / Warehouse)*
**What it is:** Expense requests through a **Draft → Pending → Approved → Paid** approval flow, with **proof-of-payment** upload and a running **petty-cash balance** that deducts automatically.
**Look for:** Your real approval steps and who signs off.

### 15. Warehouse *(CEO / Warehouse)*
**What it is:** **Dual-logic inventory** — *consumables* (used up, become a cost) vs *fixed assets* (rented gear that goes "in-transit" and must be **checked back in** after the event) — plus delivery orders with **signed PDFs**.
**Try this:** Click **Check in** on an in-transit item to return it to the warehouse.

### 16. Crew & Incentives (Payroll) *(CEO)*
**What it is:** Performance-based crew pay — bonuses calculated from the client's post-event rating × each crew member's base rate.
**Look for:** Whether this matches how you'd like to reward field teams.

### 17. Sales Report *(CEO / Sales)*
**What it is:** A leaderboard of the sales team by closed deals, with automatic commission calculations.

---

## A suggested 5-minute path

1. **Quotations** → accept a quote → **Finance** → **Confirm Down Payment** (watch the auto-notifications)
2. **Projects** → see the new project appear → click **advance** a couple of times
3. **CRM** → open a client's **360** view
4. **Automated Cron** → **Run daily jobs** → **Preview** a message draft
5. Flip the **EN / ID** toggle and the **role switcher** to see how it adapts

---

## What we'd love your feedback on

- **Screens & fields:** Anything missing? Any field we're capturing that you don't need — or one we're not capturing that you do?
- **Your workflow:** Do the **seven project milestones** and the **approval steps** match how Oscenia actually works?
- **Roles & permissions:** Is CEO / Sales / Warehouse the right split, or do you need more roles?
- **Numbers & reports:** Are these the figures and reports your team relies on day to day?
- **Anything unclear or awkward** as you click around.

Please note anything that comes to mind — screen name + your comment is perfect. There are no wrong answers; this is exactly the stage to shape it.

---

*This is a clickable prototype for review only — sample data, no live backend yet. Once we've captured your feedback, it becomes the blueprint for the real, database-backed system.*
