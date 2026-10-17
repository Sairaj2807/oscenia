# 02 — Data Model

Conventions used throughout:

- All money is `NUMERIC(18,2)`. Never float. See [01 — Money](./01-architecture.md#money).
- All identifiers are `uuid` primary keys (`gen_random_uuid()`), **plus** a human document
  number in its own unique column (`entry_no`, `invoice_no`, `po_no`). The prototype uses the
  human number as the key; we do not, because human numbers are formatted, configurable and
  occasionally regretted, and a foreign key should be none of those things.
- Every table carries `created_at timestamptz NOT NULL DEFAULT now()`. Mutable tables also
  carry `updated_at`. Journal tables carry neither an `updated_at` nor a soft-delete flag,
  by design — they are append-only.
- Dates that represent an accounting date are `date`, not `timestamptz`. The prototype stores
  date-only ISO strings and parses them as UTC; a timestamp here would reintroduce the
  timezone bug that `verify-flows §33` exists to prevent.
- Naming: snake_case, plural table names, `<table>_id` foreign keys.

---

## Part 1 — The five load-bearing tables

Everything else in this document is ordinary CRUD. These five are where correctness lives,
so they are given in full DDL.

### `accounts` — the chart of accounts

```sql
CREATE TYPE account_type AS ENUM
  ('asset','liability','equity','revenue','cogs','opex','tax');

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code          text NOT NULL UNIQUE,
  name          text NOT NULL,
  type          account_type NOT NULL,
  group_label   text NOT NULL,            -- executive-summary bucket, e.g. 'Cash & Bank'
  parent_code   text REFERENCES accounts(code) ON UPDATE CASCADE,
  is_cash       boolean NOT NULL DEFAULT false,
  is_contra     boolean NOT NULL DEFAULT false,
  tax_key       text,                     -- 'pph23' | 'pph21' | 'ppn' | NULL
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT accounts_code_format CHECK (code ~ '^[0-9]+(\.[0-9]+)*$'),
  CONSTRAINT accounts_not_self_parent CHECK (parent_code IS NULL OR parent_code <> code)
);

CREATE INDEX accounts_parent_idx ON accounts (parent_code);
CREATE INDEX accounts_type_idx   ON accounts (type);
```

Rules that are **not** expressible as a column constraint and become triggers or service
checks — all ported from `src/lib/accounts.js`:

| Rule | Where enforced | Source |
|---|---|---|
| Sub-accounts nest **one level only** — a parent may not itself have a parent | trigger | `validateAccountDraft` |
| A sub-account must share its parent's `type` | trigger | `validateAccountDraft` |
| A sub-account **inherits** `is_cash` and `tax_key` from its parent on creation | service | `addAccount` |
| An account **with children is a header**: nothing new may post to it | posting trigger | `isPostable` |
| A header nevertheless **keeps its own balance**, and rollups sum parent *and* children | report SQL | `accounts.js:122-129` |
| Once an account has posted lines, `code` and `type` are **locked**; renaming stays allowed | trigger | `updateAccount` |
| An account with lines or children **cannot be deleted** — deactivate instead | trigger | `deleteAccount` |

> The header-keeps-its-balance rule is the least obvious and the easiest to get wrong. The
> prototype's own comment explains why: if an administrator opens sub-accounts under 1101,
> the postings already sitting on 1101 do not move, and dropping the header from the rollup
> "would quietly delete that balance from Total Cash and from the cash-flow screen."

The 27 seed accounts are listed in [03 — Accounting rules](./03-accounting-rules.md#the-seed-chart-of-accounts).

### `journal_entries` — append-only

```sql
CREATE TYPE source_kind AS ENUM
  ('invoice','payment','po','pettycash','warehouse','payroll',
   'manual','opening','reversal','adjustment','depreciation');

CREATE TABLE journal_entries (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_no          text NOT NULL UNIQUE,          -- 'JE-1042'
  entry_date        date NOT NULL,
  memo              text NOT NULL,
  project_id        uuid REFERENCES projects(id),  -- the cost-centre tag; nullable
  series            text NOT NULL REFERENCES voucher_series(key),
  voucher_no        text NOT NULL UNIQUE,          -- 'KM-05-10-001'

  source_kind       source_kind NOT NULL,
  source_ref        text,                          -- invoice no, PO no, period, entry id…
  source_due        date,                          -- ageing anchor for AP bills
  source_vendor_id  uuid REFERENCES vendors(id),
  source_settlement boolean NOT NULL DEFAULT false,

  reversal_of_id    uuid REFERENCES journal_entries(id),
  reversed_by_id    uuid REFERENCES journal_entries(id),

  posted_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT je_memo_present CHECK (length(btrim(memo)) > 0)
);

CREATE INDEX je_date_idx    ON journal_entries (entry_date);
CREATE INDEX je_project_idx ON journal_entries (project_id) WHERE project_id IS NOT NULL;
CREATE INDEX je_source_idx  ON journal_entries (source_kind, source_ref);
CREATE INDEX je_due_idx     ON journal_entries (source_due) WHERE source_due IS NOT NULL;

-- Idempotency: a depreciation period, an incentive disbursement and a DP confirmation
-- may each be posted exactly once. See "Idempotency" below.
CREATE UNIQUE INDEX je_source_once_idx
  ON journal_entries (source_kind, source_ref)
  WHERE source_kind IN ('depreciation','payroll') AND source_ref IS NOT NULL;
```

`source_vendor_id` replaces the prototype's `source.vendor` **name string**. In
`payVendorBill` the vendor is currently looked up with
`vendors.find(v => v.name === bill.source?.vendor)` — a join on a mutable display name.
That becomes a real foreign key here.

### `journal_lines`

```sql
CREATE TABLE journal_lines (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id     uuid NOT NULL REFERENCES journal_entries(id),
  line_no      integer NOT NULL,
  account_code text NOT NULL REFERENCES accounts(code) ON UPDATE CASCADE,
  debit        numeric(18,2) NOT NULL DEFAULT 0,
  credit       numeric(18,2) NOT NULL DEFAULT 0,
  note         text,

  CONSTRAINT jl_non_negative CHECK (debit >= 0 AND credit >= 0),
  CONSTRAINT jl_one_side     CHECK ((debit = 0) <> (credit = 0)),
  CONSTRAINT jl_line_unique  UNIQUE (entry_id, line_no)
);

CREATE INDEX jl_entry_idx   ON journal_lines (entry_id);
CREATE INDEX jl_account_idx ON journal_lines (account_code);
```

`jl_one_side` is `(debit = 0) <> (credit = 0)` — exclusive or. A line carries a debit **or**
a credit, never both and never neither, which is exactly `lineIsValid` in `ledger.js`.

`ON UPDATE CASCADE` on `account_code` exists because renumbering an account cascades to its
children in the prototype — but a *used* account can never be renumbered (see the lock rule
above), so in practice this fires only for unused accounts.

### `entry_applications` — the AR/AP engine

```sql
CREATE TABLE entry_applications (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settling_entry_id uuid NOT NULL REFERENCES journal_entries(id),
  settled_entry_id  uuid NOT NULL REFERENCES journal_entries(id),
  amount            numeric(18,2),        -- nullable: null = "the whole movement"
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT ea_not_self   CHECK (settling_entry_id <> settled_entry_id),
  CONSTRAINT ea_pair_once  UNIQUE (settling_entry_id, settled_entry_id)
);

CREATE INDEX ea_settled_idx  ON entry_applications (settled_entry_id);
CREATE INDEX ea_settling_idx ON entry_applications (settling_entry_id);
```

This replaces the prototype's `appliedTo: string[]` array and **is** Accounts Receivable and
Accounts Payable. There is no `invoices` balance column and no `bills` table; open items are
computed. The rule, straight from `openItems` in `ledger.js`:

> An entry that has **any** application rows pointing outward — i.e. it settles something —
> is never itself an open item. It is a settlement or an adjustment *of* that document.

That single condition is what stopped an upward variance adjustment (which credits 2102 just
like a bill does) being counted both as its own open bill and as a reduction of the one it
adjusts. Without it the open-items total drifts above the control account it is meant to
reconcile against.

### `accounting_periods`

```sql
CREATE TYPE period_status AS ENUM ('open','closed');

CREATE TABLE accounting_periods (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  year       integer NOT NULL,
  month      integer NOT NULL CHECK (month BETWEEN 1 AND 12),
  status     period_status NOT NULL DEFAULT 'open',
  closed_at  timestamptz,
  closed_by  uuid REFERENCES users(id),

  CONSTRAINT ap_unique UNIQUE (year, month)
);
```

**New — the prototype has no period concept at all.** It is required here because month-end
depreciation, an AR sweep and a real audit trail all assume a period can be finalised. What
"closed" means is deliberately minimal for now: no entry may be dated inside it. It does
*not* yet imply a closing entry rolling income into retained earnings — see
[07 — Open questions](./07-open-questions.md).

---

## Database-enforced invariants

Four triggers. These are the reason the books survive a bad client.

### 1. Entries must balance — deferred constraint trigger

```sql
CREATE OR REPLACE FUNCTION assert_entry_balanced() RETURNS trigger AS $$
DECLARE d numeric(18,2); c numeric(18,2); n integer;
BEGIN
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*)
    INTO d, c, n
    FROM journal_lines WHERE entry_id = COALESCE(NEW.entry_id, OLD.entry_id);

  IF n = 0 THEN RETURN NULL; END IF;            -- entry deleted wholesale; nothing to check
  IF n < 2 THEN
    RAISE EXCEPTION 'entry % has % line(s); at least 2 required',
      COALESCE(NEW.entry_id, OLD.entry_id), n;
  END IF;
  IF d <> c THEN
    RAISE EXCEPTION 'entry % out of balance: debit % <> credit %',
      COALESCE(NEW.entry_id, OLD.entry_id), d, c;
  END IF;
  RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_lines_balanced
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_entry_balanced();
```

`DEFERRABLE INITIALLY DEFERRED` is essential: lines are inserted one at a time, so the entry
is legitimately unbalanced mid-transaction. The check runs at COMMIT.

Note `d <> c` — **exact**, not `abs(d - c) < 1`. `NUMERIC` is exact arithmetic; the
prototype's one-rupiah tolerance was a float workaround and is not carried into balance
validation. It *is* carried into materiality, which is a different thing entirely
(see [03](./03-accounting-rules.md#money-and-materiality)).

### 2. Journals are append-only

```sql
CREATE OR REPLACE FUNCTION forbid_journal_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries are never deleted; post a reversal instead';
  END IF;
  -- The single permitted update: stamping the reversal back-reference.
  IF NEW.* IS DISTINCT FROM OLD.* THEN
    IF (to_jsonb(NEW) - 'reversed_by_id') IS DISTINCT FROM (to_jsonb(OLD) - 'reversed_by_id') THEN
      RAISE EXCEPTION 'journal entries are immutable; only reversed_by_id may be stamped';
    END IF;
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE TRIGGER journal_entries_immutable
  BEFORE UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_journal_mutation();
```

A parallel trigger on `journal_lines` forbids UPDATE and DELETE outright.

This makes inherited ruling 1 — *journals are never edited or deleted* — a property of the
database rather than a convention. The client asked for it explicitly: the proposal calls
for "eliminating the option of unilateral journal deletion to maintain audit trail
integrity."

### 3. Used accounts are locked

A `BEFORE UPDATE OR DELETE` trigger on `accounts`:

- **UPDATE** — if any `journal_lines` reference this code, refuse a change to `code` or
  `type`. Changing `name`, `group_label`, `active`, `is_cash` remains allowed. Retyping an
  account with history would silently move posted transactions onto a different financial
  statement.
- **DELETE** — refuse if any `journal_lines` reference it, or if it has children. The error
  names deactivation as the alternative.

### 4. Closed periods reject postings

A `BEFORE INSERT` trigger on `journal_entries` refusing any `entry_date` whose
`(year, month)` is `closed`.

---

## Numbering

The prototype derives every identifier from a list length:

```js
id: `PO-${3001 + get().purchaseOrders.length}`     // useStore.js
id: `CL-${String(clients.length + 1).padStart(2,'0')}`
```

That collides after any delete and races under any concurrency. Two replacement tables:

```sql
CREATE TABLE document_sequences (
  key        text PRIMARY KEY,     -- 'journal_entry' | 'invoice' | 'purchase_order' | …
  prefix     text NOT NULL,        -- 'JE' | 'INV' | 'PO'
  pad        integer NOT NULL,     -- 4 -> INV-0045
  next_value bigint NOT NULL
);

CREATE TABLE voucher_series (
  key        text PRIMARY KEY,     -- 'km' | 'kk' | 'rm' | 'fa' | 'rev' | 'exp' | 'jv'
  prefix     text NOT NULL,
  label      text NOT NULL,
  hint       text,
  format     text NOT NULL,        -- '[PREFIX]-[MONTH]-[DATE]-[SEQ_001]'
  reset      text NOT NULL,        -- 'monthly' | 'yearly' | 'daily' | 'never'
  CONSTRAINT vs_format_has_seq CHECK (format ~ '\[SEQ_[0-9]+\]'),
  CONSTRAINT vs_prefix_present CHECK (length(btrim(prefix)) > 0)
);

CREATE TABLE voucher_counters (
  series_key  text NOT NULL REFERENCES voucher_series(key),
  period_key  text NOT NULL,       -- '2026-08' | '2026' | '2026-08-14' | 'all'
  next_value  bigint NOT NULL DEFAULT 1,
  PRIMARY KEY (series_key, period_key)
);
```

Both are allocated with `SELECT … FOR UPDATE` inside the posting transaction, so two
concurrent postings cannot mint the same `KM-09-04-001`. The `vs_format_has_seq` check moves
the prototype's `updateVoucherSeries` validation — *reject a format lacking a `[SEQ_nnn]`
token* — into the schema.

**Already-issued numbers are never rewritten**, even if the administrator later changes the
format. `voucher_no` is stored on the entry, not computed on read; the entry is immutable;
the property follows for free.

Format tokens and the `pickSeries` auto-classification rules are specified in
[03](./03-accounting-rules.md#voucher-numbering).

---

## Idempotency

Four operations in the prototype are guarded by in-memory booleans that a stateless API
cannot rely on. Each gets real database enforcement.

| Operation | Prototype guard | Replacement |
|---|---|---|
| `runDepreciationPeriod(period)` | `asset.postedThrough` | `je_source_once_idx` on `('depreciation', '2026-08')` — the period *is* the key |
| `disburseIncentives(amount, project)` | `incentivesPaid` flag | `je_source_once_idx` on `('payroll', 'INC-<project_id>')` |
| `confirmDownPayment()` | `dpConfirmed` flag | `UNIQUE (quotation_id)` on `projects` — a quotation converts once |
| `_ensureBillRaised(po)` | `_billFor(poId)` lookup | partial unique index: one live, unapplied `('po', <po_no>)` bill per PO |

Mutating `POST` endpoints additionally accept an optional `Idempotency-Key` header, recorded
in a small `idempotency_keys` table with the response, so a retried request after a dropped
connection returns the original result rather than posting twice.

---

## Part 2 — Everything else

Grouped by domain package. Columns given as name/type; constraints noted where they carry
business meaning rather than plumbing.

### Masters

**`users`** — `id`, `email` unique, `password_hash` (argon2), `full_name`, `initials`,
`role` (`ceo|finance|pm|sales|warehouse`), `active`, `last_login_at`.
*New — the prototype has no users at all; `role` is a single string in the store, switched
from the topbar. The 5 roles and their display names port from `roles.js`.*

**`tax_config`** — `key` PK (`pph23|pph21|ppn|corporate`), `label`, `rate` `numeric(6,3)`,
`active`, `account_code` (nullable — corporate tax has none).

**`company_settings`** — a single-row table: `budget_tolerance_pct` (default 10),
`bonus_threshold` (default 7.0), `petty_cash_opening` (default 40 000 000), `materiality`.
These live as loose store fields in the prototype.

**`tags`** — `id` (slug), `label`. Join tables `vendor_tags` and `catalogue_item_tags`.
Deleting a tag cascades to both, matching `deleteTag`.

### Projects

**`projects`** — `id`, `project_no` unique (`EVT-2026-GALA-01`), `name`, `client_id` FK,
`stage` enum (the 7 `STAGES`), `division`, `contract_value`, `estimated_cost`, `event_date`,
`pm_user_id`, `stage_since`, `quotation_id` FK unique, `cancelled`, `cancelled_at`,
`cancel_reason`, `dp_refunded`.

> **`realized_cost` is deliberately absent.** The prototype caches it on the project and keeps
> it in step inside `postEntry`; `docs/ERP-Feedback-Analysis-and-Fix-Plan.md` already lists
> this as known gap #4. Here it is a query over `journal_lines` where the account is a
> project-cost account (`type = 'cogs'` or code `6901`). The invariant that
> `verify-ledger §8` asserts must still hold — it just holds by construction.

**`project_stage_history`** — `project_id`, `stage`, `entered_at`, `by_user_id`. *New; the
prototype keeps only `stageSince`, which cannot answer "how long were we in Client Approval".*

**`client_feedback`** — `project_id`, `score` `numeric(3,1)`, `submitted_at`.

### AR

**`clients`** — `id`, `client_no` (`CL-01`), `name`, `contact`, `email`, `phone`, `birthday`
text, `anniversary` text, `personal_brand`, `fav_vendor`, `satisfaction` `numeric(2,1)`.
*Birthday and anniversary stay free text (`'28 Jul'`, `'01 Mar 2019'`, `'—'`) — the prototype
treats them as display strings and the birthday cron does a string match. Converting them to
dates is a data-cleanup exercise, flagged in [07](./07-open-questions.md).*

**`client_preferred_events`**, **`client_past_events`** — normalised out of the seed arrays.

**`client_interactions`** — `id`, `client_id`, `interaction_date`, `type`
(`Meeting|Call|Quote sent|Event closed|Anniversary|Note`), `author_user_id`, `note` text,
`edited_at`. The client asked for a free-text note column with no character limit, stamped
with a timestamp and the identity of the staff member who wrote it — hence `author_user_id`
as a real FK rather than the prototype's role-derived display name.

**`quotations`** — `id`, `quotation_no` (`QT-1001`), `client_id`, `mou_template_id`,
`event_type`, `event_date`, `status` (`Draft|Sent|Accepted|Declined`), `created_by_user_id`.
**`quotation_lines`** — `label`, `amount`, `est_cost`. Contract value and margin are summed,
never stored.
**`quotation_dp_stages`** — `stage_no`, `label`, `basis` (`percent|amount`), `value`,
`anchor` (`signing|event`), `offset_days`.

**`mou_templates`** / **`mou_template_clauses`** — `heading`, `validity`, `signatory`;
clauses ordered by `clause_no`. Deleting a template is refused while an Accepted quotation
uses it.

**`invoices`** — `id`, `invoice_no` unique (`INV-0045`), `project_id`, `type`
(`Down Payment|Progress|Final`), `stage_label`, `amount`, `status`
(`Scheduled|Unpaid|Partially Paid|Paid|Cancelled`), `due_date`, `issued_at`, `last_paid_at`.

> **`paid` is deliberately absent**, for the same reason as `realized_cost`. Collected-to-date
> is the sum of applications against the invoice's recognition entry. Storing it invites the
> exact drift that the AR reconciliation badge on the Receivables screen exists to detect.

### AP

**`vendors`** — `id`, `vendor_no` (`V-01`), `name`, `category`, `baseline_price`, `score`,
`delays`, `npwp`, `pph23_rate` `numeric(6,3)` *(overrides the company default)*,
`bank_name`, `bank_account`, `bank_holder`, `pic_name`, `pic_phone`, `pic_email`,
`terms_dp_percent`, `terms_settlement_days`.

**`vendor_catalogue_items`** — `id`, `item_no` (`VI-01`), `vendor_id`, `item`, `category`,
`subcategory`, `unit_price`, `stock` `numeric(12,2)`, `unit`.
**`catalogue_bookings`** — `item_id`, `from_date`, `to_date`, `project_id`, `qty`,
`purchase_order_id` **nullable** — a hold placed without a PO must survive PO cancellation.

**`purchase_orders`** — `id`, `po_no` (`PO-3001`), `vendor_id`, `project_id`, `status`
(`Draft|Approved|DP Paid|Settled|Cancelled`), `order_date`, `event_date`,
`terms_dp_percent`, `terms_settlement_days`, `dp_paid_at`, `settled_at`, `actual_total`.
**`purchase_order_lines`** — `catalogue_item_id`, `item_label`, `qty` `numeric(12,2)`
*(fractional — the seed has `17.5` m² of LED wall)*, `unit_price`.

> **There is no `bills` table.** A payable *is* a journal entry crediting 2102, and AP is
> derived via open items on that control account. Ageing metadata rides on the entry
> (`source_due`, `source_vendor_id`) precisely so that an overhead bill with **no** purchase
> order still ages correctly — the seed contains one (`BILL-0012`, Meridian Tech).

**`vendor_attachments`** — `vendor_id`, `attachment_id`, `kind`
(`Pricelist|Catalogue|Agreement|Certificate`).

### Cash and procurement

**`procurement_requests`** — `id`, `request_no` (`PR-101`), `project_id`, `category`,
`amount`, `status` (`Draft|Pending|Approved|Disbursed|Completed|Rejected`),
`requested_by` **NOT NULL**, `requested_by_user_id`, `request_date`, `actual`, `variance`,
`settled_at`.

> `requested_by NOT NULL` is a client requirement, not tidiness: the round-2 proposal asks
> for a mandatory Requester Name field to "eliminate anonymous transactions in petty cash
> recording", and the prototype refuses an explicitly blank requester with the message
> *petty cash cannot be issued anonymously*.

**`procurement_receipts`** — `request_id`, `attachment_id`. At least one is required to
settle an advance.

**`budgets`** / **`budget_categories`** — `project_id`; `key`, `label`, `ceiling`.
*`realized` is not stored — it is derived from postings, which is the fix for the prototype's
single hardcoded budget object covering one project only.*

**`attachments`** — `id`, `filename`, `content_type`, `byte_size`, `storage_key`,
`uploaded_by_user_id`, `sha256`. Behind a `StorageBackend` interface with a local-disk
implementation; S3 later without touching callers.
*New — the prototype stores filenames as bare strings and generates placeholder PDFs on
download. Its own vendor screen says outright that real uploads need a storage backend.*

### Assets

**`fixed_assets`** — `id`, `asset_no` (`FA-001`), `name`, `category`, `inventory_item_id`,
`acquired_on`, `cost`, `salvage`, `useful_life_months`, `method`
(`straight-line|declining`), `status` (`active|disposed`), `posted_through` (`'YYYY-MM'`),
`posted_accumulated`, `schedule_from`, `opening_accumulated`, `disposed_at`, `proceeds`.

`schedule_from` and `opening_accumulated` exist solely to make life-revision **prospective**
(inherited ruling 4): revising a useful life rebases the schedule to the first unposted
period and carries accumulated depreciation forward, leaving already-posted charges alone.

### Warehouse (supporting — it posts to the ledger)

**`inventory_items`** — `id`, `item_no` (`IT-01`), `item`, `type`
(`Consumable|Fixed Asset`), `qty`, `unit`, `unit_value`, `status`
(`in_stock|in_transit|maintenance|written_off`), `project_id`, `event_date`, `checked_in`.
**`delivery_orders`** / **`delivery_order_lines`**.

Included because three warehouse actions post journal entries — a lost item debits 6901
Asset Loss Expense, a consumable release debits 5104, a condemned item writes off against
1302/1301 — and the fixed-asset register must shrink in step.

### Payroll

**`crew`** — `id`, `crew_no` (`CR-01`), `name`, `role`, `base_rate`, `last_rating`.
**`incentive_disbursements`** — `project_id`, `amount`, `entry_id`, `disbursed_at`.

*No employee/payslip/PPh 21 payroll module exists in the prototype. Accounts 2103 Crew
Payables and 2107 PPh 21 Payable are in the chart and never posted to. Out of scope; flagged
in [07](./07-open-questions.md).*

### Operations

**`job_runs`** — `job_key`, `run_for` (the period or date the run covers), `started_at`,
`finished_at`, `status`, `detail` jsonb, `UNIQUE (job_key, run_for)`. This is what makes a
scheduled month-end depreciation safe to retry.

**`reminders`** — `client_id`, `kind`, `due_date`, `channel`, `status`, `assigned_to_user_id`.

**`idempotency_keys`** — `key`, `endpoint`, `request_hash`, `response` jsonb, `created_at`.

---

## Entity relationships, condensed

```
users ──posts──> journal_entries ──has──> journal_lines ──> accounts
                        │  ▲                                     │
                        │  └── entry_applications ──┘            └── parent_code (1 level)
                        │        (settles / settled_by)
                        ├── project_id ──> projects ──> clients
                        ├── source_vendor_id ──> vendors
                        └── series ──> voucher_series ──> voucher_counters

clients ──> quotations ──> quotation_lines
                 │    └──> quotation_dp_stages ──resolve──> invoices (one per stage)
                 └──> mou_templates ──> mou_template_clauses

projects ──> invoices            (AR: open items on 1201)
projects ──> purchase_orders ──> purchase_order_lines ──> vendor_catalogue_items
                                                              └──> catalogue_bookings
projects ──> procurement_requests ──> procurement_receipts ──> attachments
projects ──> budgets ──> budget_categories
projects ──> incentive_disbursements ──> crew

fixed_assets ──> inventory_items
vendors ──> vendor_catalogue_items, vendor_attachments
tags ──> vendor_tags, catalogue_item_tags
```

Every arrow into `journal_entries` is a *source* link, never a balance. Nothing downstream of
the ledger stores an amount that the ledger could tell you.

---

## Coverage check

Against `src/store/seed.js`, every seeded entity is accounted for:

`seedAccounts` · `seedJournal` · `seedInvoices` · `seedProjects` · `seedClients` ·
`clientHistory` · `seedQuotations` · `seedMouTemplates` · `seedVendors` ·
`vendorInventories` · `seedTags` · `costEstimator` · `seedPurchaseOrders` ·
`seedProcurement` · `seedBudget` · `seedFixedAssets` · `seedInventory` ·
`seedDeliveryOrders` · `seedCrew` · `seedSales` · `seedTaxConfig` ·
`SEED_VOUCHER_SERIES` · `seedCronJobs` · `pendingDeal`

Two are intentionally not tables: `costEstimator` (a seeded demo comparison, better computed
from the catalogue) and `seedSales` (commission is calculated in the view and never posted —
see [07](./07-open-questions.md)).
