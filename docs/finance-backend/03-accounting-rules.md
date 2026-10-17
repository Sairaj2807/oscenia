# 03 — Accounting Rules

**This is the rulebook.** If any other document contradicts it, this one wins. If the
prototype contradicts this one, the prototype wins and this document has a bug — the
prototype's postings have been reviewed by the client's finance team across two rounds, and
its two verification suites assert them.

Every transaction Oscenia can perform is listed below with its exact debits and credits.

---

## The five inherited rulings

Decided during client feedback rounds 1 and 2, recorded in
`docs/ERP-Feedback-Analysis-and-Fix-Plan.md`. The backend implements them. It does not
quietly revisit them.

### 1. Journals are never edited or deleted

A posted entry is immutable. Corrections are **reverse-and-repost**: the original stays in
the ledger flagged `reversed_by`, a reversal entry mirrors it, and a fresh entry carries the
corrected figures. The client asked for this in as many words — the round-2 proposal calls
for "eliminating the option of unilateral journal deletion to maintain audit trail
integrity."

Enforced by a database trigger, not by convention. See
[02 — Database-enforced invariants](./02-data-model.md#database-enforced-invariants).

### 2. A purchase order is a commitment, not a debt

Approving a PO **posts nothing**. It reserves vendor catalogue stock for the event window and
records a commitment, which the Dashboard shows as shaded budget consumption. The payable is
raised lazily, at the moment of first payment or settlement.

This was changed during round 1 after raising the bill at approval pushed the company into an
apparent loss: every approved-but-unstarted order was being recognised as cost immediately.

### 3. Scheduled billing stages are excluded from AR

When a quotation is accepted, one invoice is minted per DP stage — but only the first is
issued. The rest sit at status `Scheduled`, have posted nothing, and are **excluded from
Accounts Receivable**. They appear in their own "Scheduled Billing" table.

A plan is not a debt. Counting scheduled stages would put the AR total permanently out of
step with control account 1201, and the reconciliation badge on the Receivables screen would
never read *Reconciled*.

### 4. Revising an asset's useful life is prospective

Changing `useful_life_months` or `method` on an asset that has already been depreciated does
**not** restate posted charges. The schedule rebases to the first unposted period
(`schedule_from`) carrying accumulated depreciation forward (`opening_accumulated`), and the
asset still finishes exactly on `cost − salvage`.

`cost`, `posted_through` and `posted_accumulated` can never be patched — cost is evidenced by
the acquisition entry, and the other two are the ledger's own record of what was posted.

### 5. PPh 23 runs in both directions and is never netted

The single most load-bearing rule in the system, and the one that was **backwards in round 1**
and fixed in round 2. It moved reported revenue, margin and NPAT.

```
MONEY IN — the client withholds from us          MONEY OUT — we withhold from the vendor
─────────────────────────────────────────        ────────────────────────────────────────
Recognition                                      Bill raised
  Dr  1201  Accounts Receivable    GROSS           Dr  5101  Event COGS — Vendors   GROSS
  Cr  4101  Event Revenue DP       GROSS           Cr  2102  Vendor Payables        GROSS

Receipt                                          Payment
  Dr  1101  Main Bank Cash         NET             Dr  2102  Vendor Payables        GROSS
  Dr  1401  Prepaid Tax — PPh 23   TAX             Cr  2105  PPh 23 Payable         TAX
  Cr  1201  Accounts Receivable    GROSS           Cr  1101  Main Bank Cash         NET

1401 is an ASSET.  Tax withheld FROM us,          2105 is a LIABILITY.  Tax withheld BY us,
creditable against our own tax bill.              owed onward to the tax office.
```

Three consequences that every implementation must preserve:

- **Revenue is recognised GROSS.** Cash arrives NET. The receivable clears at GROSS.
  `cash + prepaid_tax == receivable_cleared`, exactly.
- **1401 and 2105 coexist**, on opposite sides of the Balance Sheet, and are never offset
  against one another.
- The vendor's own `pph23_rate` overrides the company default when set — the seed has
  Bloom & Co at 1.5% against a 2% default. Rate resolution:
  `vendor.pph23_rate ?? tax_config.pph23.rate ?? 0`, and only when `pph23.active`.

---

## The seed chart of accounts

27 accounts. `is_cash` drives Total Cash and the cash-movement report; `tax_key` links an
account to a tax configuration entry.

| Code | Name | Type | Group | Flags |
|---|---|---|---|---|
| 1101 | Main Bank Cash | asset | Cash & Bank | `is_cash` |
| 1102 | Cash on Hand | asset | Cash & Bank | `is_cash` |
| 1103 | Petty Cash | asset | Cash & Bank | `is_cash` |
| 1201 | Accounts Receivable | asset | Receivables | **AR control** |
| 1301 | Inventory — Consumables | asset | Inventory & Equipment | |
| 1302 | Inventory — Fixed Assets | asset | Inventory & Equipment | |
| 1303 | Accumulated Depreciation | asset | Inventory & Equipment | `is_contra` |
| 1401 | Prepaid Tax — PPh 23 | asset | Prepaid Taxes | `tax_key=pph23` |
| 2101 | Unearned Revenue | liability | Payables & Accruals | *unused — see [07](./07-open-questions.md)* |
| 2102 | Vendor Payables | liability | Payables & Accruals | **AP control** |
| 2103 | Crew Payables | liability | Payables & Accruals | *unused* |
| 2105 | PPh 23 Payable | liability | Tax Payables | `tax_key=pph23` |
| 2106 | PPN Payable | liability | Tax Payables | `tax_key=ppn`, *unused* |
| 2107 | PPh 21 Payable | liability | Tax Payables | `tax_key=pph21`, *unused* |
| 3101 | Retained Earnings | equity | Equity | |
| 3102 | Paid-in Capital | equity | Equity | |
| 4101 | Event Revenue DP | revenue | Event Revenue | |
| 4102 | Event Revenue | revenue | Event Revenue | |
| 5101 | Event COGS — Vendors | cogs | Direct Event Costs | |
| 5102 | Event COGS — Crew | cogs | Direct Event Costs | |
| 5103 | Event COGS — Logistics | cogs | Direct Event Costs | |
| 5104 | Event COGS — Consumables | cogs | Direct Event Costs | |
| 6101 | Office Overhead | opex | Overheads | |
| 6102 | Salaries (non-event) | opex | Overheads | |
| 6103 | Depreciation Expense | opex | Depreciation | |
| 6901 | Asset Loss Expense | opex | Asset Losses | |
| 7101 | Tax Expense | tax | Tax | |

Account types carry a normal side and a statement:

| Type | Normal side | Statement | Executive group |
|---|---|---|---|
| asset | debit | balance | Assets |
| liability | credit | balance | Liabilities |
| equity | credit | balance | Equity |
| revenue | credit | income | Revenue |
| cogs | debit | income | Cost of Sales (COGS) |
| opex | debit | income | Operating Expenses |
| tax | debit | income | Tax |

**Project cost accounts** — what counts against a project's P&L — are
`type = 'cogs'` **or** code `6901`. Asset Loss Expense is an operating expense
company-wide but is absolutely a cost of the job that destroyed the equipment. This must be a
single definition used by both the Project P&L and any realised-cost calculation; in the
prototype it was once duplicated, and a warehouse write-off silently pushed the two out of
step by the loss amount.

---

## Tax configuration

| Key | Label | Rate | Active | Account |
|---|---|---|---|---|
| `pph23` | PPh 23 — Service withholding | 2% | **yes** | 2105 / 1401 |
| `pph21` | PPh 21 — Employee withholding | 5% | no | 2107 |
| `ppn` | PPN — Value Added Tax | 11% | no | 2106 |
| `corporate` | Corporate Income Tax | 22% | **yes** | — (never posted) |

`withholding(gross, key)` returns `{rate, amount = round(gross × rate / 100), net}`, or
`{0, 0, gross}` when inactive.

**Corporate tax is computed, never posted.** It is derived live from `tax_config` in the
Income Statement, so changing the rate immediately moves Tax Expense and NPAT. That is the
"customizable tax section… manual override options prior to displaying Tax Expense & Net
Profit" the client's roadmap asked for. Any manually posted `type = 'tax'` lines are added
**on top** of the computed provision.

---

## Money and materiality

Two distinct thresholds, historically conflated by the prototype's single `EPSILON = 1`.

| | Value | Applies to |
|---|---|---|
| **Balance tolerance** | **exactly `0.00`** | An entry's debits must equal its credits precisely. `NUMERIC` is exact arithmetic; no tolerance is needed or permitted. |
| **Materiality** | `Decimal("1.00")` | A document with less than Rp 1 outstanding counts as **settled**. A statement line worth less than Rp 1 is **not printed**. |

Materiality is a business rule, defined once in `app/core/money.py` and used in exactly three
places, mirroring `ledger.js`:

1. `open_items()` — an item whose raised amount or remaining outstanding is below materiality
   is not open (`ledger.js:274, 295`)
2. statement line filters — Income Statement and Balance Sheet rows (`ledger.js:337, 410, 443`)
3. project cost lines and slice totals

**Rounding.** Half-up to 2 decimals at the point a tax or percentage is computed, never
during accumulation. Two places absorb the rounding remainder deliberately so a total lands
exactly:

- **Billing schedules** — the final DP stage absorbs the remainder, so a phased schedule sums
  to the contract value to the rupiah.
- **Depreciation** — the final period absorbs the remainder, so accumulated depreciation
  lands exactly on `cost − salvage` and never a cent past it.

---

## Voucher numbering

A voucher number is **not** the entry id.

- `entry_no` (`JE-1042`) is the immutable internal key. Applications, reversals and source
  links reference it. Renumbering it would break every existing reference.
- `voucher_no` (`KM-05-10-001`) is the human, auditable document number printed on the
  voucher and quoted in the filing cabinet. It is what the administrator gets to configure.

### Series

| Key | Prefix | Class | Default format | Reset |
|---|---|---|---|---|
| `km` | KM | Cash In (Kas Masuk) | `[PREFIX]-[MONTH]-[DATE]-[SEQ_001]` | monthly |
| `kk` | KK | Cash Out (Kas Keluar) | `[PREFIX]-[MONTH]-[DATE]-[SEQ_001]` | monthly |
| `rm` | RM | Reimbursement | `[PREFIX]-[MONTH]-[DATE]-[SEQ_001]` | monthly |
| `fa` | FA | Fixed Asset | `FIXED ASSET (FA) - [MONTH] - [DATE] - [SEQ_001]` | monthly |
| `rev` | REVENUE | Revenue (accrual) | `[PREFIX] - [MONTH] - [DATE] - [SEQ_001]` | monthly |
| `exp` | EXPENSE | Expense (accrual) | `[PREFIX] - [MONTH] - [DATE] - [SEQ_001]` | monthly |
| `jv` | JV | Adjustment Voucher | `[PREFIX]-[MONTH]-[DATE]-[SEQ_001]` | monthly |

### Format tokens

| Token | Expands to | Example |
|---|---|---|
| `[PREFIX]` | the series prefix | `KK` |
| `[YEAR]` | four-digit year | `2026` |
| `[YY]` | two-digit year | `26` |
| `[MONTH]` | two-digit month | `08` |
| `[MON]` | three-letter month | `AUG` |
| `[DATE]` | two-digit day of month | `14` |
| `[SEQ_001]` | sequence, zero-padded to the token's digit width | `007` |

Anything else passes through verbatim, so the client's own example works as written:
`REVENUE - [MONTH] - [DATE] - [SEQ_001]` → `REVENUE - 08 - 14 - 001`. The digit count in the
token declares the width: `[SEQ_00001]` pads to five.

Reset cadences: `monthly` (counter key `YYYY-MM`), `yearly` (`YYYY`), `daily` (`YYYY-MM-DD`),
`never` (`all` — one running counter for the life of the company).

### Validation

- A format **must** contain a `[SEQ_nnn]` token — rejected otherwise.
- A prefix may not be blank.
- **Already-issued numbers are never rewritten** when a format changes.

### Auto-classification

An explicit `series` on a posting always wins. Otherwise, in order:

1. `source_kind` in (`reversal`, `adjustment`, `opening`, `manual`) → **`jv`**
2. `source_kind` = `depreciation` → **`fa`**
3. `source_kind` = `pettycash` **and** `source_settlement` → **`rm`**
   *(a cash-advance settlement is a reimbursement whichever way the money moves)*
4. net movement across cash accounts > 0 → **`km`**; < 0 → **`kk`**
5. no cash moved, so it is an accrual:
   touches a fixed-asset account → **`fa`**; touches a revenue account → **`rev`**;
   otherwise → **`exp`**

**A reversal gets its own voucher number.** It does not reuse the original's.

---

## The transaction catalogue

Notation: `Dr`/`Cr`, account code, amount. `→` marks a linked application row.

### Opening balances

Series `jv`, source `opening`, ref `FY2026`.

```
Dr 1101 Main Bank Cash          420,000,000
Dr 1103 Petty Cash               40,000,000
Dr 1301 Inventory — Consumables  28,200,000
Dr 1302 Inventory — Fixed Assets 640,000,000
  Cr 3102 Paid-in Capital                    200,000,000
  Cr 3101 Retained Earnings                  928,200,000
```

### AR — issuing an invoice

Series `rev`, source `invoice` / the invoice number. Only from status `Scheduled`; issuing
twice is refused. Sets status `Unpaid` and stamps `issued_at`.

```
Dr 1201 Accounts Receivable   gross
  Cr 4101 Event Revenue DP            gross     -- when type = 'Down Payment'
  Cr 4102 Event Revenue               gross     -- otherwise
```

### AR — receiving a payment

Series `km`, source `payment` / the recognition entry, **applied to** the recognition entry.

```
Dr 1101 (or chosen cash account)   net = gross − tax
Dr 1401 Prepaid Tax — PPh 23       tax
  Cr 1201 Accounts Receivable              gross
→ applied_to: the recognition entry
```

Rules:

- Gross is **clamped to outstanding** — an overpayment is not a bigger receipt.
- Withholding may be **waived** (`withhold = false`) or **manually overridden**
  (`tax_amount`), which the UI warns about. Tax greater than the payment is refused.
- Refuses on a `Scheduled` invoice, and on one with nothing outstanding.
- Status becomes `Paid` when collected ≥ amount − materiality, else `Partially Paid`.

### AR — confirming a client down payment

The headline automation. **One transaction, two linked entries**, plus a project and one
invoice per billing stage.

```
1. Recognition   series rev, source invoice/INV-xxxx
     Dr 1201                     gross
       Cr 4101                            gross

2. Receipt       series km, source payment/<entry 1>
     Dr 1101                     net
     Dr 1401                     tax
       Cr 1201                            gross
   → applied_to: entry 1
```

Side effects, all in the same transaction: the project is created at stage `DP Paid`;
invoices are minted for every stage of the resolved DP schedule, stage 1 `Paid` and the rest
`Scheduled`. Confirming twice is a no-op.

### AR — undoing a down payment

A structured rollback, **refused** if the project has any other posting or any live purchase
order. Reverses *both* halves, then deletes the project and its invoices. Cash returns
exactly to where it started.

### AP — raising a vendor bill

Series `exp`, source `po` / the PO number, with `source_due = order_date + settlement_days`
and `source_vendor_id` set. Raised **lazily**, at first payment — never at approval
(ruling 2). Idempotent.

```
Dr 5101 Event COGS — Vendors   po_total
  Cr 2102 Vendor Payables               po_total
```

An overhead bill with no purchase order posts the same shape against 6101 and still ages,
because ageing rides on `source_due`, not on a PO record.

### AP — paying a vendor bill

Series `kk`, source `payment`, applied to the bill entry.

```
Dr 2102 Vendor Payables    gross
  Cr 2105 PPh 23 Payable            tax    -- at the VENDOR's rate
  Cr 1101 Main Bank Cash            net
→ applied_to: the bill entry
```

Clamped to outstanding. **No cost is recognised again** — the expense was recognised when the
bill was raised. Afterwards the originating PO's status syncs to `Settled` if the payment
clears the balance, else `DP Paid`.

### AP — settling a purchase order at a different actual

Accepts a PO in `DP Paid` **or** `Approved` (a zero-DP order never reaches `DP Paid` but must
still be settleable). `variance = committed − actual`, positive meaning under budget.

```
variance > 0  (came in under)     Dr 2102   variance    Cr 5101   variance
variance < 0  (came in over)      Dr 5101  |variance|   Cr 2102  |variance|
→ applied_to: the bill entry     (series exp)
```

Then the remaining payable is paid as above — or, if the order was overpaid, refunded:

```
Dr 1101 Main Bank Cash      amount − tax
Dr 2105 PPh 23 Payable      tax               -- withholding unwound
  Cr 2102 Vendor Payables            amount
```

Project cost ends on the **actual**, and no payable is left behind. Settling twice is refused.

### AP — cancelling a purchase order

Reverses the **payments first, then the bill** — order matters, because reversing the bill
first would leave payments applied to a reversed document. Releases only this PO's own
catalogue reservations, leaving holds placed without a PO alone.

### Cash — petty cash top-up

Series `kk`, source `pettycash` / `TOPUP`. Total cash is unchanged; it only moves between
accounts.

```
Dr 1103 Petty Cash        amount
  Cr 1101 Main Bank Cash            amount
```

### Cash — procurement disbursement

Fires on the transition to `Disbursed`. Routing depends on whether the category matches
`/petty|cash advance/i`:

```
petty:      Dr 5103 Event COGS — Logistics   Cr 1103 Petty Cash
otherwise:  Dr 5101 Event COGS — Vendors     Cr 1101 Main Bank Cash
```

The line note carries the **requester's name** — this is the traceability the client asked
for, and it is why a blank requester is refused.

### Cash — settling a cash advance

Series `rm`, source `pettycash` with `source_settlement = true`.
`variance = requested − actual`, positive meaning money comes back.

```
returning a surplus:   Dr 1103 Petty Cash   variance    Cr 5103   variance
claiming a shortfall:  Dr 5103              |variance|  Cr 1103   |variance|
```

At least one receipt attachment is required to settle.

### Payroll — disbursing crew incentives

Series `kk`, source `payroll` / `INC-<project>`. **A project tag is mandatory** — without it
the cost lands on no P&L at all, and the operation is refused with nothing posted. Idempotent.

```
Dr 5102 Event COGS — Crew    pool
  Cr 1101 Main Bank Cash              pool
```

Bonus formula: `base_rate × (rating ÷ 10)`, paid only when `rating ≥ bonus_threshold`
(policy default 7.0, editable). Once a post-event client rating exists, every crew member is
scored on that one event rating; before then each falls back to their own last rating.

### Fixed assets — capitalisation

Series `fa`, source `depreciation` / the asset number, dated `acquired_on`.

```
Dr 1302 Inventory — Fixed Assets   cost
  Cr <cash account or 2102>                 cost
```

A **"already carried in 1302"** flag suppresses this posting entirely, for registering kit
that is already inside the opening balance. Without it, seeding the register would
double-count 640,000,000.

### Fixed assets — running depreciation for a period

Series `fa`, source `depreciation` / `'YYYY-MM'`, dated the **last calendar day** of the
period.

**One entry per period, with one debit line per asset** — not one entry per asset. Each line
is noted `FA-001 · VIP Sofa (gold)`.

```
Dr 6103 Depreciation Expense   charge      (× one line per asset)
  Cr 1303 Accumulated Depreciation    total for the period
```

- **Idempotent by period.** Running twice posts nothing the second time.
- Backlog clears **oldest period first**.
- Cost in 1302 is never touched — depreciation is not a disposal.
- `register.net_book_value == balance(1302) + balance(1303)` must hold. 1303 is contra, so
  it carries a credit balance and the addition is correct as written.

Schedules: straight-line is `round(base / life)`; declining is double-rate
(`2 / (life / 12)` annually, charged monthly) floored at the straight-line of what remains.
Base is `max(0, cost − salvage − opening_accumulated)`. The final period absorbs the
remainder. Charges are never negative and never take the asset below salvage.

### Fixed assets — disposal

```
Dr 1101 Main Bank Cash             proceeds        (if any)
Dr 1303 Accumulated Depreciation   accumulated     (if any)
Dr/Cr 6901 Asset Loss Expense      loss or gain    -- signed; gains and losses share 6901
  Cr 1302 Inventory — Fixed Assets          cost
```

`loss = net_book_value − proceeds`. The asset stops accruing. Disposing twice is refused.

### Warehouse — postings that reach the ledger

```
Consumable released to a project
  Dr 5104 Event COGS — Consumables   qty × unit_value
    Cr 1301 Inventory — Consumables                  qty × unit_value

Item returned LOST / total damage
  Dr 6901 Asset Loss Expense         loss − accum_share
  Dr 1303 Accumulated Depreciation   accum_share
    Cr 1302 (or 1301 for consumables)                loss

Item in maintenance condemned
  Dr 6901 Asset Loss Expense         value
    Cr 1302 (or 1301)                                value
```

A lost fixed asset also **shrinks the asset register pro rata**, returning its share of
accumulated depreciation so only the net book value hits 6901. This is what keeps the
register tied to 1302/1303.

### Manual entry, adjustment, reversal

**Manual** — series `jv`, source `manual`. Free-form lines; must balance; memo required. Two
guided modes pre-fill from open items:

- *Applied Payment (AR)* — pick an open item on 1201, pre-fills `Dr cash / Cr 1201`
- *Bill Payment (AP)* — pick an open item on 2102, pre-fills `Dr 2102 / Cr cash`

Both record an application row.

**Reversal** — series `jv`, source `reversal`, `reversal_of` set; the original is stamped
`reversed_by`. Every line's debit and credit swap. Gets its own voucher number.

**Adjustment** — reverse **plus** repost with corrected figures, source `adjustment`
referencing the original. The original stays, flagged. Net effect on the books is the
difference only. Re-adjusting an already-reversed entry is a no-op.

---

## Derived statements

Nothing below is stored. All of it is computed from `journal_lines`.

### Trial balance

Sum of all debits and all credits over the filtered set. Balanced when equal — exactly.

### Income Statement

```
Revenue                     Σ balance of every revenue account
− Cost of Sales             Σ balance of every cogs account
─────────────────────────
= Gross Profit
− Operating Expenses        Σ balance of every opex account
─────────────────────────
= Profit Before Tax
− Tax                       posted tax lines + computed corporate provision
─────────────────────────
= NPAT (Net Profit After Tax)

Gross Margin = Gross Profit / Revenue
Net Margin   = NPAT / Revenue
```

Rows below materiality are dropped. The corporate provision is a **derived** row labelled
`Corporate Income Tax (22%)` with no account code behind it.

### Balance Sheet

```
ASSETS                          LIABILITIES
  every asset account             every liability account
                                  + Provision for Income Tax   ← derived
                                EQUITY
                                  3101 + 3102
                                  + Current Period Earnings (NPAT)   ← derived
```

Both derived rows are mandatory. There is no closing entry — income accounts still carry
their balances — so equity picks up the period's profit as a derived line, and because the
tax provision is computed rather than posted it must be added back as a liability. The
identity then holds:

```
A = L + E_open + PBT  ==  (L + tax) + (E_open + PBT − tax)
```

Omit either derived row and the sheet is out by exactly the tax amount.

### Executive roll-up

Statement rows collapse into their account `group_label` buckets, each keeping the codes it
came from so the summary stays drillable. Derived rows stand alone — filing "Provision for
Income Tax" under a bucket would imply a chart entry that does not exist.

### General ledger

Row per matching journal **line**, with:

- **Opening balance** — movements *before* the period start, folded in rather than dropped
- period debits, period credits, running balance
- **Closing balance**, where `opening + movement = closing` must hold

For a single account the running balance flips sign for credit-normal accounts. Consolidated
across all accounts it nets to zero, and the report says so rather than pretending otherwise.

### Open items (AR and AP)

```
AR:  control 1201, opening side = debit
AP:  control 2102, opening side = credit
```

An entry is an open item when: it is not a reversal and has not been reversed; it has **no**
outgoing applications; and its movement on the control account in the opening direction
exceeds materiality. Outstanding is that movement less everything applied against it by
non-reversed entries.

Reversing a payment therefore **reopens** the document it settled, automatically.

### Cash

`Total Cash` is the sum of balances across every account flagged `is_cash` — including
user-created sub-accounts, and including a parent that has become a header. Cash movements
are entries whose net effect across cash accounts is non-zero, with a running balance
computed oldest-first.

### Project P&L

Revenue and cost restricted to entries tagged with the project. Cost lines are the project
cost accounts (cogs + 6901). Comparison modes — month-on-month, year-on-year,
project-on-project, versus budget — must compute both sides through the identical code path,
or the comparison is meaningless.

Margin percentages display to **2 decimal places**, a specific client requirement.

---

## RBAC

Five roles, twenty gated actions, ported verbatim from `src/lib/roles.js`. Enforced
server-side as a FastAPI dependency, not merely used to hide buttons.

| Role | Actions |
|---|---|
| **ceo** | all |
| **finance** | `post_journal`, `manage_coa`, `manage_assets`, `edit_tax`, `approve_cash`, `approve_po`, `pay_po`, `approve_incentive`, `confirm_dp`, `request_po`, `request_advance`, `file_expense`, `revert_stage`, `cancel_project`, `cancel_quotation` |
| **pm** | `request_po`, `request_advance`, `file_expense`, `advance_stage`, `revert_stage`, `manage_stock` |
| **sales** | `cancel_quotation`, `advance_stage`, `edit_client`, `request_po` |
| **warehouse** | `manage_stock`, `add_stock`, `manage_do`, `request_advance`, `file_expense` |

The governing principle, from the client's own deck: **a Project Manager may request, but
never approve or pay.** Approving cash and posting journals are restricted to Finance.

A denial names the roles that *are* permitted, rather than returning a bare 403.

---

## Period close

New in the backend; the prototype has no period concept.

- Periods are `(year, month)` and default to `open`.
- Closing a period refuses any subsequent entry dated inside it.
- Closing requires the `post_journal` action and records who closed it and when.
- Reopening is permitted but logged.
- Closing does **not** yet post a closing entry rolling income into retained earnings. The
  Balance Sheet's derived-equity approach depends on income accounts still carrying their
  balances, so introducing a real close is a change to the statement logic as well. Parked in
  [07 — Open questions](./07-open-questions.md).
