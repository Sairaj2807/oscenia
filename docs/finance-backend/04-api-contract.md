# 04 — API Contract

Derived screen by screen from the prototype's 18 finance pages, so that nothing the UI
already displays is missing when the rewire begins.

## Conventions

- Base path `/api/v1`. JSON in, JSON out.
- All money is serialised as a **decimal string** (`"144000000.00"`), never a JSON number.
  JSON numbers are IEEE 754 doubles and would reintroduce exactly the float problem the
  schema avoids.
- Dates are `YYYY-MM-DD` strings. Timestamps are RFC 3339 UTC.
- Auth: `Authorization: Bearer <access token>` on everything except `/auth/login` and
  `/health`.
- Errors are RFC 7807 problem documents:

```json
{
  "type": "https://oscenia.erp/errors/permission-denied",
  "title": "Permission denied",
  "status": 403,
  "detail": "Approving cash is restricted to CEO and Finance.",
  "action": "approve_cash"
}
```

  A permission denial **names the roles that are permitted**, matching `denialReason()`.

- Status codes carry meaning:
  `409 Conflict` is a refused business operation (issuing an invoice twice, deleting a used
  account, settling a settled PO). `422` is malformed input. `403` is RBAC.
- List endpoints paginate with `?limit=&cursor=` and return `{items, next_cursor, total}`.
- Mutating `POST`s accept an optional `Idempotency-Key` header.

Each endpoint below names the **action** it requires (from the 20-action matrix) where one
applies.

---

## Auth

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | `{email, password}` → `{access_token, refresh_token, user}` |
| `POST` | `/auth/refresh` | rotates the refresh token |
| `POST` | `/auth/logout` | revokes the refresh token |
| `GET` | `/auth/me` | current user, role, and the **resolved list of permitted actions and visible modules** — so the UI can gate without duplicating the matrix |

---

## Chart of accounts — backs `ChartOfAccounts.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/accounts` | — | `?type=&q=&include_inactive=` — search matches code, name or group |
| `GET` | `/accounts/tree` | — | type → executive group → account → sub-accounts, as the screen renders it |
| `GET` | `/accounts/{code}` | — | includes `usage_count`, `balance`, `is_header`, `is_postable`, and which locks apply |
| `POST` | `/accounts` | `manage_coa` | sub-accounts inherit `is_cash` and `tax_key` from the parent |
| `PATCH` | `/accounts/{code}` | `manage_coa` | **409** on a `code` or `type` change once the account has posted lines; rename always allowed |
| `POST` | `/accounts/{code}/activate` · `/deactivate` | `manage_coa` | keeps balance and history, stops accepting postings |
| `DELETE` | `/accounts/{code}` | `manage_coa` | **409** when used or when it has children — the error names deactivation |
| `GET` | `/accounts/next-code?type=&parent=` | `manage_coa` | suggests `1101.01` under a parent, or the next top-level code for a type |
| `GET` | `/accounts/stats` | — | totals, postable, deactivated, **never posted to** (the fragmentation warning) |

`POST /accounts` returns an **integration preview** alongside the created account — which
general ledger, which statement, which executive bucket, which normal balance — matching the
modal the prototype shows before creation.

---

## Ledger — backs `Accounting.jsx` (Journal tab, entry modals)

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/journal-entries` | — | `?from=&to=&project=&source_kind=&account=&q=` |
| `GET` | `/journal-entries/{id}` | — | lines, linked documents (`settles` / `settled_by`), and the resolved **source document** (invoice / procurement request / delivery order rows) |
| `POST` | `/journal-entries` | `post_journal` | server validates balance and mints `entry_no` + `voucher_no`; optional `applied_to` |
| `POST` | `/journal-entries/{id}/reverse` | `post_journal` | gets its own voucher number |
| `POST` | `/journal-entries/{id}/adjust` | `post_journal` | reverse + repost; body carries the corrected lines |
| `GET` | `/journal-entries/{id}/voucher.pdf` | — | cash-in / cash-out / accrual classification, counterparty, bank account, cross-reference note |
| `GET` | `/open-items` | — | `?control=1201|2102&side=debit|credit` — powers the Applied Payment / Bill Payment pickers |

There is deliberately **no** `PUT`, `PATCH` or `DELETE` on a journal entry. The absence is
the feature.

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/voucher-series` | — | |
| `PATCH` | `/voucher-series/{key}` | `post_journal` | **422** if the format lacks `[SEQ_nnn]` or the prefix is blank; returns a live preview of the next number |
| `GET` | `/voucher-series/{key}/preview?date=` | `post_journal` | |
| `GET` | `/periods` | — | |
| `POST` | `/periods/{year}/{month}/close` · `/reopen` | `post_journal` | reopening is logged |

