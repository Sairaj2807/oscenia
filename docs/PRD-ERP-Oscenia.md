# PRD — ERP Oscenia

**Product:** Oscenia ERP — Accounting & Operational Platform for Large-Scale Event Production
**Version:** 0.1 (Draft — derived from `ERP Oscenia.pptx`)
**Date:** 2026-07-26
**Status:** Draft for review

> **Source note:** This PRD is transcribed and structured from the 14-slide pitch deck `ERP Oscenia.pptx`. Content taken directly from the deck is stated as requirements. Anything the deck did not specify is called out as an **[Assumption]** or listed under **Open Questions** — it is not invented as fact.

---

## 1. Product Vision

Oscenia ERP is a **status-driven central engine (state machine)** for an event-production business. It is not merely a record-keeping application: **a status change in one module automatically triggers an action in another.** Every operational and financial record hangs off a single primary key — the **Project ID** — enabling real-time, per-project profit-and-loss.

### Guiding principles
1. **Project ID as the spine.** Every transaction, inventory movement, petty-cash request, and tax record is tagged to a Project ID (format: `EVT-2026-GALA-01`).
2. **State transitions automate the next step.** e.g. finance detecting a down payment auto-creates the project and starts its milestone pipeline.
3. **Real-time per-project micro P&L**, cleanly separated from monthly office overheads.

---

## 2. Goals & Success Signals

| Goal | Signal (from deck) |
|------|--------------------|
| Per-project profitability visibility | Real-time micro P&L; ~30% average event margin tracked |
| Reduce manual coordination | Auto-generated Project IDs, invoices, delivery orders, journal entries |
| Improve client retention | Automated birthday/milestone reminders to sales 7 days ahead |
| Cost optimization | Multi-vendor lowest-quote matrix; budget red-flags on overspend |
| Performance culture | Crew bonuses tied to client satisfaction ratings |

> **Open Question:** No numeric targets, timelines, or scale figures were in the deck. See §12.

---

## 3. User Roles (RBAC)

Access is assigned to **roles, not individuals**.

| Role | Access scope |
|------|--------------|
| **CEO** | Full company profitability dashboard, real-time bank balances, outstanding receivables, global vendor payables summary |
| **Sales & Marketing** | Quotation + MoU/contract modules; personal commission performance targets |
| **Warehouse & Operations** | Delivery notes, in-transit rental status, physical check-in/out logs, actual stock availability |

> **[Assumption]** Additional roles (Finance/Accounting, Project Manager, Design, Field Crew) are implied by workflows but not enumerated in the deck. See Open Questions.

---

## 4. Core Modules

The system has four operational pillars plus a finance/accounting backbone:

1. Project Management (production workflow / state machine)
2. CRM & Client Database
3. Vendor Management
4. Feedback-Driven Incentives (crew payroll)
5. Finance & Accounting System (invoicing, budgeting, procurement, accounting, warehouse)

---

## 5. Project Management Module

### 5.1 Project Initiation Trigger
When the **Financial System detects a down payment**, the system **automatically generates a new `Project_ID`** and starts the milestone pipeline.

### 5.2 Milestone Pipeline (State Machine)
Dynamic pipeline statuses on the project schema:

```
DP Paid → Design Uploaded → Client Approval → Vendor Dispatch
        → Execution Event → Post-Event Feedback → Finished
```

### 5.3 Functional Requirements
| # | Requirement |
|---|-------------|
| PM-1 | **Kanban board** and **Timeline / Gantt chart** for milestones and deadlines, viewable by division (Sales, Design, Warehouse, Field) |
| PM-2 | **Central asset storage** — file upload module for designs, 3D layouts, revised drafts, with **version control** and **client approval status** |
| PM-3 | **In-app contextual communication** — threaded discussion/comment area attached to each task card / project card |
| PM-4 | **@mention** feature for crew members with **real-time notifications (WebSocket)** |
| PM-5 | "Asset Attachment & Hook Alerts" — [Assumption] notifications fired when assets are attached/updated |

---

## 6. CRM & Client Database

### 6.1 Data Stored
- Personal/Company data: name, contact details, **birthday**, company anniversary, personal brand
- Project history and total **Lifetime Value (LTV)** of budget spent with Oscenia
- Interaction logs, event preferences, favorite vendors, client satisfaction history

### 6.2 Functional Requirements
| # | Requirement |
|---|-------------|
| CRM-1 | **Daily cron job** checks user records for birthdays / key milestones matching today |
| CRM-2 | On match, **send reminder to the Sales Team 7 days prior** to the date |
| CRM-3 | Prepare **message templates** and fire automated greetings via **WhatsApp / Email API** |
| CRM-4 | Sales can view interaction history: vendors used by a client, preferred event types, past satisfaction records — to deliver personalized pitches |

