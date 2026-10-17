import { useMemo, useState } from 'react'
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts'
import { Info, FileDown, Table, FileSpreadsheet, GitCompareArrows } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptSlice, adaptComparison } from '../store/reportAdapters'
import {
  PageHeader, Card, money, money2, pct2, Select, Field, FilterPill,
} from '../components/ui'
import {
  projectCosts, filterEntries, accountBalance, sliceTotals, earliestEntryDate,
} from '../lib/ledger'
import { ACCOUNTS } from '../lib/accounts'
import {
  projectMargin, projectCostBasis, appToday, money as fmtMoney,
  shiftPeriodYears, previousPeriod, previousMonthKey, monthRange,
} from '../lib/format'
import { exportCSV, exportExcel } from '../lib/exports'
import { pnlPDF } from '../lib/pdf'
import { useT } from '../i18n'

// Fallback split used only when a project has no postings yet — a brand-new
// project created by confirming a DP has revenue but no cost history, and an
// empty statement is less useful than an indicative one. Clearly labelled as
// an estimate wherever it is used.
const FALLBACK_SPLIT = [
  { code: '5101', label: 'Event COGS — Vendors', share: 0.42 },
  { code: '5102', label: 'Event COGS — Crew', share: 0.22 },
  { code: '5103', label: 'Event COGS — Logistics', share: 0.16 },
  { code: '5104', label: 'Event COGS — Consumables', share: 0.08 },
  { code: '6101', label: 'Overhead Allocation', share: 0.12 },
]

const COLORS = ['#c6a15b', '#1f3760', '#3b6ea5', '#6b8cae', '#2a4a7a', '#8d6e3a']

const MODES = [
  { key: 'project', label: 'By Project' },
  { key: 'month', label: 'Monthly' },
  { key: 'custom', label: 'Custom Range' },
]

