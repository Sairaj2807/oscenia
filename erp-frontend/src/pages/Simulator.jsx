import { useState, useMemo } from 'react'
import { ResponsiveContainer, RadialBarChart, RadialBar, PolarAngleAxis, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import { RotateCcw } from 'lucide-react'
import { useStore } from '../store/useStore'
import NoProjectsYet from '../components/NoProjectsYet'
import { PageHeader, Card, money, money2, pct2 } from '../components/ui'
import { useT } from '../i18n'

function Slider({ label, value, min, max, step, onChange, fmt }) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-sm text-white/70">{label}</span>
        <span className="text-sm tabular-nums text-gold-light">{fmt(value)}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-gold cursor-pointer"
      />
    </div>
  )
}

function SimulatorView() {
  const projects = useStore((s) => s.projects)
  const t = useT()
  const base = projects.find((p) => p.id === 'EVT-2026-CONF-03') || projects[0]

  const initial = {
    contract: base.contractValue,
    vendorPct: 42,
    crewPct: 22,
    logisticsPct: 16,
    consumablesPct: 8,
  }
  const [s, setS] = useState(initial)
  const set = (k) => (v) => setS((prev) => ({ ...prev, [k]: v }))

  const model = useMemo(() => {
    const costBase = base.estimatedCost
    const vendors = Math.round(costBase * (s.vendorPct / 100))
    const crew = Math.round(costBase * (s.crewPct / 100))
    const logistics = Math.round(costBase * (s.logisticsPct / 100))
    const consumables = Math.round(costBase * (s.consumablesPct / 100))
    const totalCost = vendors + crew + logistics + consumables
    const profit = s.contract - totalCost
    const margin = s.contract ? (profit / s.contract) * 100 : 0
    const breakeven = totalCost
    return { vendors, crew, logistics, consumables, totalCost, profit, margin, breakeven }
  }, [s, base])

  const marginColor = model.margin >= 30 ? '#34d399' : model.margin >= 15 ? '#e0c789' : '#fb7185'
  const gauge = [{ name: 'margin', value: Math.max(0, Math.min(100, model.margin)), fill: marginColor }]

  const bars = [
    { name: 'Vendors', v: model.vendors },
    { name: 'Crew', v: model.crew },
    { name: 'Logistics', v: model.logistics },
    { name: 'Consum.', v: model.consumables },
    { name: 'Profit', v: Math.max(0, model.profit), profit: true },
  ]

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="What-If Analysis"
        title="Project Profitability Simulation"
        subtitle="Model an event before you commit. Drag the levers — margin, break-even and cost mix recompute live."
        actions={<button onClick={() => setS(initial)} className="btn-ghost"><RotateCcw size={15} /> {t('Reset')}</button>}
      />

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Controls */}
        <Card className="lg:col-span-1 space-y-5">
          <div className="eyebrow">Assumptions · {base.name}</div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1">Contract Value (Rp)</div>
            <input
              type="number"
              value={s.contract}
              onChange={(e) => set('contract')(Number(e.target.value) || 0)}
              step={10_000_000}
              className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-right text-sm tabular-nums text-white/85 focus:border-gold/50 outline-none"
            />
          </div>
          <Slider label="Contract Value" value={s.contract} min={300_000_000} max={1_000_000_000} step={10_000_000} onChange={set('contract')} fmt={money} />
          <Slider label="Vendor Cost" value={s.vendorPct} min={20} max={60} step={1} onChange={set('vendorPct')} fmt={(v) => `${v}%`} />
          <Slider label="Crew Cost" value={s.crewPct} min={10} max={40} step={1} onChange={set('crewPct')} fmt={(v) => `${v}%`} />
          <Slider label="Logistics" value={s.logisticsPct} min={5} max={30} step={1} onChange={set('logisticsPct')} fmt={(v) => `${v}%`} />
          <Slider label="Consumables" value={s.consumablesPct} min={2} max={20} step={1} onChange={set('consumablesPct')} fmt={(v) => `${v}%`} />
        </Card>

        {/* Gauge + KPIs */}
        <Card className="lg:col-span-2">
          <div className="grid sm:grid-cols-2 gap-4 items-center">
            <div className="relative h-56">
              <ResponsiveContainer width="100%" height="100%">
                <RadialBarChart innerRadius="70%" outerRadius="100%" data={gauge} startAngle={210} endAngle={-30}>
                  <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                  <RadialBar dataKey="value" cornerRadius={12} background={{ fill: 'rgba(255,255,255,0.06)' }} />
                </RadialBarChart>
              </ResponsiveContainer>
              <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                <div className="font-display text-3xl sm:text-4xl tabular-nums" style={{ color: marginColor }}>{pct2(model.margin)}</div>
                <div className="text-xs text-white/40">gross margin</div>
              </div>
            </div>
            <div className="space-y-3">
              <div><div className="text-xs text-white/40">Net Profit</div><div className="font-display text-xl sm:text-2xl tabular-nums" style={{ color: marginColor }}>{money2(model.profit)}</div></div>
              <div><div className="text-xs text-white/40">Total Cost</div><div className="text-base text-white tabular-nums">{money2(model.totalCost)}</div></div>
              <div><div className="text-xs text-white/40">Break-even Revenue</div><div className="text-base text-white tabular-nums">{money2(model.breakeven)}</div></div>
              <div className={`text-xs ${model.margin >= 30 ? 'text-emerald-400' : model.margin >= 15 ? 'text-gold-light' : 'text-rose-400'}`}>
                {model.margin >= 30 ? '✓ Above 30% target' : model.margin >= 15 ? '△ Below target — review vendor mix' : '✕ Loss risk — renegotiate contract'}
              </div>
            </div>
          </div>

          <div className="h-44 mt-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={bars} margin={{ left: -20, right: 8, top: 8 }}>
                <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${(v / 1_000_000).toFixed(0)}M`} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={{ background: '#0a1424', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, fontSize: 12 }} itemStyle={{ color: 'rgba(255,255,255,0.9)' }} labelStyle={{ color: 'rgba(255,255,255,0.5)' }} formatter={(v) => money(v)} />
                <Bar dataKey="v" radius={[4, 4, 0, 0]}>
                  {bars.map((b, i) => <Cell key={i} fill={b.profit ? marginColor : '#1f3760'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
      </div>
    </div>
  )
}

// With no projects there is nothing to analyse; the view below assumes at least one.
export default function Simulator() {
  const hasProjects = useStore((s) => s.projects.length > 0)
  return hasProjects ? <SimulatorView /> : <NoProjectsYet eyebrow="What-if" title="Profit Simulator" />
}
