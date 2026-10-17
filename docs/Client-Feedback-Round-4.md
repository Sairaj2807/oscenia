# Client feedback — round 4 (5 Oct 2026)

Received after the round-3 deploy (https://oscenia-web.vercel.app/erp). Verbatim where quoted.

1. **Guest table number: free text** — "for the table, just make it we can freely write it". Screenshot: Events → Wibowo–Sari Wedding → Guests & RSVP, where the Table column is a dropdown limited to `— / T1 … T5`.
2. **Journal system** (screenshot: Finance → Accounting, a long list of auto-posted entries such as "DP invoiced", "DP received", "Payment received", "Final invoiced", plus reversals and adjustments):
   1. "The journal module is currently too cluttered, with many unnecessary journal entries appearing. Please implement a pop-up feature; for instance, when a client makes a down payment or a vendor payment is processed, the system should open a pop-up window displaying the journal entry prior to posting, allowing for edits to the journal details or tax information."
   2. "Please include two date fields—whether in the journal or the transaction pop-up—one for the date on the receipt and the other for the date the receipt was received; financial reports should be based on the date the receipt was received."

## Notes
- A real finance backend exists (`erp-backend/`, see `docs/Developer-Handover.md` §1 and §8). Journal posting, reversal and adjustment, and confirming a down payment, are wired to it. Any change to journal fields (the two dates) affects that API as well as the prototype.
- Plan and status: `docs/Client-Feedback-Round-4-Plan.md` once approved.

## Status (5 Oct 2026)

All items are built on `feature/pm-events-prototype`. The client-facing walkthrough is `docs/Prototype-Demo-Guide.md` §0000.

| Item | What was built | Commits |
|---|---|---|
| 1. Guest table: free text | Guests & RSVP and Check-in take any table (trimmed, max 30 characters) with suggestions from the event's tables and those already typed; saves on blur/Enter, Esc restores. A half-typed table is saved, not dropped, when the check-in desk switches guest. | `360fc8e`, `6c7c035` |
| 2.1 Journal too cluttered | Journal tab: type chips, search (voucher, memo, project), "Hide reversed pairs" on by default with a hidden count and "Show them". Only a plain pair hides; a reversal chain (E1 → R1 → R2) stays visible. Reports still read every entry. | `09ff9fc`, `6c7c035` |
| 2.1 Pop-up before posting, editable | Client DP, receive payment, pay bill, pay vendor DP (new pop-up) and settle PO open an editable entry first: both dates, memo, cash account, PPh 23, lines. Must balance; the 1201/2102 control line is locked; no other line may touch 1201 or 2102 (or a sub-account); companions are read-only. Same guard in the prototype (`lib/postings.js`) and the backend (`ledger/overrides.py`). 1201/2102 cannot take sub-accounts. Toasts report the PPh 23 that actually posted. | `ff90b56`, `274d79b`, `da57a8e`, `6c7c035`, `43169ff` |
| 2.2 Two dates | "Date on receipt" and "Date received (used in reports)" on every money pop-up and the manual entry/adjust dialogs. Received date = posting date (`entry_date`), which every report uses; receipt date = `source.documentDate` / `source_document_date`. Journal list and drawer show both. | `ff90b56`, `274d79b`, `da57a8e` |

### Known limits
- **Live backend: the memo is read-only.** None of the money endpoints takes a memo, so on a live backend the pop-up shows the server's memo. In the offline demo it is editable.
- **Live journal period buttons count from the demo date** (2026-07-26, `DEMO_TODAY`), not the real date.
- **Pay bill and settle PO were not exercised live end-to-end in a browser.** They are covered by the adapter tests (`verify:adapters`) and backend pytest (573 passed).
- **"Mark accepted" on a quotation is browser-only** (pre-existing gap: quotation create/send/accept are not wired to the API).
