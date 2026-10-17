// Self-check for the derived ledger.
//
// The Income Statement and Balance Sheet are no longer hand-authored — they are
// computed from seedJournal via lib/ledger.js. That means a bad posting shows up
// as a wrong statement rather than a crash, so this script asserts the
// invariants that must always hold: every entry balances, debits = credits,
// Assets = Liabilities + Equity, and the seed data ties to the ledger.
//
// Run: npm run verify:ledger   (plain node, no bundler)
import { seedJournal, seedTaxConfig, seedProjects, seedInvoices, seedInventory } from '../src/store/seed.js'
import * as ledger from '../src/lib/ledger.js'
import { projectMargin } from '../src/lib/format.js'

const fmt = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

console.log('\n=== 1. Every entry balances individually ===')
for (const e of seedJournal) {
  const d = ledger.entryDebit(e)
  const c = ledger.entryCredit(e)
  check(`${e.id} ${e.memo}`, ledger.isBalanced(e), `D ${fmt(d)} / C ${fmt(c)}`)
}

console.log('\n=== 2. Trial balance ===')
const tb = ledger.trialBalance(seedJournal)
check('debits = credits', tb.balanced, `D ${fmt(tb.debit)} / C ${fmt(tb.credit)}`)

console.log('\n=== 3. Income Statement ===')
const is = ledger.incomeStatementFrom(seedJournal, seedTaxConfig)
console.log('  Revenue          ', fmt(is.totalRevenue))
console.log('  COGS             ', fmt(is.totalCogs))
console.log('  Gross Profit     ', fmt(is.grossProfit), `(${is.grossMargin.toFixed(2)}%)`)
console.log('  Opex             ', fmt(is.totalOpex))
console.log('  Profit Before Tax', fmt(is.profitBeforeTax))
console.log('  Tax Expense      ', fmt(is.totalTax), `(rate ${is.taxRate}%)`)
console.log('  NPAT             ', fmt(is.npat), `(${is.netMargin.toFixed(2)}%)`)
check('revenue > 0', is.totalRevenue > 0)
check('NPAT positive', is.npat > 0)

console.log('\n=== 4. Balance Sheet ===')
const bs = ledger.balanceSheetFrom(seedJournal, seedTaxConfig)
bs.assets.forEach((r) => console.log('  A', r.code, r.label.padEnd(32), fmt(r.amount)))
console.log('    Total Assets'.padEnd(40), fmt(bs.totalAssets))
bs.liabilities.forEach((r) => console.log('  L', r.code, r.label.padEnd(32), fmt(r.amount)))
console.log('    Total Liabilities'.padEnd(40), fmt(bs.totalLiabilities))
bs.equity.forEach((r) => console.log('  E', r.code, r.label.padEnd(32), fmt(r.amount)))
console.log('    Total Equity'.padEnd(40), fmt(bs.totalEquity))
check('Assets = Liabilities + Equity', bs.balanced, `difference ${fmt(bs.difference)}`)

console.log('\n=== 5. Cash reconciliation ===')
ledger.cashByAccount(seedJournal).forEach((c) => console.log('   ', c.code, c.name.padEnd(20), fmt(c.balance)))
const cash = ledger.cashBalance(seedJournal)
console.log('    Total Cash'.padEnd(30), fmt(cash))
check('cash non-negative', cash > 0)
const petty = ledger.accountBalance(seedJournal, '1103')
check('petty cash = 28,300,000 (float 40M less PR-101 + PR-102)', Math.abs(petty - 28_300_000) < 1, fmt(petty))

console.log('\n=== 6. AR ties to unpaid invoices ===')
const ar = ledger.accountBalance(seedJournal, '1201')
const unpaid = seedInvoices.filter((i) => i.status === 'Unpaid').reduce((a, i) => a + i.amount, 0)
check('ledger AR = sum(unpaid invoices)', Math.abs(ar - unpaid) < 1, `AR ${fmt(ar)} vs invoices ${fmt(unpaid)}`)