---

## 7. Vendor Management Module

### 7.1 Database Entities
| Entity | Input / Process | Output | Outcome |
|--------|-----------------|--------|---------|
| `vendors` | Contact info, categories (LED/Sound), baseline price cards | Indexed database of approved suppliers | Fast resource allocation & backup plans |
| `vendor_inventories` | Log & assign equipment availability from third-party partners | Real-time third-party catalog pricing lookup | Prevents on-site booking gaps in peak days |
| `vendor_cost_estimator` | Compare unit-level estimates from **3 distinct vendors** dynamically | Lowest-quote calculation matrix | Costing optimization |
| `vendor_tracking` | Log tasks completed, delays, post-production quality ratings | Vendor scorecard (scale **1–5**) | Qualitative selection |

---

## 8. Feedback-Driven Incentives (Crew Payroll)

Crew **bonus payouts are variable**, calculated directly from **client-facing ratings** registered at event closure.

| # | Requirement |
|---|-------------|
| INC-1 | **Client survey portal** — generate a simple rating form (**scale 1–10**) sent to the client on project closure |
| INC-2 | **Payroll processing** — query the final score from `project_feedbacks`, multiply by the crew's default base rate |
| INC-3 | Purpose: motivate execution teams toward on-field excellence (performance-based pay) |

---

## 9. Finance & Accounting System

### 9.1 Invoicing
| # | Requirement |
|---|-------------|
| FIN-1 | Input client installment details (**down payment, progress payment, final payment**) |
| FIN-2 | Auto-calculate total invoice amount, generate **PDF**, set AR status to **"Unpaid"** |
| FIN-3 | Invoices generated based on **Project ID**; supports vendor and customer invoices |

### 9.2 Budgeting
| # | Requirement |
|---|-------------|
| BUD-1 | Set expenditure **budget ceilings by project category** |
| BUD-2 | Compare **estimated vs. actual (realized) budget**, calculate dynamic margin |
| BUD-3 | Trigger a **red-flag notification** if actual costs exceed the limit |

### 9.3 Procurement & Petty Cash
| # | Requirement |
|---|-------------|
| PROC-1 | Submit vendor expenses and field cash advances with **daily multi-level approval workflow** |
| PROC-2 | Approval flow: **Draft → Pending Manager Approval → Approved → Paid** |
| PROC-3 | Capture **amount + expense category**; upload **proof of payment** (receipt/bill photo) |
| PROC-4 | On status → **Paid**, auto-create a **deduction entry against operational petty cash balance** (journal entry) |

### 9.4 Sales Report
| # | Requirement |
|---|-------------|
| SAL-1 | Retrieve all project transactions with **"Closed/Won"** status |
| SAL-2 | Auto-calculate **sales commissions** on net contract value at a specified percentage |
| SAL-3 | Generate a **monthly sales leaderboard** based on project closures |

### 9.5 Delivery Orders
| # | Requirement |
|---|-------------|
| DO-1 | Auto-generate a logistics equipment shipment log based on project requests |
| DO-2 | Print to **digitally signed PDF** |
| DO-3 | Connect with the Warehouse module; prevent **double booking** |

### 9.6 Accounting System
| # | Requirement |
|---|-------------|
| ACC-1 | **Double-entry** (Debit & Credit) bookkeeping |
| ACC-2 | Maintain a **General Ledger** |
| ACC-3 | Auto-generate **Income Statement** and **Balance Sheet** entries in the background from journal inputs |

### 9.7 Project P&L
| # | Requirement |
|---|-------------|
| PNL-1 | Instant event profitability evaluation with automatic **Project ID tagging** |
| PNL-2 | Filter dynamic data to show **project-specific micro P&L in real time** |
| PNL-3 | Cleanly separate operational (project) performance from monthly office overheads |

---

## 10. Dual-Logic Inventory / Warehouse

Two separate workflows for **consumables** vs **rental (fixed) assets**.

| Category | Definition | Sample items | Stock flow | Financial treatment |
|----------|-----------|--------------|-----------|---------------------|
| **Consumables** | Stock permanently reduced after warehouse delivery note released | Duct tape, nails, cable ties, mic batteries | Stock reduction → cost entry | Auto-debited to **Income Statement** |
| **Fixed Assets** | Stock **not** permanently reduced when taken to event | VIP sofa, lighting, truss, rigging, HT | Move to **In-Transit virtual warehouse** | Remains recorded as a **company fixed asset** |