---

## Reports — backs `Accounting.jsx` (GL / IS / BS tabs), `Cash.jsx`, `ProjectPnL.jsx`, `Dashboard.jsx`

Every report accepts the same filter triple: `?from=&to=&project=`. Named periods
(`today|month|quarter|ytd|all`) resolve server-side against the clock, so the client cannot
disagree with the server about where a quarter starts.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/reports/trial-balance` | `{debit, credit, balanced}` |
| `GET` | `/reports/general-ledger` | `?codes=&from=&to=&project=` → `{opening, rows[], closing, total_debit, total_credit, movement_count}`. Opening folds in everything before `from` rather than dropping it |
| `GET` | `/reports/income-statement` | `?summarised=` → revenue / cogs / opex / tax lines, totals, gross profit, PBT, NPAT, margins, tax rate, and the **prepaid PPh 23 credit** balance |
| `GET` | `/reports/balance-sheet` | assets / liabilities / equity, totals, `balanced`, `difference`. Includes the two derived rows |
| `GET` | `/reports/cash-position` | total plus per-account balance and share |
| `GET` | `/reports/cash-movements` | entries with a non-zero net cash effect, in / out / running balance |
| `GET` | `/reports/project-pnl` | `?project=` or `?month=` or `?from=&to=` — revenue, cost lines, gross profit, margin to 2dp, cost composition |
| `GET` | `/reports/project-pnl/compare` | `?against=budget|project|prev|mom|yoy` — both sides computed through the identical path; **cost deltas are inverse-signed** (spending less is good) |
| `GET` | `/reports/receivables-ageing` | buckets `current / 1-30 / 31-60 / 60+`, plus the **1201 reconciliation** (`ledger_balance`, `subledger_total`, `reconciled`, `difference`) |
| `GET` | `/reports/payables-ageing` | same shape against 2102, plus PPh 23 owed (balance of 2105) |
| `GET` | `/reports/fixed-asset-register` | cost, accumulated, NBV, and the **1302/1303 reconciliation** |
| `GET` | `/reports/petty-cash-by-requester` | count, requested, actual, variance, still open — the client's "Recap by Requester" |
| `GET` | `/reports/revenue-trend?months=6` | *currently hardcoded fake data in the prototype; becomes real here* |
| `GET` | `/reports/margin-by-project` | |
| `GET` | `/reports/earliest-entry-date` | so a comparison window ending before the ledger begins can warn rather than render zeroes |
| `GET` | `/reports/{report}/export?format=csv\|xlsx\|pdf` | uniform export suffix on every report above |

The three **reconciliation** payloads are not optional extras. Three screens display a live
*Reconciled / Out by X* badge, and that is the system's own tripwire for silent drift.

---

## Dashboard

| Method | Path | Returns |
|---|---|---|
| `GET` | `/dashboard/kpis` | pipeline value, total cash, average event margin, outstanding receivables, active projects |
| `GET` | `/dashboard/project-health` | per project: stage, days to event, days in stage, margin, contract value, ceiling, **committed-but-unpaid**, spent %, and the chips (DP received, over budget, AR overdue) |

Average event margin uses **cost at completion** — `realized` for finished projects,
`max(estimated, realized)` otherwise — not cost to date. Using cost-to-date was the bug that
made the deck's headline margin read 60% instead of 30.51%.

---

## AR

### Clients & CRM — backs `CRM.jsx`, `ClientDetail.jsx`

| Method | Path | Action |
|---|---|---|
| `GET` `POST` | `/clients` | `edit_client` to create |
| `GET` `PATCH` | `/clients/{id}` | `edit_client` |
| `GET` | `/clients/{id}/ltv` | — (computed: past event value + live contract value) |
| `GET` `POST` | `/clients/{id}/interactions` | `edit_client` — free-text note, no length limit, stamped with author and timestamp |
| `PATCH` `DELETE` | `/interactions/{id}` | `edit_client` — sets `edited_at` |
| `POST` | `/interactions/{id}/attachments` | `edit_client` |

### Quotations & MoU — backs `Quotations.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` `POST` | `/quotations` | — / `request_po`-equivalent sales gate | line items carry **sell price and estimated cost**, so margin is live |
| `PATCH` | `/quotations/{id}` | — | **409 once Accepted**. Editing a `Sent` quote drops it back to `Draft` |
| `POST` | `/quotations/{id}/send` | — | |
| `POST` | `/quotations/{id}/accept` | — | resolves the DP schedule, generates the MoU, creates the pending deal |
| `POST` | `/quotations/{id}/decline` | `cancel_quotation` | |
| `GET` | `/quotations/{id}/pdf` | — | |
| `GET` | `/billing/dp-presets` | — | `50` · `75` · `100` · `30/40/30` |
| `POST` | `/billing/resolve-schedule` | — | `{stages, contract_value, signing_date, event_date}` → resolved rows with amounts, due dates and percentages. **Sums to the contract value to the rupiah** — the final stage absorbs the remainder |
| `GET` `POST` `PATCH` `DELETE` | `/mou-templates` | — | delete **409** while an Accepted quotation uses it; other quotes reassign to the default |

A stage is `{label, basis: percent|amount, value, anchor: signing|event, offset_days}`.
A negative offset means before the anchor.

### Deals & invoices — backs `Finance.jsx`, `Receivables.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/deals/pending` | — | contract value, DP amount and percent, and the agreed schedule |
| `POST` | `/deals/{id}/confirm-down-payment` | `confirm_dp` | **one transaction**: project + N invoices + the two linked entries. Idempotent |
| `POST` | `/deals/{id}/undo-down-payment` | `confirm_dp` | **409 with a reason** when the project has other postings or live POs |
| `GET` | `/invoices` | — | `?project=&status=` |
| `POST` | `/invoices/{id}/issue` | `confirm_dp` | `Scheduled` → `Unpaid`. **409** if already issued |
| `POST` | `/invoices/{id}/payments` | `confirm_dp` | `{amount, date, cash_account, withhold, tax_amount?}`. Gross clamped to outstanding; **409** on a `Scheduled` invoice or a settled one; **422** if tax exceeds the payment |
| `GET` | `/invoices/{id}/pdf` | — | |

`POST /invoices/{id}/payments` returns a **posting preview** in its response — the exact lines
written — because the prototype's receive-payment modal shows that preview before submission
and the UI will want the same shape back.

---

## AP

### Vendors — backs `Vendors.jsx`, `VendorDetail.jsx`

| Method | Path | Action |
|---|---|---|
| `GET` `POST` | `/vendors` | `request_po` to create |
| `GET` | `/vendors/{id}` | — |
| `PATCH` | `/vendors/{id}` | `pay_po` — includes `pph23_rate`, which **overrides the company default** |
| `GET` | `/vendors/{id}/purchase-orders` | — |
| `GET` `POST` `DELETE` | `/vendors/{id}/attachments` | `request_po` — real files, not filenames |
| `GET` | `/vendor-catalogue` | `?vendor=&category=&subcategory=&tags=&q=&from=&to=` |
| `GET` | `/vendor-catalogue/availability` | `?item=&from=&to=&exclude_project=` → `{stock, booked, available, status}` |
| `GET` `POST` `PATCH` `DELETE` | `/tags` | — deleting cascades to vendors and catalogue items |

Availability is **date-aware** over the event window (load-in D−2 to strike D+1), and tag
filtering is AND semantics.

### Purchase orders — backs `PurchaseOrders.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` `POST` | `/purchase-orders` | `request_po` | **422 naming the item** when a line is overbooked in the event window |
| `POST` | `/purchase-orders/{id}/approve` | `approve_po` | **posts nothing** — reserves catalogue stock only |
| `POST` | `/purchase-orders/{id}/pay-dp` | `pay_po` | raises the bill lazily, then pays the DP |
| `POST` | `/purchase-orders/{id}/settle` | `pay_po` | `{actual_total}` — posts the variance, then pays the remainder or refunds. Accepts `DP Paid` **or** `Approved`. **409** if already settled |
| `POST` | `/purchase-orders/{id}/cancel` | `approve_po` | reverses payments before bills; releases only its own reservations |
| `GET` | `/purchase-orders/{id}/pdf` | — | |
| `GET` | `/purchase-orders/{id}/outstanding` | — | read from the ledger, not from the PO record |

### Bills — backs `Payables.jsx`

Bills are journal entries, so they are addressed by entry id.

| Method | Path | Action |
|---|---|---|
| `GET` | `/bills` | — (open items on 2102, with vendor, project, due date and ageing) |
| `POST` | `/bills/{entry_id}/payments` | `pay_po` — `{amount, date, cash_account, withhold}`; syncs the originating PO's status |

Works for an overhead bill that never had a purchase order.

---

## Cash & procurement — backs `Cash.jsx`, `Procurement.jsx`, `Budgeting.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/petty-cash/balance` | — | opening float + top-ups − disbursements, reconciled against 1103 |
| `POST` | `/petty-cash/top-up` | `approve_cash` | **422** on zero or negative |
| `GET` `POST` | `/procurement-requests` | `request_advance` | `?status=&project=&requester=&from=`. **422** on a blank requester |
| `POST` | `/procurement-requests/{id}/transition` | `approve_cash` for Approve/Pay; `request_advance` to Submit | `{status}` — posts on `Disbursed` |
| `POST` | `/procurement-requests/{id}/settle` | `file_expense` | `{actual, receipts[]}` — **422** with no receipt |
| `GET` | `/projects/{id}/budget` | — | ceilings, plus actuals **derived from postings** |
| `PUT` | `/projects/{id}/budget/categories` | `approve_cash` | |
| `GET` `PATCH` | `/settings/budget-tolerance` | `edit_tax` | default 10%; **warns, never blocks** |
| `GET` | `/alerts/budget-breaches` | — | one alert per project, not per posting |
| `POST` | `/attachments` | — | multipart; returns `{id, filename, content_type, byte_size}` |
| `GET` | `/attachments/{id}` | — | streams the file |

---

## Fixed assets — backs `FixedAssets.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/fixed-assets` | — | `?asset_status=active\|disposed`, `?as_of=` |
| `GET` | `/fixed-assets/register` | — | register totals **beside the ledger's**, with a `reconciled` flag. Both are reported; where the sub-ledger disagrees with 1302/1303 the screen says so rather than preferring one |
| `POST` | `/fixed-assets` | `manage_assets` | `{…, post, pay_from}` — `post: false` registers kit already inside 1302 without double-counting |
| `PATCH` | `/fixed-assets/{id}` | `manage_assets` | **422** on `cost`, `posted_through`, `posted_accumulated`, `asset_no`, `status`; a life or method change is **prospective** and the response says so |
| `GET` | `/fixed-assets/{id}/schedule` | — | month-by-month: period, posts-on date, opening NBV, charge, closing NBV, state `posted\|due\|future` |
| `POST` | `/fixed-assets/{id}/dispose` | `manage_assets` | `{proceeds}`. **409** if already disposed |
| `GET` | `/depreciation/backlog` | — | the periods owed and what they total: how much expense is missing from the Income Statement |
| `POST` | `/depreciation/run` | `manage_assets` | `{}` clears the whole backlog oldest-first; `{"period": "YYYY-MM"}` posts one. **Idempotent** — a second call posts nothing and reports `posted: 0` |

---

## Warehouse — backs `Warehouse.jsx`

Three movements reach the ledger; the rest are stock states. See
[03 § Warehouse](./03-accounting-rules.md#warehouse--postings-that-reach-the-ledger).

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` | `/inventory` | — | |
| `POST` | `/inventory` | `add_stock` | |
| `POST` | `/inventory/{id}/release` | `manage_stock` | consumables only — **409** for a fixed asset. Expenses to 5104 and reduces stock permanently |
| `POST` | `/inventory/{id}/return` | `manage_stock` | `{condition: good\|damaged\|lost, lost_qty}`. Only lost stock posts; damaged goes to maintenance |
| `POST` | `/inventory/{id}/repair` | `manage_stock` | back to stock, posts nothing |
| `POST` | `/inventory/{id}/condemn` | `manage_stock` | write-off. If the stock is on the register, its share of 1303 returns with it and only the **net book value** hits 6901 |