export default function ProjectPnL() {
  const projects = useStore((s) => s.projects)
  const journal = useStore((s) => s.journal)
  const t = useT()

  const [mode, setMode] = useState('project')
  // The deck names three comparisons: MoM, YoY and project-on-project. A single
  // boolean could only ever express one of them.
  const [compareMode, setCompareMode] = useState('none')
  const [compareProject, setCompareProject] = useState(null)
  const [sel, setSel] = useState(projects[0]?.id)
  const [month, setMonth] = useState(appToday().slice(0, 7))
  const [custom, setCustom] = useState({ from: `${appToday().slice(0, 4)}-01-01`, to: appToday() })

  const p = projects.find((x) => x.id === sel) || projects[0]

  const period = mode === 'month'
    ? monthRange(month)
    : mode === 'custom'
      ? custom
      : null

  // Cost lines come from what was actually posted to this Project ID. The old
  // version synthesised them from fixed percentages of realizedCost, which
  // meant the "statement" could never disagree with itself — and could never
  // be right either.
  const clientView = useMemo(() => {
    if (mode === 'project') {
      const lines = projectCosts(journal, p.id)
      const total = lines.reduce((a, r) => a + r.amount, 0)
      const scoped = journal.filter((e) => e.project === p.id)
      const rev = ACCOUNTS
        .filter((a) => a.type === 'revenue')
        .reduce((a, acc) => a + accountBalance(scoped, acc.code), 0)

      if (total > 0) {
        return { rows: lines, costTotal: total, revenue: rev || p.contractValue, posted: true }
      }
      // No postings yet — indicative split off the estimate.
      const basis = projectCostBasis(p)
      return {
        rows: FALLBACK_SPLIT.map((f) => ({ code: f.code, label: f.label, amount: Math.round(basis * f.share) })),
        costTotal: basis,
        revenue: rev || p.contractValue,
        posted: false,
      }
    }

    // Period modes aggregate every project in the window.
    const scoped = filterEntries(journal, { period })
    const lines = ACCOUNTS
      .filter((a) => a.type === 'cogs' || a.code === '6901')
      .map((a) => ({ code: a.code, label: a.name, amount: accountBalance(scoped, a.code) }))
      .filter((r) => Math.abs(r.amount) > 1)
    const total = lines.reduce((a, r) => a + r.amount, 0)
    const rev = ACCOUNTS
      .filter((a) => a.type === 'revenue')
      .reduce((a, acc) => a + accountBalance(scoped, acc.code), 0)
    return { rows: lines, costTotal: total, revenue: rev, posted: true }
  }, [mode, journal, p, period])

  // Signed in, the figures are the server's (W4): one slice for what is on screen, and the server's own
  // comparison for the date-range modes. The browser's arithmetic stays for the demo and as the dev
  // cross-check. Without postings, a live project shows an empty statement, never the invented split.
  const live = useStore((s) => s.hydrated)
  const sliceParams = mode === 'project' ? { projectId: p?.uuid, period: 'all' } : { period: 'custom', start: period?.from, end: period?.to }
  const slice = useReport('/reports/project-pnl', sliceParams, adaptSlice, { enabled: live && (mode !== 'project' || Boolean(p?.uuid)) })
  const liveView = live && slice.data
    ? { rows: slice.data.costs, costTotal: slice.data.cost, revenue: mode === 'project' ? slice.data.revenue || p.contractValue : slice.data.revenue, posted: true }
    : null
  const { rows, costTotal, revenue, posted } = liveView || clientView
  useCrossCheck('Project P&L cost', slice.data?.cost, clientView.posted ? clientView.costTotal : null)
  useCrossCheck('Project P&L revenue', slice.data?.revenue, clientView.posted && (clientView.revenue !== p?.contractValue || mode !== 'project') ? clientView.revenue : null)

  const grossProfit = revenue - costTotal
  const margin = revenue ? (grossProfit / revenue) * 100 : 0
  const pieData = rows.map((r, i) => ({
    name: r.label.replace('Event COGS — ', ''),
    value: costTotal ? Number(((r.amount / costTotal) * 100).toFixed(2)) : 0,
    color: COLORS[i % COLORS.length],
  }))

  const heading = mode === 'project'
    ? p.id
    : mode === 'month'
      ? month
      : `${custom.from} → ${custom.to}`

  // Which comparisons make sense depends on what is being shown: a single
  // project can be compared to its budget or to another project, a date range
  // to the window before it or to the same window a year earlier.
  const compareOptions = mode === 'project'
    ? [
      { key: 'none', label: 'No comparison' },
      { key: 'budget', label: 'vs Budget' },
      { key: 'project', label: 'vs another Project' },
    ]
    : [
      { key: 'none', label: 'No comparison' },
      { key: 'prev', label: mode === 'month' ? 'Month on Month' : 'vs Previous period' },
      { key: 'yoy', label: 'Year on Year' },
    ]

  // Reset to "none" when the mode changes out from under the selection.
  const activeCompare = compareOptions.some((o) => o.key === compareMode) ? compareMode : 'none'
  const otherProjects = projects.filter((x) => x.id !== p?.id)
  const comparedProject = projects.find((x) => x.id === compareProject) || otherProjects[0]

  const ledgerStart = useMemo(() => earliestEntryDate(journal), [journal])

  // The server's comparison: another project is a second slice; a date range is its own endpoint.
  const otherSlice = useReport('/reports/project-pnl', { projectId: comparedProject?.uuid, period: 'all' }, adaptSlice, { enabled: live && activeCompare === 'project' && Boolean(comparedProject?.uuid) })
  const against = activeCompare === 'yoy' ? 'yoy' : mode === 'month' ? 'mom' : 'prev'
  const rangeCompare = useReport('/reports/project-pnl/compare', { against, period: 'custom', start: period?.from, end: period?.to }, adaptComparison, { enabled: live && (activeCompare === 'prev' || activeCompare === 'yoy') && mode !== 'project' })

  const comparison = useMemo(() => {
    if (activeCompare === 'none') return null

    if (activeCompare === 'budget') {
      const budgetCost = projectCostBasis(p)
      return {
        label: t('Budget'),
        revenue: p.contractValue,
        cost: budgetCost,
        profit: p.contractValue - budgetCost,
      }
    }

    if (live && activeCompare === 'project') {
      return otherSlice.data ? { label: comparedProject.id, ...otherSlice.data } : null
    }
    if (live && rangeCompare.data) {
      const b = rangeCompare.data.baseline
      return {
        label: against === 'mom' ? b.start.slice(0, 7) : `${b.start} → ${b.end}`,
        window: { from: b.start, to: b.end },
        beforeLedger: rangeCompare.data.beforeLedger,
        ...b,
      }
    }
    if (live && (activeCompare === 'prev' || activeCompare === 'yoy')) return null

    if (activeCompare === 'project') {
      if (!comparedProject) return null
      const totals = sliceTotals(journal, { project: comparedProject.id })
      return { label: comparedProject.id, ...totals }
    }

    // Date-range comparisons. Month-on-month uses the previous *calendar*
    // month; a custom range uses the equally-long window before it.
    const window = activeCompare === 'yoy'
      ? shiftPeriodYears(period, -1)
      : mode === 'month'
        ? monthRange(previousMonthKey(month))
        : previousPeriod(period)

    if (!window) return null
    const totals = sliceTotals(journal, { period: window })
    return {
      label: mode === 'month' && activeCompare !== 'yoy'
        ? previousMonthKey(month)
        : `${window.from} \u2192 ${window.to}`,
      window,
      // A window entirely before the first posting has no data by definition.
      // Saying so beats rendering a row of zeroes that looks like a loss.
      beforeLedger: Boolean(ledgerStart && window.to < ledgerStart),
      ...totals,
    }
  }, [activeCompare, mode, p, period, month, journal, comparedProject, ledgerStart, t, live, otherSlice.data, rangeCompare.data, against])

  const exportColumns = [
    { key: 'line', label: 'Line' },
    { key: 'amount', label: 'Amount (IDR)' },
  ]
  const exportRows = [
    { line: 'Revenue recognised', amount: revenue },
    ...rows.map((r) => ({ line: r.label, amount: -r.amount })),
    { line: 'Gross project profit', amount: grossProfit },
    { line: 'Margin %', amount: Number(margin.toFixed(2)) },
  ]
  const exportName = `PnL_${heading.replace(/[^A-Za-z0-9]+/g, '_')}`

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Profitability"
        title="Project P&L"
        subtitle="Micro profit-and-loss built from what was actually posted to the ledger — by project, by month, or across a custom range."
        actions={
          <>
            {mode === 'project' && (
              <Select value={sel} onChange={(e) => setSel(e.target.value)} className="w-auto">
                {projects.map((x) => <option key={x.id} value={x.id}>{x.id} — {x.name}</option>)}
              </Select>
            )}
            {/* Multi-format export, asked for on slide 4. */}
            <button
              onClick={() => pnlPDF({ heading, revenue, rows, grossProfit, margin })}
              className="btn-ghost"
              title={t('Export as PDF')}
            >
              <FileDown size={15} /> PDF
            </button>
            <button
              onClick={() => exportExcel(exportName, exportColumns, exportRows, { title: `Project P&L — ${heading}` })}
              className="btn-ghost"
              title={t('Export for Excel')}
            >
              <FileSpreadsheet size={15} /> Excel
            </button>
            <button
              onClick={() => exportCSV(exportName, exportColumns, exportRows, { title: `Project P&L — ${heading}` })}
              className="btn-ghost"
              title={t('Export as CSV')}
            >
              <Table size={15} /> CSV
            </button>
          </>
        }
      />

      <Card className="mb-4">
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">{t('Cost composition')}</div>
            <div className="flex flex-wrap gap-2">
              {MODES.map((m) => (
                <FilterPill key={m.key} active={mode === m.key} onClick={() => setMode(m.key)}>
                  {t(m.label)}
                </FilterPill>
              ))}
            </div>
          </div>
          {mode === 'month' && (
            <Field label="Month">
              <input
                type="month"
                value={month}
                onChange={(e) => setMonth(e.target.value)}
                className="rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none"
              />
            </Field>
          )}
          <div className="ml-auto flex flex-wrap items-end gap-2">
            <Field label="Compare">
              <div className="flex items-center gap-2">
                <GitCompareArrows size={14} className="text-white/40 shrink-0" />
                <Select value={activeCompare} onChange={(e) => setCompareMode(e.target.value)} className="w-auto">
                  {compareOptions.map((o) => (
                    <option key={o.key} value={o.key}>{t(o.label)}</option>
                  ))}
                </Select>
              </div>
            </Field>
            {activeCompare === 'project' && (
              <Field label="Against">
                <Select
                  value={comparedProject?.id ?? ''}
                  onChange={(e) => setCompareProject(e.target.value)}
                  className="w-auto"
                >
                  {otherProjects.map((x) => <option key={x.id} value={x.id}>{x.id}</option>)}
                </Select>
              </Field>
            )}
          </div>
          {mode === 'custom' && (
            <div className="flex flex-wrap gap-2">
              <Field label="From">
                <input type="date" value={custom.from} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))}
                  className="rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none" />
              </Field>
              <Field label="To">
                <input type="date" value={custom.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))}
                  className="rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none" />
              </Field>
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
        <Card><div className="text-xs text-white/40">{t('Revenue')}</div><div className="mt-1 font-display text-lg text-white tabular-nums">{money2(revenue)}</div></Card>
        <Card><div className="text-xs text-white/40">{t('Total Cost')}</div><div className="mt-1 font-display text-lg text-white tabular-nums">{money2(costTotal)}</div></Card>
        <Card><div className="text-xs text-white/40">{t('Gross Profit')}</div><div className={`mt-1 font-display text-lg tabular-nums ${grossProfit >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>{money2(grossProfit)}</div></Card>
        <Card><div className="text-xs text-white/40">{t('Margin')}</div><div className="mt-1 font-display text-lg text-gold-light tabular-nums">{pct2(margin)}</div></Card>
      </div>

      {comparison && (
        <Card className="mb-4">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            <div className="eyebrow">{t('Comparison')} — {comparison.label}</div>
            <span className="text-[10px] uppercase tracking-wider text-white/30">
              {compareOptions.find((o) => o.key === activeCompare)?.label}
            </span>
          </div>
          {comparison.beforeLedger && (
            <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/[0.05] px-3 py-2 text-[11px] text-amber-200">
              <Info size={13} className="shrink-0 mt-0.5" />
              <span>
                {t('The comparison window ends before the first posting in the ledger')}
                {' '}({ledgerStart}){t(', so there is nothing to compare against yet.')}
              </span>
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            {[
              { label: t('Revenue'), now: revenue, prev: comparison.revenue },
              { label: t('Cost'), now: costTotal, prev: comparison.cost, inverse: true },
              { label: t('Profit'), now: grossProfit, prev: comparison.profit },
              { label: t('Margin'), now: margin, prev: comparison.margin ?? 0, isPct: true },
            ].map((row) => {
              const delta = row.now - row.prev
              // For cost, spending less than planned is the good outcome.
              const good = row.inverse ? delta <= 0 : delta >= 0
              return (
                <div key={row.label}>
                  <div className="text-xs text-white/40">{row.label}</div>
                  <div className="mt-1 text-sm text-white tabular-nums">
                    {row.isPct ? pct2(row.now) : money2(row.now)}
                  </div>
                  <div className="text-[11px] text-white/35 tabular-nums">
                    {t('was')} {row.isPct ? pct2(row.prev) : fmtMoney(row.prev)}
                  </div>
                  <div className={`mt-0.5 text-[11px] tabular-nums ${good ? 'text-emerald-300' : 'text-rose-300'}`}>
                    {delta >= 0 ? '▲' : '▼'}{' '}
                    {row.isPct ? `${Math.abs(delta).toFixed(2)} pp` : fmtMoney(Math.abs(delta))}
                    {!row.isPct && row.prev ? ` (${((delta / Math.abs(row.prev)) * 100).toFixed(1)}%)` : ''}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {!posted && (
        <Card className="mb-4 border-amber-500/30 bg-amber-500/[0.05]">
          <div className="flex items-start gap-2.5 text-xs text-amber-200">
            <Info size={15} className="shrink-0 mt-0.5" />
            <span>
              {t('Nothing has been posted against this project yet, so the cost lines below are an indicative split of the budget — not actuals. They will be replaced by real postings as costs land.')}
            </span>
          </div>
        </Card>
      )}

      <div className="grid lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2">
          <div className="eyebrow mb-3">{t('Statement')} — {heading}</div>
          <div className="divide-y divide-white/5">
            <div className="flex items-center justify-between py-2.5">
              <span className="text-sm text-white">{t('Revenue recognised')}</span>
              <span className="text-sm tabular-nums text-emerald-300">{money2(revenue)}</span>
            </div>
            {rows.map((r) => (
              <div key={r.code + r.label} className="flex items-center justify-between py-2.5">
                <span className="text-sm text-white/60 pl-3">
                  {r.label}
                  {!posted && <span className="ml-2 text-[10px] uppercase tracking-wider text-amber-400/70">est</span>}
                </span>
                <span className="text-sm tabular-nums text-rose-300">({money2(r.amount)})</span>
              </div>
            ))}
            {!rows.length && (
              <div className="py-4 text-sm text-white/30">{t('No costs posted in this period.')}</div>
            )}
            <div className="flex items-center justify-between py-3">
              <span className="text-sm font-medium text-white">{t('Gross Project Profit')}</span>
              <span className={`text-base font-medium tabular-nums ${grossProfit >= 0 ? 'text-gold-light' : 'text-rose-300'}`}>
                {money2(grossProfit)}
              </span>
            </div>
          </div>

          {mode === 'project' && (
            <div className="mt-4 grid sm:grid-cols-3 gap-3 border-t border-white/10 pt-4 text-xs">
              <div>
                <div className="text-white/40">{t('Contract value')}</div>
                <div className="text-white/85 tabular-nums mt-0.5">{money(p.contractValue)}</div>
              </div>
              <div>
                <div className="text-white/40">{t('Budget (est. cost)')}</div>
                <div className="text-white/85 tabular-nums mt-0.5">{money(p.estimatedCost)}</div>
              </div>
              <div>
                <div className="text-white/40">{t('Forecast margin')}</div>
                <div className="text-gold-light tabular-nums mt-0.5">{pct2(projectMargin(p))}</div>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <div className="eyebrow mb-3">{t('Cost Composition')}</div>
          {costTotal > 0 ? (
            <>
              <div className="h-48">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie data={pieData} dataKey="value" nameKey="name" innerRadius={45} outerRadius={72} paddingAngle={2}>
                      {pieData.map((d, i) => <Cell key={i} fill={d.color} stroke="none" />)}
                    </Pie>
                    <Tooltip
                      contentStyle={{ background: '#0a1424', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }}
                      itemStyle={{ color: 'rgba(255,255,255,0.9)' }}
                      labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
                      formatter={(v, n) => [`${v}%`, n]}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-3 space-y-1.5">
                {pieData.map((d) => (
                  <div key={d.name} className="flex items-center gap-2 text-xs">
                    <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ background: d.color }} />
                    <span className="text-white/60 flex-1 truncate">{d.name}</span>
                    <span className="text-white/40 tabular-nums">{d.value.toFixed(2)}%</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="py-12 text-center text-sm text-white/30">{t('No costs to break down.')}</div>
          )}
        </Card>
      </div>
    </div>
  )
}
