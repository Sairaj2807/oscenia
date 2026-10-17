# Client feedback round 4: plan

## Context
The client's round-4 feedback is saved verbatim in `docs/Client-Feedback-Round-4.md`:
1. **Guest table number should be free text.** Today the Guests & RSVP and Check-in screens limit it to a dropdown of `T1…T5`.
2. **Journal:**
   - (a) Too cluttered.
   - (b) Show the journal entry in a pop-up **before posting** a client down payment or a vendor payment, so the user can **edit the details, tax and lines**.
   - (c) Two dates: the **date on the receipt** and the **date it was received**. Reports must use the received date.

What exploration found:
- **The pop-up and the two dates were partly built in round 1, but the client can't see them working.**
  - `ConfirmPostingModal` + `useConfirmPosting` only fetch lines from the live backend, so the Vercel demo shows a "needs a live backend" notice.
  - It's read-only, and covers only DP confirm, invoice issue and PO settle.
  - Receive Payment and Pay Bill show a fixed, non-editable list of lines.
  - Pay vendor DP posts with no pop-up at all.
  - The second date (`source.documentDate`) exists only on invoice issue and PO settle.
- **Reports already bucket by the posting date (`entry.date`)**, in both the prototype `lib/ledger.js` and the backend `reports/queries.py` (`entry_date`). The posting date is the received date. So the received-date rule holds already; it needs labelling and the second date captured everywhere money moves.
- **Clutter:** every money event writes two entries (accrual, then a linked payment). Reverse adds one more entry and adjust adds two. The journal tab (`Accounting.jsx:1202-1257`) has no source filter and doesn't hide reversed pairs.
- **The backend** (`erp-backend/`) already supports `?dry_run` previews and `source_document_date`.
  - Missing: dry-run on receive-payment and pay-vendor-DP; a document date on the DP and payment endpoints; tax-amount override on the AP and DP endpoints; client-edited lines.
  - Also a bug: `ledger/router.py:142` drops `source.document_date` on manual entries.
  - Entries are append-only, so there's no draft state. "Preview → edit → post" means a second call with the edited body.

Decisions confirmed with the user:
- **Full editing** in the pop-up (dates, memo, account, tax, lines), with guardrails.
- **Update the backend too.**
- This reverses the round-1 "post, then Adjust" decision recorded in `docs/finance-backend/STATUS.md:174-186`.

Work happens on `feature/pm-events-prototype`, built by fresh agents in sequence, each unit with checks and a commit, followed by a fresh-context review. Then push and deploy (`npx vercel --prod --yes` from `oscenia-web/`), and also commit the already-written `docs/Developer-Handover.md`, updated for this round.

---

## Unit 1: free-text guest table (small)
- `src/components/events/GuestsTab.jsx` (lines ~160, ~215) and `src/components/events/CheckInTab.jsx` (~168): replace the `<select>` with a text input plus a `<datalist>` of suggestions. Suggestions are `event.tables` plus every table already typed for that event's guests. The value saves on blur or Enter.
- `src/store/useProto.js` `setGuestTable` (~1160): trim the value, cap it at 30 characters, and accept any text.
- `addGuests` / CSV import already take free text (`useProto.js:1153`, `lib/events.js:225`).
- Check-in toasts and exports already show `g.table`.

## Unit 2: journal pop-up and two dates in the prototype
**One editable, guarded entry per money movement.** The movement is the receipt or payment line itself. The companion accrual entries ("DP invoiced", "Vendor bill", PO variance) are shown read-only in the same pop-up, because invoices and POs depend on them.

- **New pure module `src/lib/postings.js`.** Its planners return what would post, without posting:
  - `planDpConfirm`, `planReceivePayment`, `planPayBill`, `planPayPoDp`, `planSettlePo`
  - Each is built from the line logic now inside `useStore.js` (`confirmDownPayment` ~959, `receivePayment` ~1618, `payVendorBill` ~2563, `_payVendor`/`payPoDownPayment` ~2670-2739, `settlePurchaseOrder` ~2758) and reuses `withholding()` from `lib/ledger.js:515`.
  - Each plan returns: `{ companions:[entry], editable:{ memo, date (received), documentDate (receipt), lines, cashAccount, withhold, taxAmount, locked:{account, side, amount} } }`.
  - `validateEdited(plan, edited, accounts)` checks:
    - debits equal credits
    - every line has an existing, active account and a non-negative amount, with exactly one side set
    - the locked control line keeps its account and amount: 1201 Receivable for client money, 2102 Payable for vendor money. This keeps open items, invoices and POs consistent.
    - both dates are valid ISO, and the receipt date isn't after the received date (a warning, not a block)
