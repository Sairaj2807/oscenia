# 06 — Test Specification

## The principle

**We are not writing new tests. We are porting an existing, proven specification.**

`erp-frontend/scripts/verify-ledger.mjs` (12 invariants) and
`erp-frontend/scripts/verify-flows.mjs` (67 sections, 1,702 lines) already encode what
correct behaviour means for this business. They were written against two rounds of client
feedback and they caught eleven real bugs during the prototype build — including the PPh 23
direction being backwards, a variance adjustment being double-counted as its own open bill,
and a PO cancellation that reversed the bill but not the payments.

Those assertions are the acceptance criteria for the backend. A phase is done when its slice
is green, and a phase whose slice is red is not done regardless of how complete the code
looks.

Two things change in the port, and only two:

1. **They run against HTTP and Postgres**, not against a Zustand store in Node. Where the
   original calls `store.receivePayment(...)`, the port calls
   `POST /api/v1/invoices/{id}/payments`. This is the point — it tests the real boundary.
2. **Money is `Decimal`.** Assertions that read `Math.abs(a - b) < 1` become exact equality
   where they were guarding float error, and stay as an explicit materiality comparison where
   they were expressing "under a rupiah does not matter". Getting that distinction right per
   assertion is the main intellectual work of the port. See
   [03 — Money and materiality](./03-accounting-rules.md#money-and-materiality).

Everything else — the scenarios, the numbers, the edge cases — transfers verbatim.

---

## Harness

```
tests/
  conftest.py                    fixtures: db, client, users per role, frozen clock
  factories.py                   builders for accounts, entries, projects, vendors
  test_ledger_invariants.py      port of verify-ledger.mjs
  test_triggers.py               NEW — the database invariants
  test_flows_*.py                port of verify-flows.mjs, split by domain
```

**Database.** A real Postgres, migrated once per session. Each test runs inside a
transaction rolled back at teardown.

**The deferred-trigger wrinkle.** The balance trigger is `INITIALLY DEFERRED` and fires at
COMMIT, which a rolled-back test never reaches. Two fixtures are needed:

- `db` — the normal case: `SAVEPOINT` per test, rollback at teardown
- `db_immediate` — issues `SET CONSTRAINTS ALL IMMEDIATE`, for the tests that assert an
  unbalanced entry is *rejected*

Without the second, "posting an unbalanced entry raises" would pass vacuously.

**The clock.** `app.core.clock.now` is overridden per test. The prototype's fixed
`DEMO_TODAY = '2026-07-26'` is the default so that ported ageing assertions keep their
original numbers.

**`assert_books(label)`** — the helper every flow section ends with in the original, and must
here too:

```python
async def assert_books(client, label: str):
    tb = await get("/reports/trial-balance")
    assert tb["balanced"], f"{label}: trial balance out by {tb['difference']}"
    bs = await get("/reports/balance-sheet")
    assert bs["balanced"], f"{label}: A != L + E, out by {bs['difference']}"
```

This is what makes the suite worth having. Any operation, anywhere, that quietly breaks
double entry is caught by the next section that runs.

---

## Part 1 — Ledger invariants (`verify-ledger.mjs`)

Twelve invariants proving the **seed data** is sound. In the port they run against the
database after `python -m app.seed.demo`.

| § | Invariant | Phase | Notes on the port |
|---|---|---|---|
| 1 | Every entry balances individually | 1 | Becomes exact `==`, not `< EPSILON` |
| 2 | Trial balance: total debits = total credits | 1 | Exact |
| 3 | Income Statement: revenue > 0, NPAT > 0 | 3 | |
| 4 | Balance Sheet: Assets = Liabilities + Equity | 3 | Exact. Requires both derived rows |
| 5 | Cash reconciliation; **1103 = exactly 28,300,000** | 1, 6 | Float 40M less PR-101 8.5M and PR-102 3.2M |
| 6 | Ledger 1201 = Σ unpaid invoices (465,000,000) | 4 | Scheduled stages excluded |
| 7 | Σ(qty × unit_value) of live fixed-asset stock = 1302 (640,000,000) | 7 | |
| 8 | Per-project posted cost = the project's realised cost | 3 | **Changes meaning:** the cache is gone, so this asserts the *query* equals the itemised breakdown |
| 9 | Company weighted margin sits between 25% and 35% | 3 | Cost basis = realised if Finished, else max(estimated, realised) |
| 10 | Tax config drives NPAT; the sheet balances at 0%, 22% and 40% | 3 | |
| 11 | Reversing an entry cancels it out exactly | 1 | Cash returns by net DP, 1401 unwinds by the tax, 1201 reopens at gross |
| 12 | **PPh 23 direction** | 4, 5 | The most important one — detailed below |

### Invariant 12 in full

On a client receipt: two entries, not one; the receipt is applied to the recognition;
revenue is recognised **gross**; cash arrives **net**; tax is debited to **1401**;
**nothing is credited to 2105**; the receivable clears at **gross**; and
`cash + prepaid_tax == receivable_cleared` exactly.

On a vendor bill: the bill raises 2102 without touching cash; cost is recognised at bill
time; payment debits 2102 at gross, credits **2105**, **does not touch 5101 again**, and is
linked by an application row.

Both 1401 and 2105 carry balances simultaneously, and 1401 appears under assets.

---

## Part 2 — Database invariants (new)

Not in the prototype, because a Zustand store has no equivalent. These assert that the
guarantees survive a client that bypasses the service layer entirely — the whole point of
pushing them into Postgres.

`tests/test_triggers.py`, all executing raw SQL:

| Test | Asserts |
|---|---|
| unbalanced entry rejected | direct `INSERT` of lines that do not balance raises at COMMIT |
| single-line entry rejected | an entry needs at least two lines |
| journal `UPDATE` rejected | changing `memo`, `entry_date` or an amount raises |
| journal `DELETE` rejected | raises, naming reversal as the alternative |
| `reversed_by_id` permitted | the one allowed update succeeds |
| line `UPDATE`/`DELETE` rejected | raises |
| both-sided line rejected | `debit > 0 AND credit > 0` violates `jl_one_side` |
| empty line rejected | `debit = 0 AND credit = 0` violates it too |
| negative amount rejected | |
| used account renumber rejected | |
| used account retype rejected | |
| used account delete rejected | |
| account rename permitted | the deliberate exception |
| parent-with-parent rejected | one nesting level only |
| cross-type sub-account rejected | |
| closed-period posting rejected | |
| duplicate voucher number rejected | unique index |
| duplicate depreciation period rejected | the idempotency index |
| concurrent numbering | two parallel transactions posting on the same date produce different voucher numbers — the row-lock test |

---

## Part 3 — Flow sections (`verify-flows.mjs`)

All 67 sections, mapped to a pytest module and a build phase. Every one ends with
`assert_books`.

### `test_flows_ledger.py` — phase 1

| § | Section | Key assertions |
|---|---|---|
| 0 | Baseline | books balance before anything runs |
| 7 | Adjust an entry = reverse + repost | original preserved and flagged; net effect is the difference only; re-adjusting a reversed entry is a no-op |
| 10 | Every entry in the ledger is individually balanced | |
| 20 | Ledger still whole after everything above | |
| 42 | Chart of accounts is editable, and guarded | sub-account inherits `is_cash`; parent becomes a header and stops being postable; **Total Cash unchanged** by opening a sub-account; one nesting level; no cross-type child; a used account cannot be renumbered, retyped or deleted but **can** be renamed |
| 43 | Voucher numbering | every entry carries one; all unique; receipts → KM, disbursements → KK, manual → JV; **a reversal gets its own**; a format without `[SEQ]` is refused; issued numbers are never rewritten |
| 44 | Inter-document linking | an unpaid invoice is an open item, outstanding = raised; after payment it is not; the chain walks both ways; **reversing the payment reopens the invoice** |
| 45 | General Ledger query | single-account GL matches the account balance; consolidated nets to zero; opening carried into a narrow period; `opening + movement = closing` |

### `test_flows_reports.py` — phase 3

| § | Section | Key assertions |
|---|---|---|
| 8 | Tax rate change flows through to NPAT | raising the rate lowers NPAT; disabling makes NPAT = PBT; the sheet holds in every case |
| 9 | Realised cost stays in step with the ledger | ported as: the derived query equals posted COGS per project |
| 30 | Itemised project costs reconcile | itemised total = project cost; **credits appear as negatives, not filtered out** |
| 33 | Period comparison: MoM, YoY, project-on-project | previous-month arithmetic; February and leap years; the event window is **D−2 to D+1, not shifted by timezone** |
| 46 | Executive summarisation keeps the totals honest | rolled-up revenue, COGS and assets equal the detailed figures; every bucket stays drillable |
| 26 | Number formatting follows the language | *frontend-only; port only the rounding half* |

### `test_flows_permissions.py` — phase 2

| § | Section | Key assertions |
|---|---|---|
| 17 | Action-level permissions | a PM may request but **not** approve a PO, pay one, post journals or approve cash; Finance may; the CEO may everything; a denial names the permitted role |
| 37 | PM access matches the deck | a PM cannot reach the company ledger at all |

### `test_flows_ar.py` — phase 4

| § | Section | Key assertions |
|---|---|---|
| 1 | Quotation accepted → pending deal | DP honours the quotation's own percentage; estimated cost comes from line-level estimates |
| 2 | Confirm DP → project, invoice, the corrected PPh 23 pair | invoice numbers unique across confirmations; both entries balanced; receipt linked to recognition; revenue gross; withholding → 1401, **not** a payable; cash +net; AR nets to zero; **confirming twice is a no-op** |
| 2b | Undo still works now the DP is a pair | removes the project, reverses **both** halves, cash returns to start |
| 31 | Down-payment rollback | undo is **refused** once a cost has posted; the reversal stays in the ledger |
| 47 | Phased DP schedules resolve exactly | **every preset bills the contract to the rupiah**; presets round-trip; awkward contract values still total exactly |
| 48 | Accepting a phased quote drafts the billing schedule | one invoice per stage; stage 1 settled, later stages `Scheduled`; **a scheduled stage has posted nothing** |
| 49 | Issuing a scheduled stage raises the receivable | issuing twice refused |
| 50 | Receiving payment — the AR bug | part payment: cash +net, 1401 +tax, 1201 −gross, status `Partially Paid`; **overpayment clamped**; a settled invoice refuses further payment; a scheduled stage refuses payment |
| 51 | Withholding can be waived or overridden | manual override honoured; tax greater than the payment refused |
| 52 | AR reconciles with the ledger | outstanding invoices equal 1201, **scheduled stages excluded** |
| 25 | Quotation editing | refused once Accepted; editing a Sent quote returns it to Draft |
| 27–29 | MoU templates | user-managed; editable; **deleting one in use by an Accepted quotation is refused** |
| 14 | Stage revert | cannot revert past the first stage |
| 15 | Project cancellation, refundable vs not | non-refundable keeps revenue; refundable reverses it out; cancelling twice is a no-op |
| 32 | Board drag-and-drop moves | multi-column moves land on the right stage |
| 18 | CRM editing | |
| 34 | Client notes: create, edit, attach, delete | |
| 64 | CRM notes carry the real author | the note records who actually wrote it |

### `test_flows_ap.py` — phase 5

| § | Section | Key assertions |
|---|---|---|
| 11 | Purchase orders: approve → DP → settle | **approval raises no payable and recognises no cost**; the first payment raises the bill for the full order value; 2102 moves by the unpaid remainder; cash leaves net at the **vendor's** rate; payment linked to bill; settlement **does not expense the cost twice** |
| 12 | Date-aware availability | fully booked inside the window, free outside; excluding the owning project frees it; adjacent ranges do not overlap |
| 13 | Cancelling a PO reverses its payments | cost unwound; reservation released |
| 19 | Vendor rate override | the vendor's own rate beats the company default |
| 21–24 | Tags | vocabulary; **AND filtering**; apply and remove; deleting cascades to vendors and catalogue |
| 35 | Vendor attachments | |
| 36 | Vendor gain/loss variance | settles below committed; paid reports the actual; cost ends on the actual; **no payable left behind**; settling twice refused |
| 59 | Accounts Payable reconciles with the ledger | open bills equal 2102; every open bill carries a due date; **a bill with no PO still ages** |
| 60 | The AP bug: a zero-DP order used to be unsettleable | never reaches `DP Paid`, still settleable |
| 61 | Paying a bill from the Payables screen | lands in KK; payable falls by gross; withholding **credited to 2105, not debited to 1401**; cash leaves net; **no cost recognised again**; overpayment clamped; a settled bill refuses further payment |
| 62 | Both withholding directions coexist | 1401 > 0 as an asset, 2105 > 0 as a liability, on the correct sides |
| 63 | Cancelling a purchase order unwinds the whole chain | reverses the bill **and** the payment — filtering on source `po` alone was the bug; payable gone; cost unwound |

### `test_flows_cash.py` — phase 6

| § | Section | Key assertions |
|---|---|---|
| 4 | Petty cash top-up moves money between accounts | 1103 up, 1101 down, **total cash unchanged**; the derived balance agrees with the ledger; zero or negative rejected |
| 5 | Procurement: approve → disburse → settle | settlement records actual, variance, receipts (blank filenames dropped) and settled-at; unused funds return to the float |
| 16 | Budget tolerance warning | an over-budget project is flagged **once** |
| 65 | Petty cash cannot be issued anonymously | a blank requester is refused; an omitted one defaults to the signed-in user; the requester's name reaches the journal line note |

### `test_flows_assets.py` — phase 7

| § | Section | Key assertions |
|---|---|---|
| 3 | Warehouse write-off posts Asset Loss Expense | quantity split by condition; loss at qty × unit value; the inventory account falls by the same amount; split ids do not collide |
| 38 | Consumables: the other half of dual-logic | |
| 39 | Maintenance is not a dead end | repaired posts nothing; condemned posts a write-off |
| 53 | Depreciation schedules are exact | each asset runs its full life, **lands exactly on cost − salvage**, never goes below salvage, all charges non-negative; declining charges more early |
| 54 | The register reconciles with the ledger | register cost = 1302; `net_book_value == 1302 + 1303` |
| 55 | The depreciation run clears the backlog | **one entry per period, not per asset**; all in the FA series; 6103 rises by the whole backlog; 1303 mirrors it; **cost untouched**; nothing due afterwards; **running again posts nothing** |
| 56 | Capitalisation | `post: false` posts nothing to 1302 |
| 57 | Revising a useful life re-plans the future, not the past | posted depreciation untouched; rebased to the first unposted period; still finishes on salvage; cost cannot be edited |
| 58 | Disposal removes the asset from the books | cost out of 1302, accumulated out of 1303, shortfall to 6901; the asset stops accruing; disposing twice refused |

### `test_flows_payroll.py` — phase 7

| § | Section | Key assertions |
|---|---|---|
| 6 | Crew incentives disburse to the ledger | crew COGS and pool; cost allocated to the project; double disbursement blocked |
| 40 | Crew incentives: mandatory project allocation | **disbursing without a project tag is refused and nothing is posted** |
| 41 | Bonus threshold is policy, not a constant | clamped 0–10 |

---

## Coverage ledger

| Suite | Items | Mapped |
|---|---|---|
| `verify-ledger.mjs` | 12 invariants | 12 |
| `verify-flows.mjs` | 67 sections (0–65 plus 2b) | 67 |
| New database-invariant tests | 19 | 19 |

Section 26 (number formatting) is the only one ported partially — the locale half is
frontend behaviour with no server equivalent; the rounding half is kept.

---

## Running

```bash
pytest -q                              # everything
pytest tests/test_ledger_invariants.py # the seed is sound
pytest tests/test_triggers.py          # the database defends itself
pytest -k "phase1 or ledger"           # one phase
pytest -m slow                         # the full-life depreciation runs
```

Phases are marked, so `pytest -m phase4` runs exactly what phase 4 must satisfy.

## What is not covered, and why

- **PDF rendering.** Asserted for content (the right totals reach the generator), not for
  layout.
- **The React UI.** Out of scope until the rewire phase. Worth noting that the prototype has
  the same gap and it cost them: `SettleModal` in `PurchaseOrders.jsx:193` throws a
  `ReferenceError` on click, and no suite catches it because the suites call the store action
  directly. When the rewire happens, it needs component-level tests, not only these.
- **Load and concurrency beyond the numbering test.** One row-lock test proves the mechanism;
  sustained concurrency testing is a separate exercise if volume ever justifies it.