**Rule:** The warehouse team must **check in returned equipment** to ensure assets are returned to HQ after the event concludes.

---

## 11. Consolidated Data Model (from deck)

Entities and key fields explicitly referenced:

- **projects** — `Project_ID` (`EVT-2026-GALA-01`), milestone status, division tags
- **clients** — name, contacts, birthday, company anniversary, personal brand, LTV, interaction logs, preferences, satisfaction history
- **vendors** — contact, category (LED/Sound), baseline price card
- **vendor_inventories** — equipment availability, third-party pricing
- **vendor_cost_estimator** — 3-vendor comparison matrix
- **vendor_tracking** — tasks, delays, ratings (1–5 scorecard)
- **project_feedbacks** — client rating (1–10) at closure → drives crew payroll
- **invoices** — installment amounts, AR status (Unpaid), PDF, Project ID
- **budgets** — category ceilings, estimated vs realized, margin
- **procurement / petty_cash** — amount, category, proof, approval status, journal deduction
- **delivery_orders** — shipment log, signed PDF, warehouse link
- **accounting** — journal entries, general ledger, income statement, balance sheet
- **crew / payroll** — base rate × feedback score
- **roles / RBAC** — CEO, Sales & Marketing, Warehouse & Operations

> **[Assumption]** Table names above are inferred from the slide labels; exact schema, field types, and relationships are not fully specified in the deck.

---

## 12. Cross-Module Automation (State Machine Triggers)

| Trigger | Automated action |
|---------|------------------|
| Down payment detected (Finance) | Generate `Project_ID`, start milestone pipeline |
| Milestone status change | Advance Kanban/Gantt; notify relevant division |
| @mention in task thread | Real-time WebSocket notification |
| Client birthday/milestone (daily cron) | Notify sales 7 days prior + prep WhatsApp/Email template |
| Procurement status → Paid | Deduct petty cash balance via journal entry |
| Project closure | Send client rating form → compute crew bonus |
| Consumable delivery note released | Reduce stock + debit Income Statement |
| Fixed asset dispatched | Move to In-Transit virtual warehouse (stays on balance sheet) |
| Journal input | Auto-post to GL → Income Statement + Balance Sheet |

---

## 13. Open Questions (parking for client)

1. **Tech stack & deployment** — no stack, hosting, or platform named in the deck.
2. **Scale** — number of concurrent projects, users, transaction volume, data retention?
3. **Timeline & phasing** — delivery deadlines and MVP scope not defined.
4. **Full role list** — are Finance/Accountant, Project Manager, Design, and Field Crew distinct roles with their own permissions?
5. **WhatsApp/Email providers** — which specific APIs (e.g. WhatsApp Business API, Twilio, SendGrid)?
6. **Multi-currency / localization** — deck mixes English and Indonesian ("Kredit"); is IDR the base currency? Multi-currency needed?
7. **Tax records** — mentioned in passing; what tax rules/reports (e.g. Indonesian VAT/PPN) are in scope?
8. **Accounting standards** — which standard for Income Statement / Balance Sheet (e.g. PSAK/IFRS)?
9. **Client-facing portals** — is the client survey/rating form a public portal or emailed link? Any client login?
10. **Slide 9 "Project Profitability Simulation"** — title only in deck; what does this feature do (forecast/what-if modeling)?
11. **Commission & bonus formulas** — exact percentages and base-rate definitions?
12. **Integration with existing Oscenia website** — this repo is the marketing site; is the ERP a separate app or embedded?

---

## 14. Suggested Build Phasing *(proposal, not from deck)*

> **[Assumption]** Ordered by dependency — Project ID and finance triggers are the spine, so they come first.

1. **Phase 1 — Foundation:** Auth + RBAC, Projects + Project ID, core data model.
2. **Phase 2 — Finance spine:** Invoicing (DP detection → Project ID trigger), double-entry accounting, Project P&L.
3. **Phase 3 — Project Management:** Kanban/Gantt, asset storage w/ versioning, threaded comments, @mentions + WebSocket.
4. **Phase 4 — CRM:** Client DB, interaction logs, birthday cron + WhatsApp/Email reminders.
5. **Phase 5 — Vendor Management:** Vendors, inventories, cost estimator, tracking scorecards.
6. **Phase 6 — Procurement & Warehouse:** Petty cash approval flow, dual-logic inventory, delivery orders.
7. **Phase 7 — Incentives & Reporting:** Client survey, crew payroll, sales leaderboard, dashboards.

---

*End of draft. Confirm Open Questions (§13) before technical architecture.*