- **Store actions** accept an optional edited payload, e.g. `receivePayment(id, { …, edited })`.
  - With `edited`: validate it, then post exactly those lines, with `source.documentDate` set.
  - Without it: today's behaviour, so existing flows and checks keep working.
  - Actions that post to the live backend send the same fields (Unit 3).
- **New shared `src/components/PostingModal.jsx`**, replacing `ConfirmPostingModal.jsx`:
  - Fields: **Date on receipt** and **Received date** (used by reports), memo, cash/bank account, PPh 23 withholding on/off plus amount, and an editable lines table (account dropdown from the chart of accounts, debit, credit, note, add/remove line).
  - A live **balanced / not balanced** indicator, the locked control line shown with a 🔒, and read-only companion entries above.
  - **Lines rebuild while the user hasn't touched them.** Changing tax, amount or account rebuilds the lines from the plan. Once a line is edited by hand, the lines freeze; "Reset to calculated" rebuilds them again.
  - **Works in the demo:** offline it uses the local plan. On the live backend it seeds from the server dry-run (`previewPosting`, `useStore.js:254`), then posts the edited body.
- **Wired into all five money pop-ups:**
  - DP confirm: Finance `DealCard` (`Finance.jsx:95,124-135`)
  - Receive Payment: `ReceivePaymentModal.jsx`; its static "This will post" table is replaced
  - Pay Bill: `Payables.jsx:34-136`
  - **Pay vendor DP:** `PoPipeline.jsx:155`. This is new; it currently posts immediately.
  - Settle PO: `PoPipeline.jsx:28-127`
  - Invoice issue keeps its existing dialog, upgraded to the new component for consistency.
  - **Its labels stay "Main date (used in reports)" / "Invoice date"**, because a sales invoice we issue isn't something "received". The receipt / received wording applies to money in and money out:
    - client DP and payments: "Date on receipt" / "Date received"
    - vendor DP, bill payment and settle: "Date on vendor receipt/invoice" / "Date received"
- **Two dates everywhere money is recorded:**
  - The manual journal entry and Adjust dialog (`Accounting.jsx:106-381`, `JournalEntryModal`) get a receipt-date field.
  - The journal list shows **Received** (posting) date, with the receipt date as a second line when it differs. The entry drawer shows both.
  - The period filter states "by received date".
  - Reports stay on `entry.date` (verified), labelled "Received date".

## Unit 3: backend (`erp-backend/`) to match
- **Bug fix:** `app/domain/ledger/router.py:142` passes `source.document_date` through to `PostSource`.
- **`document_date`** goes on `ConfirmDpRequest` (`ar/schemas.py:331`), `PaymentRequest` (AR receive payment), `PayRequest` (`ap/schemas.py:200`) and the pay-DP request. It's passed into each posting's source as `source_document_date`.
- **`?dry_run`** is added to `POST /invoices/{id}/payments` (`ar/router.py:688`) and `POST /purchase-orders/{id}/pay-dp` (`ap/router.py:404`), using the existing `preview.py` savepoint pattern, the same as `pay_bill`.
- **`tax_amount`** override is added to `PayRequest`, the PO settle request, the pay-DP request and `ConfirmDpRequest`, as `PaymentRequest` already has.
- **Optional `lines`** (a list of `JournalLineIn`) is added to those same requests. The service replaces the computed lines of the payment/receipt entry with the submitted ones after a guard:
  - the movement on the control account (1201/2102) must equal the computed gross
  - the accounts must exist and be active
  - the database trigger still enforces balance and closed periods
  - companion accrual entries are never replaced
