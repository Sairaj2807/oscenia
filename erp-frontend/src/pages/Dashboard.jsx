import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid,
  BarChart, Bar, Cell,
} from 'recharts'
import { AlertTriangle, Check, Clock, ChevronRight } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PageHeader, StatCard, Card, money, money2, pct2, Badge, SectionTitle } from '../components/ui'
import { cashBalance, accountBalance } from '../lib/ledger'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptAgeing, adaptCashPosition } from '../store/reportAdapters'
import { adaptAlerts } from '../store/budgetAdapters'
import { trendSeries, trendIsEmpty, cardDelta } from '../lib/trend'
import { committedByProject } from '../lib/vendors'
import { projectMargin, projectCostBasis, dayCounter, daysUntil, daysSince } from '../lib/format'
import { useT } from '../i18n'

const revenueTrend = [
  { m: 'Feb', v: 410 }, { m: 'Mar', v: 520 }, { m: 'Apr', v: 480 },
  { m: 'May', v: 610 }, { m: 'Jun', v: 720 }, { m: 'Jul', v: 690 },
]

function ChartTip({ active, payload, label, unit = 'M' }) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-white/10 bg-navy-800 px-3 py-2 text-xs shadow-xl">
      <div className="text-white/50">{label}</div>
      <div className="text-gold-light font-medium">Rp {payload[0].value} {unit}</div>
    </div>
  )
}

