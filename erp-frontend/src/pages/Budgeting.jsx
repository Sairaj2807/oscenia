import { AlertTriangle, Plus } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PageHeader, Card, money } from '../components/ui'
import { useT } from '../i18n'
import BudgetingLive from './BudgetingLive'

function BudgetBar({ cat }) {
  const pct = Math.min(140, Math.round((cat.realized / cat.ceiling) * 100))
  const over = cat.realized > cat.ceiling
  const color = over ? 'bg-rose-500' : pct > 85 ? 'bg-amber-400' : 'bg-gold'
  return (
    <div className={`rounded-xl border p-4 ${over ? 'border-rose-500/50 bg-rose-500/[0.06] animate-flash' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-white flex items-center gap-2">
          {cat.label}
          {over && <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-rose-300"><AlertTriangle size={12} /> over</span>}
        </span>
        <span className="text-xs tabular-nums text-white/60">{money(cat.realized)} / {money(cat.ceiling)}</span>
      </div>
      <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className="text-white/40">{pct}% of ceiling</span>
        <span className={over ? 'text-rose-300' : 'text-emerald-300/80'}>
          {over ? `${money(cat.realized - cat.ceiling)} over` : `${money(cat.ceiling - cat.realized)} left`}
        </span>
      </div>
    </div>
  )
}

function BudgetingDemo() {
  const budget = useStore((s) => s.budget)
  const flagged = useStore((s) => s.budgetFlagged)
  const addUnplannedCost = useStore((s) => s.addUnplannedCost)
  const t = useT()

  const totalCeiling = budget.categories.reduce((a, c) => a + c.ceiling, 0)
  const totalReal = budget.categories.reduce((a, c) => a + c.realized, 0)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Cost Control"
        title="Budgeting System"
        subtitle={`Expenditure ceilings vs. realized cost for ${budget.project}. Exceed a ceiling and the system fires an automatic red-flag to the CEO and PM.`}
        actions={
          <button onClick={() => addUnplannedCost()} disabled={flagged} className="btn-gold">
            <Plus size={15} /> {flagged ? t('Cost logged') : t('Log unplanned cost')}
          </button>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card><div className="text-xs text-white/40">Total Ceiling</div><div className="mt-1 font-display text-xl text-white tabular-nums">{money(totalCeiling)}</div></Card>
        <Card><div className="text-xs text-white/40">Realized</div><div className="mt-1 font-display text-xl text-white tabular-nums">{money(totalReal)}</div></Card>
        <Card><div className="text-xs text-white/40">Remaining</div><div className={`mt-1 font-display text-xl tabular-nums ${totalReal > totalCeiling ? 'text-rose-400' : 'text-emerald-300'}`}>{money(totalCeiling - totalReal)}</div></Card>
        <Card><div className="text-xs text-white/40">Utilization</div><div className="mt-1 font-display text-xl text-gold-light tabular-nums">{Math.round((totalReal / totalCeiling) * 100)}%</div></Card>
      </div>

      {flagged && (
        <Card className="mb-5 border-rose-500/50 bg-rose-500/[0.07]">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 place-items-center rounded-lg bg-rose-500/15 text-rose-300 shrink-0"><AlertTriangle size={20} /></span>
            <div>
              <div className="text-sm font-medium text-white">Budget red-flag raised</div>
              <div className="text-xs text-white/60 mt-0.5">The Vendors category has exceeded its ceiling. Approval now requires CEO sign-off before further spend.</div>
            </div>
          </div>
        </Card>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {budget.categories.map((c) => <BudgetBar key={c.key} cat={c} />)}
      </div>
    </div>
  )
}

// Signed in, the screen reads the server's per-project budgets (ceilings against what the ledger says
// was spent); signed out, the demo keeps its single seeded budget and its simulated unplanned cost.
export default function Budgeting() {
  const live = useStore((s) => s.hydrated)
  return live ? <BudgetingLive /> : <BudgetingDemo />
}
