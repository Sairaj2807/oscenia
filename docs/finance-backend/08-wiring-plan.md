# Wiring the React app to the API

> The backend is built and proven standalone — 494 tests, 106 endpoints. This is the phase
> the whole sequencing was for. Read [04 — API contract](./04-api-contract.md) alongside it.

## What we are working with

| | |
|---|---|
| 25 pages, 9 components | every one reads from a single Zustand store |
| `src/store/useStore.js` | 2,638 lines, ~70 actions, seeded from `seed.js` |
| `src/lib/ledger.js` | 527 lines — the pages derive statements, ageing and P&L **client-side** |
| 10 pages | import `lib/ledger.js` directly and compute their own numbers |

The store is read through selectors — `useStore((s) => s.projects)` — 24 times for projects,
22 for `role`, 13 for `journal`, and so on down a long tail.

## The approach, and why

**Replace what is behind the store, not the store itself.**

Every page reads collections through selectors. If the *shape* of those collections stays the
same and only their *source* changes — from `seed.js` to the API — then 25 pages keep working
untouched. That is the difference between a wiring job and a rewrite, and it is available here
only because the prototype happened to be built with one store rather than scattered state.

So the intermediate state is a fully working app on real data, and each later phase is
independently revertible. The alternative — rewriting pages to call endpoints directly — has
no working intermediate state at all.

**Client-side derivation stays until it is replaced deliberately.** `lib/ledger.js` computes
the balance sheet from `journal`. Once `journal` is fetched rather than seeded, that math
still works, on real data. Phase W4 then swaps each screen to the server's report endpoints —
and while both exist we have an **oracle**: the client's answer and the server's must agree,
and any screen where they do not is a bug worth finding before the client sees it.

## Phases

| # | Phase | Deliverable |
|---|---|---|
| **W1** | **API client & auth** | `lib/api.js`, real login, JWT + refresh, route guard. The role switcher becomes real re-authentication |
| W2 | Hydration | the store loads every collection from the API; loading and error states |
| W3 | Mutations | each store action posts to the API and re-reads what changed. **Done** for every action with an endpoint (branch `feature/finance-w3`); the actions with no endpoint answer "Not saved". Guarded by `npm run verify:writes` |
| W4 | Server-derived reports | the 10 deriving pages move to report endpoints, cross-checked against the client math. **done** (R0-R3 parity script, project-costs endpoint, report adapters; R4 all pages switched; R5 dev cross-check `window.__reportDiffs`; parity now 88/0) |
| W5 | Cleanup | retire `seed.js`, dead store code, and re-point the verify scripts |

## Decisions taken

**Field naming is converted at the boundary.** The API is `snake_case`; the pages expect
`camelCase` (`unitValue`, `postedThrough`, `voucherNo`). A deep converter in `lib/api.js`
translates both directions, so neither side has to bend to the other and no page changes. The
alternative — renaming fields in 25 pages — is a large diff that buys nothing.

**Zustand stays.** React Query would be the better default for a greenfield app, but adopting
it means touching every page's data access, which is exactly the cost this plan exists to
avoid. The store keeps its selector surface and grows explicit `hydrate*` actions.

**`role` keeps its selector, and starts meaning something.** It is a store field the user can
switch today. It becomes the role of the signed-in user, read from `/auth/me` — so all 22
`useStore((s) => s.role)` call sites keep working, and the answer is now the server's rather
than the client's opinion. The Topbar role switcher signs in as that role's demo user, which
keeps the demo affordance and makes it honest: a Project Manager cannot approve because the
server refuses, not because the UI hides the button.

**Money stays a string until it is displayed.** The API serialises `NUMERIC(18,2)` as a
string precisely so it does not pass through a float. The converter must not "helpfully"
parse it — `Number("640000000.00")` is exact today and will not be forever.

## Constraint worth stating

The backend is **not deployed**. Wiring targets `http://localhost:8000` via `VITE_API_URL`,
so a wired build runs locally against a local Postgres. The Vercel deployment continues to
serve the in-memory prototype until a backend host is chosen — which is a decision, not an
oversight, and belongs with the client.