- **Preview output** (`PreviewEntryOut`, `as_preview_out` in `ledger/schemas.py:133-170`) also returns `source_document_date`.
- **No new date column.** `entry_date` is the received date and `source_document_date` is the receipt date. Reports already use `entry_date`, so no migration is needed. The change is documented in `docs/finance-backend/STATUS.md`, as REQ-05 v2 and REQ-01 extended.
- **Tests:**
  - Add pytest cases: the document date is stored and returned; dry-run on the two endpoints posts nothing; a tax override works; edited lines post; a tampered control-line amount is refused (422); an unbalanced edit is refused.
  - Run the suite against the `docker compose up -d db` Postgres (host port 5433) using the existing `erp-backend/.venv`.
  - **Checked: Docker 28.3 is installed but its engine isn't running.** The agent first tries to start Docker Desktop. If it can't, it stops and I ask you to start Docker Desktop. Backend changes are never reported as tested without a real pytest run.
- **Frontend wiring:**
  - `receivePayment` and `payVendorBill` currently never call the API; they now call `POST /invoices/{id}/payments` and `POST /bills/{entry_id}/payments`.
  - All five flows send `documentDate`, `taxAmount` and `lines` when edited.
  - `adaptPreview` (`adapters.js:455`) maps `sourceDocumentDate`.
  - `scripts/verify-api.mjs` gets cases for the new fields. It needs a live backend; run it if the backend can be started.

## Unit 4: less journal clutter
- **Journal tab** (`Accounting.jsx` ~1146-1257):
  - **Type filter chips:** All · Client invoices · Client payments · Vendor bills · Vendor payments · Manual · Assets & stock · Corrections.
  - A **"Hide reversed pairs"** switch, **on by default**. It hides an entry that was reversed together with its reversal, since they net to zero. A count shows how many are hidden, with one click to show them.
  - **Search** by voucher number, memo or project.
  - The filters are remembered per browser.
- **Reports and balances are unaffected.** They still use every entry; only the list view filters.
- Optionally, the entry drawer already groups the linked documents, so it gets a "Show linked entries" link from each row.

## Then: docs, review, ship
- `docs/Prototype-Demo-Guide.md`:
  - a new **"What's new (round 4)"** table with *How to check* for each item
  - updated §5.4 (tables) and the finance/accounting sections
- `docs/Client-Feedback-Round-4.md`: a status section.
- `docs/Developer-Handover.md`: update the journal, backend wiring and known-limits sections for this round, then commit it. It is currently uncommitted.
- `docs/finance-backend/STATUS.md`: note the change from read-only to editable posting.
- `dict.js`: Indonesian for the new strings.
- A fresh-context **review agent** checks the units for defects, with special care on the posting guardrails and the backend `lines` override. Fix what it confirms.
- Rebuild `/erp`, push `feature/pm-events-prototype`, deploy, and confirm the live bundle hash.

## Verification
- `npm run verify` (ledger, flows, adapters, proto, AI). New checks:
  - **Planners:** each planner's lines equal what today's action posts. Guards that must refuse: unbalanced, changed control amount, inactive account, a negative amount, or both sides set on one line.
  - **Posting:** an edited post carries `source.documentDate`. A no-edit post is unchanged, so existing `journal.length` deltas still hold.
  - **Journal list:** the "hide reversed pairs" filter leaves report totals untouched.
  - **Table:** free text saves, trimmed and capped.
- `npm run verify:render`, plus `npx vite build`, plus `PREVIEW_PORT=<free> npm run verify:mobile`. Add a mobile shot of the posting pop-up.
- **Backend:** `pytest` (full suite, plus the new tests), and `npm run verify:api` against a running backend if it can be started.
- **Browser walk-through** (Playwright, offline demo):
  - Confirm DP → pop-up shows lines → edit the received and receipt dates and the tax → post → journal shows the entry with both dates.
  - Pay vendor DP now opens the pop-up.
  - An unbalanced edit disables Post.
  - The journal "hide reversed pairs" toggle works.
  - Guest table accepts "VIP-1" and the check-in desk shows it.
  - Look at the screenshots.
- **After deploy:** curl `https://oscenia-web.vercel.app/erp/` and check the bundle hash.