---

## Payroll — backs `Payroll.jsx`, `Survey.jsx`

| Method | Path | Action | Notes |
|---|---|---|---|
| `GET` `POST` | `/crew` | — / `approve_incentive` | |
| `GET` | `/projects/{id}/incentives` | — | per-crew bonus, who qualifies, pool total. Computed live, never cached |
| `PUT` | `/projects/{id}/feedback` | — | client rating out of 10; returns the recomputed pool. One per project — a re-rating replaces rather than averages |
| `POST` | `/incentives/disburse` | `approve_incentive` | `{project_id, amount}`. **422 without a project id** — nothing is posted. **409** on a second call |
| `GET` `PATCH` | `/settings` | — / `edit_tax` | carries `bonus_threshold`, clamped 0–10 (shared with the phase-6 budget tolerance) |

---

## Projects — backs `Projects.jsx`, `ProjectDetail.jsx`

| Method | Path | Action |
|---|---|---|
| `GET` | `/projects` | — |
| `GET` | `/projects/{id}` | — |
| `POST` | `/projects/{id}/advance-stage` | `advance_stage` |
| `POST` | `/projects/{id}/revert-stage` | `revert_stage` — cannot revert past the first stage |
| `POST` | `/projects/{id}/move-to-stage` | `advance_stage` |
| `POST` | `/projects/{id}/cancel` | `cancel_project` — `{refund_dp, reason}`. Refunding reverses recognitions and receipts; **costs already incurred are never reversed** |
| `GET` | `/projects/{id}/costs` | — itemised, credits appearing as negatives rather than filtered out |

---

## Masters & operations

| Method | Path | Action |
|---|---|---|
| `GET` | `/tax-config` | — |
| `PATCH` | `/tax-config/{key}` | `edit_tax` — rate and active flag |
| `GET` | `/cron/jobs` | — |
| `POST` | `/cron/jobs/{key}/run` | `post_journal` |
| `GET` | `/job-runs` | — |
| `GET` | `/reminders?horizon_days=7` | — |
| `POST` | `/reminders/{id}/assign` | — |
| `GET` | `/health` | — liveness plus a database round-trip |

---

## Coverage check

Against the prototype's ~70 store mutations, the ones with **no endpoint here** are:

| Store action | Why absent |
|---|---|
| `setRole` | replaced by real authentication |
| `setLang` / `toggleLang` | UI-only; the dictionary stays in the frontend |
| `addUnplannedCost` | a demo-only button; not a real operation |
| `runCron` (client simulation) | replaced by the real scheduler |
| Simulator state | pure what-if arithmetic with nothing persisted; it can stay client-side |

Everything else — every posting action, every workflow transition, every KPI on all 18
finance screens — has an endpoint above.
