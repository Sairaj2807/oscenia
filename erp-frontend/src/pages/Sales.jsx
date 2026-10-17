import { useMemo } from 'react'
import { Trophy } from 'lucide-react'
import { useStore } from '../store/useStore'
import { deriveSales } from '../store/adapters'
import { canDo } from '../lib/roles'
import { PageHeader, Card, money, money2 } from '../components/ui'
import { useT } from '../i18n'

const MEDAL = ['text-gold-light', 'text-white/60', 'text-amber-700']

export default function Sales() {
  const seeded = useStore((s) => s.sales)
  const live = useStore((s) => s.hydrated)
  const quotations = useStore((s) => s.quotations)
  const projects = useStore((s) => s.projects)
  const commissionPct = useStore((s) => s.commissionPct)
  const setCommissionPct = useStore((s) => s.setCommissionPct)
  const role = useStore((s) => s.role)
  // Signed in, the board is worked out from the server's accepted quotations; the signed-out demo
  // keeps its seeded rows.
  const sales = useMemo(
    () => (live ? deriveSales(quotations, projects, commissionPct) : seeded),
    [live, quotations, projects, commissionPct, seeded]
  )
  // Subscribes to the language so the numbers below re-format on toggle.
  const t = useT()
  const ranked = [...sales]
    .map((r) => ({ ...r, commission: Math.round(r.contractTotal * (r.commissionPct / 100)) }))
    .sort((a, b) => b.contractTotal - a.contractTotal)

  const top = ranked[0]?.contractTotal || 1

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Commissions"
        title="Sales Report & Leaderboard"
        subtitle="Auto-compiled from Closed/Won projects. Commissions calculated on net contract value."
        actions={canDo(role, 'edit_tax') && (
          <label className="flex items-center gap-2 text-xs text-white/60">
            {t('Commission rate')}
            <input
              type="number" min="0" max="100" step="0.1" defaultValue={commissionPct} key={commissionPct}
              onBlur={(e) => Number(e.target.value) !== commissionPct && setCommissionPct(e.target.value)}
              className="w-16 rounded-lg border border-white/10 bg-navy-900 px-2 py-1 text-right text-sm text-white tabular-nums"
            />
            %
          </label>
        )}
      />

      {!ranked.length && (
        <Card><span className="text-sm text-white/40">{t('No accepted quotations yet.')}</span></Card>
      )}
      <div className="grid gap-3">
        {ranked.map((r, i) => (
          <Card key={r.id} className={i === 0 ? 'border-gold/40' : ''}>
            <div className="flex flex-wrap items-center gap-4">
              <span className={`grid h-10 w-10 place-items-center rounded-full bg-white/5 font-display text-lg ${MEDAL[i] || 'text-white/50'}`}>
                {i === 0 ? <Trophy size={18} /> : i + 1}
              </span>
              <div className="min-w-[120px]">
                <div className="text-sm font-medium text-white">{r.name}</div>
                <div className="text-xs text-white/40">{r.closedWon} {t('closed')} · {r.commissionPct}% {t('rate')}</div>
              </div>
              <div className="flex-1 min-w-[160px]">
                <div className="h-2 rounded-full bg-white/10 overflow-hidden">
                  <div className="h-full rounded-full bg-gold" style={{ width: `${(r.contractTotal / top) * 100}%` }} />
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm text-white tabular-nums">{money2(r.contractTotal)}</div>
                <div className="text-xs text-emerald-300 tabular-nums">+{money(r.commission)} {t('comm.')}</div>
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  )
}