export default function Dashboard() {
  const allProjects = useStore((s) => s.projects)
  const invoices = useStore((s) => s.invoices)
  const journal = useStore((s) => s.journal)
  const budget = useStore((s) => s.budget)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const tolerance = useStore((s) => s.budgetTolerancePct)
  // Used only to flash the stat cards when something has just landed. Derived from the
  // deals collection now that there is more than one of them.
  const dpConfirmed = useStore((s) => s.deals.some((d) => d.confirmed))
  const live = useStore((s) => s.hydrated)
  const t = useT()

  // A cancelled project should not inflate the pipeline or drag the margin.
  const projects = useMemo(() => allProjects.filter((p) => !p.cancelled), [allProjects])

  // Signed in, the server has already flagged each project that ran past its approved budget. The
  // dashboard's own ceiling is only the estimate (the approved budget is per project and not loaded
  // here), so a flag the server raised and nobody has acknowledged also shows as over budget.
  const alerts = useReport('/alerts/budget-breaches', {}, (rows) => adaptAlerts(rows, allProjects), { enabled: live })
  const flagged = useMemo(
    () => new Set((alerts.data || []).filter((a) => !a.acknowledged && a.project).map((a) => a.project)),
    [alerts.data],
  )

  const stats = useMemo(() => {
    const pipeline = projects.reduce((a, p) => a + p.contractValue, 0)
    // Margin is measured against cost-at-completion, not cost-to-date. Using
    // realized cost alone reported ~60% because an early-stage project has
    // barely spent anything yet — it measured "how little have we spent",
    // not profitability. See lib/format.js: projectMargin.
    const basis = projects.reduce((a, p) => a + projectCostBasis(p), 0)
    const receivable = invoices.filter((i) => i.status === 'Unpaid').reduce((a, i) => a + i.amount, 0)
    const margin = pipeline ? ((pipeline - basis) / pipeline) * 100 : 0
    return { pipeline, receivable, margin, active: projects.filter((p) => p.stage !== 'Finished').length }
  }, [projects, invoices])

  // Signed in, the cash and ledger-receivable cards come from the server's reports (the same answer
  // as the Cash and Receivables screens); the browser computes them for the demo and as a cross-check.
  const cashReport = useReport('/reports/cash-position', {}, adaptCashPosition, { enabled: live })
  // Signed in, the revenue chart and the "vs last month" arrows are the ledger's own months. Signed out the
  // chart is the demo's picture, and the two arrows with no ledger behind them stay as they were.
  const trend = useReport('/reports/monthly-trend', { months: 6 }, (x) => x, { enabled: live })
  const served = live && trend.data ? trend.data : null
  const series = served ? trendSeries(served) : revenueTrend
  const arReport = useReport('/receivables/ageing', {}, adaptAgeing, { enabled: live })
  const clientCash = useMemo(() => cashBalance(journal), [journal])
  const clientAR = useMemo(() => accountBalance(journal, '1201'), [journal])
  const cash = live && cashReport.data ? cashReport.data.total : clientCash
  const ledgerAR = live && arReport.data ? arReport.data.ledgerBalance : clientAR
  useCrossCheck('dashboard: total cash', live && cashReport.data ? cashReport.data.total : null, clientCash)
  useCrossCheck('dashboard: ledger receivables (1201)', live && arReport.data ? arReport.data.ledgerBalance : null, clientAR)

  const marginByProject = projects.map((p) => ({
    name: p.id.replace('EVT-2026-', ''),
    margin: Number(projectMargin(p).toFixed(2)),
    isNew: p.isNew,
  }))

  // Per-project health for the executive summary the deck asked for: is the DP
  // in, is it inside budget, how long to the event, what margin is forecast.
  const health = useMemo(() => {
    return projects
      .filter((p) => p.stage !== 'Finished')
      .map((p) => {
        const dpPaid = invoices.some((i) => i.project === p.id && i.type === 'Down Payment' && i.status === 'Paid')
        const overdue = invoices.some((i) => i.project === p.id && i.status === 'Unpaid' && (daysUntil(i.due) ?? 0) < 0)
        const ceiling = budget.project === p.id
          ? budget.categories.reduce((a, c) => a + c.ceiling, 0)
          : p.estimatedCost
        const tolerated = Math.round(ceiling * (1 + tolerance / 100))
        const overBudget = p.realizedCost > tolerated || flagged.has(p.id)
        // Committed = approved purchase orders. Spend that is contractually
        // owed but not yet paid is still gone, so a health read that ignores it
        // is optimistic.
        const committed = committedByProject(purchaseOrders, p.id)
        return {
          ...p,
          dpPaid,
          overdue,
          overBudget,
          ceiling,
          committed,
          spentPct: ceiling ? Math.min(140, (p.realizedCost / ceiling) * 100) : 0,
          committedPct: ceiling ? Math.min(140, (Math.max(0, committed - p.realizedCost) / ceiling) * 100) : 0,
          margin: projectMargin(p),
          toEvent: daysUntil(p.eventDate),
          inStage: daysSince(p.stageSince),
        }
      })
      .sort((a, b) => (a.toEvent ?? 0) - (b.toEvent ?? 0))
  }, [projects, invoices, budget, purchaseOrders, tolerance, flagged])

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Executive Overview"
        title="Company Dashboard"
        subtitle="Real-time profitability, cash, receivables and project pipeline — every figure tagged to a Project ID and derived from the general ledger."
      />

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {/* Pipeline value and event margin are not ledger figures, so signed in they carry no invented arrow. */}
        <StatCard label="Pipeline Value" value={money(stats.pipeline)} delta={live ? undefined : 2} hint={live ? 'contracted, not cancelled' : 'vs last qtr'} flash={dpConfirmed} />
        <StatCard label="Total Cash" value={money(cash)} delta={served ? cardDelta(served.delta.closingCash) : undefined} hint={served ? 'vs last month' : 'cash + bank + petty'} flash={dpConfirmed} />
        <StatCard label="Avg Event Margin" value={pct2(stats.margin)} delta={live ? undefined : 3} hint="target 30%" />
        <StatCard label="Outstanding Receivables" value={money(stats.receivable)} hint="AR unpaid" />
        <StatCard label="Active Projects" value={stats.active} hint={`${projects.length} total`} flash={dpConfirmed} />
      </div>

      {/* Quick links into the two dedicated finance views */}
      <div className="grid sm:grid-cols-2 gap-4 mt-4">
        <Link to="/cash" className="card p-4 flex items-center gap-3 hover:border-gold/40 transition-colors group">
          <div className="flex-1">
            <div className="eyebrow mb-1">{t('Total Cash')}</div>
            <div className="font-display text-xl text-gold-light tabular-nums">{money2(cash)}</div>
            <div className="text-[11px] text-white/40 mt-0.5">{t('Consolidated cash & bank position')}</div>
          </div>
          <ChevronRight size={18} className="text-white/25 group-hover:text-gold/70 transition-colors" />
        </Link>
        <Link to="/receivables" className="card p-4 flex items-center gap-3 hover:border-gold/40 transition-colors group">
          <div className="flex-1">
            <div className="eyebrow mb-1">{t('Accounts Receivable')}</div>
            <div className="font-display text-xl text-sky-300 tabular-nums">{money2(ledgerAR)}</div>
            <div className="text-[11px] text-white/40 mt-0.5">{t('Ageing by days overdue')}</div>
          </div>
          <ChevronRight size={18} className="text-white/25 group-hover:text-gold/70 transition-colors" />
        </Link>
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <Card className="lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="eyebrow mb-1">{t('Revenue (Rp M)')}</div>
              <div className="text-sm text-white/60">
                {served ? t('Revenue in the ledger, by month') : t('Booked contract value by month')}
                {served && cardDelta(served.delta.revenue) !== undefined && (
                  <span className={`ml-2 text-xs ${served.delta.revenue >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {served.delta.revenue >= 0 ? '▲' : '▼'} {Math.abs(cardDelta(served.delta.revenue))}% {t('vs last month')}
                  </span>
                )}
              </div>
              {served && trendIsEmpty(served) && <div className="text-xs text-white/35">{t('No revenue has been posted in these months yet.')}</div>}
            </div>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={series} margin={{ left: -18, right: 8, top: 6 }}>
                <defs>
                  <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#c6a15b" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#c6a15b" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="m" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTip />} />
                <Area type="monotone" dataKey="v" stroke="#c6a15b" strokeWidth={2} fill="url(#g)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <div className="eyebrow mb-1">{t('Margin by Project')}</div>
          <div className="text-sm text-white/60 mb-4">{t('Forecast margin % (actual once finished)')}</div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={marginByProject} margin={{ left: -22, right: 8, top: 6 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} axisLine={false} tickLine={false} interval={0} angle={-25} textAnchor="end" height={50} />
                <YAxis tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }} axisLine={false} tickLine={false} />
                <Tooltip content={<ChartTip unit="%" />} cursor={{ fill: 'rgba(255,255,255,0.04)' }} />
                <Bar dataKey="margin" radius={[4, 4, 0, 0]}>
                  {marginByProject.map((d, i) => (
                    <Cell key={i} fill={d.isNew ? '#e0c789' : '#1f3760'} stroke={d.isNew ? '#e0c789' : '#2a4a7a'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>

      {/* Executive summary — health of every active project at a glance */}
      <SectionTitle>{t('Executive Summary · Active Projects')}</SectionTitle>
      <div className="grid gap-3">
        {health.map((p) => (
          <Card key={p.id} className={p.isNew ? 'border-gold/40 bg-gold/5 animate-pop' : ''}>
            <div className="flex flex-wrap items-center gap-3">
              <Link to={`/projects/${p.id}`} className="min-w-[180px] flex-1 group">
                <div className="font-mono text-[11px] text-gold/80">{p.id}</div>
                <div className="text-sm text-white group-hover:text-gold-light transition-colors">{p.name}</div>
                <div className="text-[11px] text-white/40">{p.client}</div>
              </Link>

              <Badge>{p.stage}</Badge>

              <div className="min-w-[86px]">
                <div className="text-[10px] uppercase tracking-wider text-white/35">{t('To event')}</div>
                <div className={`text-sm tabular-nums ${
                  p.toEvent != null && p.toEvent < 14 ? 'text-amber-300' : 'text-white/80'
                }`}>
                  {dayCounter(p.eventDate) || '—'}
                </div>
              </div>

              <div className="min-w-[86px]">
                <div className="text-[10px] uppercase tracking-wider text-white/35">{t('In stage')}</div>
                <div className="text-sm tabular-nums text-white/80">
                  {p.inStage != null ? `${p.inStage} ${t('days')}` : '—'}
                </div>
              </div>

              <div className="min-w-[92px]">
                <div className="text-[10px] uppercase tracking-wider text-white/35">{t('Margin')}</div>
                <div className={`text-sm tabular-nums ${
                  p.margin >= 30 ? 'text-emerald-300' : p.margin >= 15 ? 'text-gold-light' : 'text-rose-300'
                }`}>
                  {pct2(p.margin)}
                </div>
              </div>

              <div className="min-w-[100px] text-right">
                <div className="text-[10px] uppercase tracking-wider text-white/35">{t('Contract')}</div>
                <div className="text-sm tabular-nums text-white/80">{money(p.contractValue)}</div>
              </div>

              {/* Budget consumption — realized solid, committed hatched, against
                  the locked ceiling. This is the "graphical summary of active
                  project financial health" from slide 2. */}
              <div className="w-full lg:w-52 order-last lg:order-none">
                <div className="flex items-center justify-between text-[10px] mb-1">
                  <span className="uppercase tracking-wider text-white/35">{t('Budget used')}</span>
                  <span className={`tabular-nums ${p.overBudget ? 'text-rose-300' : 'text-white/50'}`}>
                    {p.spentPct.toFixed(0)}%
                  </span>
                </div>
                <div className="relative h-2 rounded-full bg-white/10 overflow-hidden">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${
                      p.overBudget ? 'bg-rose-500' : p.spentPct > 85 ? 'bg-amber-400' : 'bg-gold'
                    }`}
                    style={{ width: `${Math.min(100, p.spentPct)}%` }}
                  />
                  <div
                    className="absolute inset-y-0 bg-gold/30"
                    style={{
                      left: `${Math.min(100, p.spentPct)}%`,
                      width: `${Math.min(100 - Math.min(100, p.spentPct), p.committedPct)}%`,
                    }}
                  />
                </div>
                <div className="mt-1 flex items-center justify-between text-[10px] text-white/35 tabular-nums">
                  <span>{money(p.realizedCost)}</span>
                  <span>{t('of')} {money(p.ceiling)}</span>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 w-full sm:w-auto">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${
                  p.dpPaid
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                }`}>
                  {p.dpPaid ? <Check size={10} /> : <Clock size={10} />} {t('DP')}
                </span>
                {p.overBudget && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
                    <AlertTriangle size={10} /> {t('Over budget')}
                  </span>
                )}
                {p.overdue && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] text-rose-300">
                    <AlertTriangle size={10} /> {t('AR overdue')}
                  </span>
                )}
                {p.committed > p.realizedCost && (
                  <span className="inline-flex items-center gap-1 rounded-full border border-gold/25 bg-gold/10 px-2 py-0.5 text-[10px] text-gold-light">
                    {money(p.committed - p.realizedCost)} {t('committed')}
                  </span>
                )}
              </div>
            </div>
          </Card>
        ))}
        {!health.length && <Card><span className="text-sm text-white/30">{t('No active projects.')}</span></Card>}
      </div>
    </div>
  )
}