console.log('\n=== 7. Fixed-asset inventory ties to account 1302 ===')
const invValue = seedInventory
  .filter((i) => i.type === 'Fixed Asset' && i.status !== 'written_off')
  .reduce((a, i) => a + i.qty * i.unitValue, 0)
const acct1302 = ledger.accountBalance(seedJournal, '1302')
check('sum(qty x unitValue) = 1302', Math.abs(invValue - acct1302) < 1, `stock ${fmt(invValue)} vs ledger ${fmt(acct1302)}`)

console.log('\n=== 8. Per-project posted cost vs realizedCost ===')
for (const p of seedProjects) {
  const posted = ledger.projectCosts(seedJournal, p.id).reduce((a, r) => a + r.amount, 0)
  check(`${p.id} posted cost = realizedCost`, Math.abs(posted - p.realizedCost) < 1,
    `posted ${fmt(posted)} vs seed ${fmt(p.realizedCost)}`)
}

console.log('\n=== 9. Project margins (the metric fix) ===')
let contract = 0
let basis = 0
for (const p of seedProjects) {
  const cost = p.stage === 'Finished' ? p.realizedCost : Math.max(p.estimatedCost, p.realizedCost)
  contract += p.contractValue
  basis += cost
  console.log(`    ${p.id.padEnd(20)} ${projectMargin(p).toFixed(2)}%  (${p.stage})`)
}
const companyMargin = ((contract - basis) / contract) * 100
console.log('    Company weighted margin:', companyMargin.toFixed(2) + '%')
check('company margin between 25% and 35%', companyMargin > 25 && companyMargin < 35, companyMargin.toFixed(2) + '%')

console.log('\n=== 10. Tax config drives NPAT ===')
const zeroTax = ledger.incomeStatementFrom(seedJournal, { ...seedTaxConfig, corporate: { rate: 0, active: false } })
check('turning corporate tax off raises NPAT to PBT', Math.abs(zeroTax.npat - zeroTax.profitBeforeTax) < 1,
  `NPAT ${fmt(zeroTax.npat)} = PBT ${fmt(zeroTax.profitBeforeTax)}`)
const bsZero = ledger.balanceSheetFrom(seedJournal, { ...seedTaxConfig, corporate: { rate: 0, active: false } })
check('balance sheet still balances with tax off', bsZero.balanced, `difference ${fmt(bsZero.difference)}`)
const bsHigh = ledger.balanceSheetFrom(seedJournal, { ...seedTaxConfig, corporate: { rate: 40, active: true } })
check('balance sheet still balances at 40% tax', bsHigh.balanced, `difference ${fmt(bsHigh.difference)}`)

console.log('\n=== 11. Reversal cancels an entry out ===')
// JE-1052 is the cash half of the Aurora Gala down payment. Since round 2 a DP
// is a linked PAIR — JE-1002 raises the receivable, JE-1052 collects it — so
// the entry that moves the bank is the receipt, and it moves by the NET amount
// because the client withheld PPh 23 at source.
const target = seedJournal.find((e) => e.id === 'JE-1052')
const rev = ledger.buildReversal(target, 'JE-9001')
check('reversal is balanced', ledger.isBalanced(rev))
const withRev = [...seedJournal, rev]
const dpGross = 144_000_000
const dpTax = Math.round(dpGross * 0.02)
const dpNet = dpGross - dpTax
check('bank balance returns to pre-entry level',
  Math.abs(ledger.accountBalance(withRev, '1101') - (ledger.accountBalance(seedJournal, '1101') - dpNet)) < 1,
  `net ${fmt(dpNet)}`)
check('reversing the receipt unwinds the prepaid tax credit too',
  Math.abs(ledger.accountBalance(withRev, '1401') - (ledger.accountBalance(seedJournal, '1401') - dpTax)) < 1)
