import { useMemo } from 'react'
import { Wallet, Banknote, ArrowDownRight, ArrowUpRight, Landmark } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PageHeader, Card, TableWrap, money, money2, SectionTitle } from '../components/ui'
import { cashByAccount, cashBalance } from '../lib/ledger'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptCashPosition } from '../store/reportAdapters'
import { CASH_ACCOUNTS } from '../lib/accounts'
import { appToday, formatDate } from '../lib/format'
import { useT } from '../i18n'

const ICONS = { '1101': Landmark, '1102': Banknote, '1103': Wallet }

// Total Cash — the consolidated cash and bank position the deck asked for.
// Balances are derived from the ledger, so confirming a down payment or topping
// up petty cash moves this screen without anything being re-keyed.
export default function Cash() {
  const journal = useStore((s) => s.journal)
  const live = useStore((s) => s.hydrated)
  const t = useT()

  // Signed in, the balances and the total come from the server's cash position (the same answer for
  // every screen and every user); the browser still computes them for the demo, and as a cross-check.
  const report = useReport('/reports/cash-position', {}, adaptCashPosition, { enabled: live })
  const clientAccounts = useMemo(() => cashByAccount(journal), [journal])
  const clientTotal = useMemo(() => cashBalance(journal), [journal])
  const fromServer = live && report.data
  const accounts = fromServer ? report.data.accounts : clientAccounts
  const total = fromServer ? report.data.total : clientTotal
  const asAt = fromServer ? report.data.asOf : appToday()
  useCrossCheck('cash: total', fromServer ? report.data.total : null, clientTotal)

  // Every entry that touches a cash account, newest first, with the net effect
  // on cash for that entry.
  const movements = useMemo(() => {
    return journal
      .map((e) => {
        const net = (e.lines || []).reduce((a, l) => {
          if (!CASH_ACCOUNTS.includes(l.account)) return a
          return a + (Number(l.debit) || 0) - (Number(l.credit) || 0)
        }, 0)
        return net === 0 ? null : { entry: e, net }
      })
      .filter(Boolean)
      .sort((a, b) => (a.entry.date < b.entry.date ? 1 : a.entry.date > b.entry.date ? -1 : 0))
  }, [journal])

  const inflow = movements.filter((m) => m.net > 0).reduce((a, m) => a + m.net, 0)
  const outflow = movements.filter((m) => m.net < 0).reduce((a, m) => a - m.net, 0)

  // Running balance, computed oldest-first then displayed newest-first.
  const withBalance = useMemo(() => {
    const chrono = [...movements].reverse()
    let running = 0
    const stamped = chrono.map((m) => {
      running += m.net
      return { ...m, balance: running }
    })
    return stamped.reverse()
  }, [movements])

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Treasury"
        title="Total Cash"
        subtitle="Consolidated cash and bank position, derived live from the general ledger. Every movement traces back to the journal entry that caused it."
      />

      <Card className="mb-5 border-gold/30 bg-gradient-to-br from-gold/[0.07] to-transparent">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="eyebrow mb-1">{t('Total Cash & Bank')}</div>
            <div className="font-display text-3xl text-gold-light tabular-nums">{money2(total)}</div>
            <div className="text-[11px] text-white/40 mt-1">{t('as at')} {formatDate(asAt)}</div>
          </div>
          <div className="flex flex-wrap gap-6">
            <div>
              <div className="flex items-center gap-1.5 text-xs text-emerald-300">
                <ArrowDownRight size={14} /> {t('Total in')}
              </div>
              <div className="mt-1 text-lg text-white tabular-nums">{money(inflow)}</div>
            </div>
            <div>
              <div className="flex items-center gap-1.5 text-xs text-rose-300">
                <ArrowUpRight size={14} /> {t('Total out')}
              </div>
              <div className="mt-1 text-lg text-white tabular-nums">{money(outflow)}</div>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid sm:grid-cols-3 gap-4">
        {accounts.map((a) => {
          const Icon = ICONS[a.code] || Wallet
          const share = total ? (a.balance / total) * 100 : 0
          return (
            <Card key={a.code}>
              <div className="flex items-center gap-2 mb-2">
                <span className="grid h-9 w-9 place-items-center rounded-lg bg-gold/10 text-gold-light shrink-0">
                  <Icon size={17} />
                </span>
                <div className="min-w-0">
                  <div className="text-sm text-white truncate">{a.name}</div>
                  <div className="font-mono text-[10px] text-gold/60">{a.code}</div>
                </div>
              </div>
              <div className="font-display text-xl text-white tabular-nums">{money2(a.balance)}</div>
              <div className="mt-2 h-1.5 rounded-full bg-white/10 overflow-hidden">
                <div className="h-full rounded-full bg-gold" style={{ width: `${Math.max(0, Math.min(100, share))}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-white/35">{share.toFixed(1)}% {t('of total cash')}</div>
            </Card>
          )
        })}
      </div>

      <SectionTitle icon={Wallet}>{t('Cash Movements')}</SectionTitle>
      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Entry')}</th>
            <th className="th">{t('Date')}</th>
            <th className="th">{t('Memo')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th text-right">{t('In')}</th>
            <th className="th text-right">{t('Out')}</th>
            <th className="th text-right">{t('Balance')}</th>
          </tr>
        </thead>
        <tbody>
          {withBalance.map(({ entry, net, balance }) => (
            <tr key={entry.id}>
              <td className="td font-medium text-white">{entry.id}</td>
              <td className="td text-white/50">{entry.date}</td>
              <td className="td text-white/70">{entry.memo}</td>
              <td className="td font-mono text-xs text-gold/80">{entry.project || '—'}</td>
              <td className="td text-right tabular-nums text-emerald-300">{net > 0 ? money2(net) : '—'}</td>
              <td className="td text-right tabular-nums text-rose-300">{net < 0 ? money2(-net) : '—'}</td>
              <td className="td text-right tabular-nums text-white/80">{money2(balance)}</td>
            </tr>
          ))}
          {!withBalance.length && (
            <tr><td className="td text-white/30" colSpan={7}>{t('No cash movements posted yet.')}</td></tr>
          )}
        </tbody>
      </TableWrap>
    </div>
  )
}