check('and it reopens the receivable',
  Math.abs(ledger.accountBalance(withRev, '1201') - (ledger.accountBalance(seedJournal, '1201') + dpGross)) < 1)
check('trial balance holds after reversal', ledger.trialBalance(withRev).balanced)
check('balance sheet holds after reversal', ledger.balanceSheetFrom(withRev, seedTaxConfig).balanced)

console.log('\n=== 12. PPh 23 on money received is an ASSET, not a payable ===')
// The correction the client asked for. Cash arrives NET, the withheld tax is a
// creditable prepaid asset, and the receivable clears at GROSS. The first
// version had this backwards: cash in at gross, tax credited to 2105 Payable,
// revenue understated by the withholding.
const recognition = seedJournal.find((e) => e.id === 'JE-1002')
const receipt = seedJournal.find((e) => e.id === 'JE-1052')
const lineOn = (entry, code) => entry.lines.find((l) => l.account === code)

check('the down payment is two entries, not one', Boolean(recognition && receipt))
check('the receipt points back at the invoice it settles', receipt.appliedTo.includes(recognition.id))
check('revenue is recognised GROSS, not net of tax',
  Math.abs(lineOn(recognition, '4101').credit - dpGross) < 1, fmt(lineOn(recognition, '4101').credit))
check('cash arrives NET of withholding',
  Math.abs(lineOn(receipt, '1101').debit - dpNet) < 1, fmt(lineOn(receipt, '1101').debit))
check('the withheld tax is debited to 1401 Prepaid Tax',
  lineOn(receipt, '1401')?.debit === dpTax, fmt(dpTax))
check('nothing is credited to 2105 Payable on a client receipt',
  !receipt.lines.some((l) => l.account === '2105'))
check('the receivable clears at GROSS',
  Math.abs(lineOn(receipt, '1201').credit - dpGross) < 1)
check('cash + prepaid tax = receivable cleared',
  Math.abs(lineOn(receipt, '1101').debit + lineOn(receipt, '1401').debit - lineOn(receipt, '1201').credit) < 1)

// The mirror case must be untouched: when Oscenia withholds from a VENDOR the
// tax is still a payable, because Oscenia owes that money to the tax office.
//
// A vendor transaction is also a pair since round 2 — JE-1007 raises the bill,
// JE-1057 settles it — so the withholding lives on the payment half, exactly
// as the client receipt's does.
const vendorBillEntry = seedJournal.find((e) => e.id === 'JE-1007')
const vendorPay = seedJournal.find((e) => e.id === 'JE-1057')
check('a vendor bill raises a payable rather than paying cash',
  vendorBillEntry.lines.some((l) => l.account === '2102' && l.credit > 0)
  && !vendorBillEntry.lines.some((l) => l.account === '1101'))
check('the cost is recognised when the bill is raised',
  vendorBillEntry.lines.some((l) => l.account === '5101' && l.debit > 0))
check('the payment clears the payable at gross',
  vendorPay.lines.some((l) => l.account === '2102' && l.debit > 0))
check('a vendor payment still credits 2105 Payable',
  vendorPay.lines.some((l) => l.account === '2105' && l.credit > 0))
check('the payment does not double-count the cost',
  !vendorPay.lines.some((l) => l.account === '5101'))
check('and it is linked to the bill it settles', vendorPay.appliedTo.includes('JE-1007'))
check('so both directions coexist on the balance sheet',
  ledger.accountBalance(seedJournal, '1401') > 0 && ledger.accountBalance(seedJournal, '2105') > 0,
  `prepaid ${fmt(ledger.accountBalance(seedJournal, '1401'))} / payable ${fmt(ledger.accountBalance(seedJournal, '2105'))}`)
check('prepaid tax appears as an asset on the balance sheet',
  ledger.balanceSheetFrom(seedJournal, seedTaxConfig).assets.some((r) => r.code === '1401'))


console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'}\n`)
process.exit(failures === 0 ? 0 : 1)
