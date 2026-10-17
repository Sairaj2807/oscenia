import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FileSignature, Plus, Send, Check, Download, X, ArrowRight, Ban, Pencil,
  FileCog, CalendarClock, Wand2, AlertTriangle,
} from 'lucide-react'
import {
  ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, Tooltip, CartesianGrid, Cell,
} from 'recharts'
import { useStore } from '../store/useStore'
import Modal from '../components/Modal'
import {
  PageHeader, Card, Badge, money, money2, pct2,
  Field, TextInput, NumberInput, Select, ActionButton, FilterPill,
} from '../components/ui'
import { quotationPDF } from '../lib/pdf'
import { dayCounter, appToday, formatDate } from '../lib/format'
import {
  DP_PRESETS, ANCHORS, presetStages, matchPreset, stagesFor, resolveSchedule,
  scheduleBalance, validateSchedule,
} from '../lib/billing'
import { DEFAULT_TEMPLATE, resolveTemplate } from '../store/seed'
import TemplateManager from '../components/TemplateManager'
import { useT } from '../i18n'

const qValue = (q) => q.lineItems.reduce((a, l) => a + l.amount, 0)
const qCost = (q) => q.lineItems.reduce((a, l) => a + (l.estCost || 0), 0)
const qMargin = (q) => {
  const v = qValue(q)
  return v ? ((v - qCost(q)) / v) * 100 : 0
}

// Each line carries a sell price AND an estimated cost. Without a cost there is
// no margin to calculate — which is why the old modal could only show a
// hardcoded constant.
const DEFAULT_ITEMS = [
  { label: 'Venue & Staging', amount: 150_000_000, estCost: 105_000_000 },
  { label: 'AV & Vendors', amount: 110_000_000, estCost: 77_000_000 },
  { label: 'Crew & Production', amount: 70_000_000, estCost: 49_000_000 },
]

// ---------------------------------------------------------------------------
// Phased down-payment editor.
//
// "Standardized DP presets (50% / 75% / 100%)" for speed, "customized
// percentage & nominal (fully customized)" for everything else. The preset
// pills are shortcuts that write stages into the same editor rather than a
// separate mode, so a preset can be nudged without starting over.
// ---------------------------------------------------------------------------
function ScheduleEditor({ stages, setStages, contractValue, eventDate }) {
  const t = useT()
  const preset = matchPreset(stages)
  const resolved = useMemo(
    () => resolveSchedule(stages, contractValue, { signingDate: appToday(), eventDate }),
    [stages, contractValue, eventDate]
  )
  const balance = scheduleBalance(stages, contractValue)
  const error = validateSchedule(stages, contractValue)

  const setStage = (i, patch) =>
    setStages((arr) => arr.map((st, idx) => (idx === i ? { ...st, ...patch } : st)))
  const addStage = () =>
    setStages((arr) => [...arr, {
      label: `Stage ${arr.length + 1}`, basis: 'percent', value: 0, anchor: 'event', offsetDays: -7,
    }])
  const removeStage = (i) =>
    setStages((arr) => (arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr))

  // One click to close the gap, because the arithmetic is the system's job.
  const balanceToContract = () => {
    if (!stages.length) return
    const last = stages.length - 1
    setStages((arr) => arr.map((st, idx) => {
      if (idx !== last) return st
      const others = arr.filter((_, k) => k !== last)
        .reduce((a, x) => a + (x.basis === 'amount'
          ? Math.round(Number(x.value) || 0)
          : Math.round((contractValue * (Number(x.value) || 0)) / 100)), 0)
      const remaining = Math.max(0, contractValue - others)
      return st.basis === 'amount'
        ? { ...st, value: remaining }
        : { ...st, value: contractValue ? Math.round((remaining / contractValue) * 1000) / 10 : 0 }
    }))
  }

  // Cumulative collection alongside each instalment — the "phased DP scheme
  // simulation" from the proposal. What matters to a finance team is not the
  // size of each stage but how much of the contract is in the bank by when.
  const chartData = resolved.map((r, i) => ({
    name: r.label.length > 14 ? `${r.label.slice(0, 13)}…` : r.label,
    due: r.due,
    amount: r.amount,
    cumulative: resolved.slice(0, i + 1).reduce((a, x) => a + x.amount, 0),
  }))

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 pt-1">
        <span className="text-[11px] uppercase tracking-wider text-white/35 mr-1">{t('DP preset')}</span>
        {DP_PRESETS.map((p) => (
          <FilterPill key={p.key} active={preset === p.key} onClick={() => setStages(presetStages(p.key))}>
            <span title={p.hint}>{p.label}</span>
          </FilterPill>
        ))}
        <FilterPill active={preset === null} onClick={() => {}}>{t('Custom')}</FilterPill>
      </div>

      <div className="space-y-2">
        <div className="hidden sm:grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider text-white/30">
          <span className="col-span-4">{t('Stage')}</span>
          <span className="col-span-2">{t('Basis')}</span>
          <span className="col-span-2 text-right">{t('Value')}</span>
          <span className="col-span-3">{t('Due')}</span>
        </div>
        {stages.map((st, i) => (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <div className="col-span-12 sm:col-span-4">
              <TextInput value={st.label} onChange={(e) => setStage(i, { label: e.target.value })} placeholder="Stage name" />
            </div>
            <div className="col-span-5 sm:col-span-2">
              <Select value={st.basis} onChange={(e) => setStage(i, { basis: e.target.value, value: 0 })}>
                <option value="percent">%</option>
                <option value="amount">Rp</option>
              </Select>
            </div>
            <div className="col-span-5 sm:col-span-2">
              <NumberInput
                value={st.value}
                onChange={(e) => setStage(i, { value: Number(e.target.value) || 0 })}
                step={st.basis === 'percent' ? 5 : 1_000_000}
                min={0}
              />
            </div>
            <div className="col-span-10 sm:col-span-3 flex gap-1.5">
              <NumberInput
                className="w-16"
                value={st.offsetDays}
                onChange={(e) => setStage(i, { offsetDays: Number(e.target.value) || 0 })}
                step={7}
                title={t('Days relative to the anchor; negative is before')}
              />
              <Select value={st.anchor} onChange={(e) => setStage(i, { anchor: e.target.value })}>
                {ANCHORS.map((a) => <option key={a.key} value={a.key}>{t(a.label)}</option>)}
              </Select>
            </div>
            <div className="col-span-2 sm:col-span-1 flex justify-end">
              <button
                onClick={() => removeStage(i)}
                disabled={stages.length <= 1}
                className="text-white/30 hover:text-rose-300 disabled:opacity-25"
                aria-label="Remove stage"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button onClick={addStage} className="text-xs text-gold/80 hover:text-gold-light inline-flex items-center gap-1">
          <Plus size={12} /> {t('Add stage')}
        </button>
        {Math.abs(balance) > stages.length && (
          <button onClick={balanceToContract} className="text-xs text-emerald-300 hover:text-emerald-200 inline-flex items-center gap-1">
            <Wand2 size={12} /> {t('Balance to contract value')}
          </button>
        )}
        {error && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] text-amber-300">
            <AlertTriangle size={12} /> {error}
          </span>
        )}
      </div>

      {/* Resolved schedule — real amounts against real dates. */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-white/35 mb-2">
          <CalendarClock size={12} /> {t('Billing schedule')}
        </div>
        <div className="space-y-1">
          {resolved.map((r) => (
            <div key={r.index} className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]">
              <span className="text-white/70">{r.label}</span>
              <span className="text-white/35">{formatDate(r.due)}</span>
              <span className="tabular-nums text-white/45 w-14 text-right">{r.percent.toFixed(1)}%</span>
              <span className="tabular-nums text-white/85 w-32 text-right">{money2(r.amount)}</span>
            </div>
          ))}
        </div>
      </div>

      {contractValue > 0 && (
        <div className="h-44 -ml-2">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="name" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 10 }} axisLine={false} tickLine={false} />
              <YAxis
                tick={{ fill: 'rgba(255,255,255,0.3)', fontSize: 10 }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `${Math.round(v / 1_000_000)}M`}
                width={38}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                contentStyle={{
                  background: '#0a1424', border: '1px solid rgba(255,255,255,0.12)',
                  borderRadius: 8, fontSize: 11,
                }}
                labelStyle={{ color: 'rgba(255,255,255,0.6)' }}
                formatter={(v, n) => [money(v), n === 'cumulative' ? 'Collected to date' : 'This stage']}
              />
              <Bar dataKey="amount" radius={[3, 3, 0, 0]}>
                {chartData.map((_, i) => <Cell key={i} fill={i === 0 ? '#e0c789' : '#1f3760'} stroke="#2a4a7a" />)}
              </Bar>
              <Line type="monotone" dataKey="cumulative" stroke="#c6a15b" strokeWidth={2} dot={{ r: 3, fill: '#c6a15b' }} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </>
  )
}

function QuoteModal({ onClose, quote }) {
  const addQuotation = useStore((s) => s.addQuotation)
  const updateQuotation = useStore((s) => s.updateQuotation)
  const templates = useStore((s) => s.mouTemplates)
  const t = useT()
  const editing = Boolean(quote)
  const [client, setClient] = useState(quote?.client ?? '')
  const [eventType, setEventType] = useState(quote?.eventType ?? '')
  const [eventDate, setEventDate] = useState(quote?.eventDate ?? '2026-12-01')
  // A quotation carries phased stages now. stagesFor() reads an old quote's
  // single `dpPercent` as a two-stage schedule, so nothing needs migrating.
  const [stages, setStages] = useState(() => stagesFor(quote).map((st) => ({ ...st })))
  const [template, setTemplate] = useState(quote?.template ?? DEFAULT_TEMPLATE)
  const [items, setItems] = useState(
    quote?.lineItems?.length
      ? quote.lineItems.map((l) => ({ label: l.label, amount: l.amount, estCost: l.estCost || 0 }))
      : DEFAULT_ITEMS
  )

  const total = items.reduce((a, l) => a + (Number(l.amount) || 0), 0)
  const cost = items.reduce((a, l) => a + (Number(l.estCost) || 0), 0)
  // LIVE margin, computed from sell minus cost. The previous implementation
  // was `const margin = total ? 30 : 0` with the comment "illustrative target".
  const margin = total ? ((total - cost) / total) * 100 : 0
  const schedule = resolveSchedule(stages, total, { signingDate: appToday(), eventDate })
  const dpAmount = schedule[0]?.amount ?? 0
  const scheduleError = validateSchedule(stages, total)

  const setField = (i, key, v) =>
    setItems((arr) => arr.map((l, idx) => (idx === i ? { ...l, [key]: key === 'label' ? v : Number(v) || 0 } : l)))
  const addItem = () => setItems((arr) => [...arr, { label: '', amount: 0, estCost: 0 }])
  const removeItem = (i) => setItems((arr) => (arr.length > 1 ? arr.filter((_, idx) => idx !== i) : arr))

  const submit = () => {
    if (!client || !eventType || scheduleError) return
    const payload = {
      client, eventType, eventDate, template,
      dpSchedule: stages,
      // Kept in step for anything that still reads a single DP percentage.
      dpPercent: total ? Math.round((dpAmount / total) * 1000) / 10 : 0,
      lineItems: items,
    }
    if (editing) updateQuotation(quote.id, payload)
    else addQuotation(payload)
    onClose()
  }

  const marginTone = margin >= 30 ? 'text-emerald-300' : margin >= 15 ? 'text-gold-light' : 'text-rose-300'

  return (
    <Modal
      title={editing ? `Edit ${quote.id}` : 'New Quotation'}
      subtitle={editing
        ? t('A sent quotation drops back to Draft when edited, so the client is re-sent the current numbers.')
        : t('Margin recalculates live from sell price minus estimated cost.')}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <div className="mr-auto flex items-center gap-4 text-xs">
            <span className="text-white/45">{t('Margin')}</span>
            <span className={`font-display text-lg tabular-nums ${marginTone}`}>{pct2(margin)}</span>
          </div>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={submit} disabled={!client || !eventType || Boolean(scheduleError)} className="btn-gold">
            <Plus size={14} /> {editing ? t('Save changes') : t('Create quotation')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Client">
          <TextInput value={client} onChange={(e) => setClient(e.target.value)} placeholder="e.g. Nimbus Retail" />
        </Field>
        <Field label="Event Type">
          <TextInput value={eventType} onChange={(e) => setEventType(e.target.value)} placeholder="e.g. Product Launch" />
        </Field>
        <Field label="Event Date">
          <TextInput type="date" value={eventDate} onChange={(e) => setEventDate(e.target.value)} />
        </Field>
      </div>

      {/* Phased down payment — presets, custom stages, and the simulation. */}
      <ScheduleEditor
        stages={stages}
        setStages={setStages}
        contractValue={total}
        eventDate={eventDate}
      />

      {/* Template switching drives the heading, clauses and signature block on
          the generated document. */}
      <Field label="Proposal / MoU template" hint={resolveTemplate(templates, template)?.validity}>
        <Select value={template} onChange={(e) => setTemplate(e.target.value)}>
          {templates.map((x) => (
            <option key={x.id} value={x.id}>{x.label} — {x.heading}</option>
          ))}
        </Select>
      </Field>
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="text-[10px] uppercase tracking-wider text-white/35 mb-1.5">{t('Clauses included')}</div>
        <ul className="space-y-1 text-[11px] text-white/55">
          {(resolveTemplate(templates, template)?.clauses || []).map((c, i) => (
            <li key={i} className="flex gap-1.5"><span className="text-gold/60">{i + 1}.</span><span>{c}</span></li>
          ))}
        </ul>
        {!(resolveTemplate(templates, template)?.clauses || []).length && (
          <div className="text-[11px] text-white/30">{t('This template carries no clauses yet.')}</div>
        )}
      </div>

      <div className="flex items-center justify-between pt-1">
        <div className="text-[11px] uppercase tracking-wider text-white/35">{t('Line Items')}</div>
        <button onClick={addItem} className="text-xs text-gold/80 hover:text-gold-light inline-flex items-center gap-1">
          <Plus size={12} /> {t('Add line')}
        </button>
      </div>

      <div className="hidden sm:grid grid-cols-12 gap-2 text-[10px] uppercase tracking-wider text-white/30">
        <span className="col-span-5">{t('Scope')}</span>
        <span className="col-span-3 text-right">{t('Sell price')}</span>
        <span className="col-span-3 text-right">{t('Est. cost')}</span>
      </div>

      {items.map((l, i) => {
        const lineMargin = l.amount ? ((l.amount - (l.estCost || 0)) / l.amount) * 100 : 0
        return (
          <div key={i} className="grid grid-cols-12 gap-2 items-center">
            <div className="col-span-12 sm:col-span-5">
              <TextInput value={l.label} onChange={(e) => setField(i, 'label', e.target.value)} placeholder="Scope item" />
            </div>
            <div className="col-span-5 sm:col-span-3">
              <NumberInput value={l.amount} onChange={(e) => setField(i, 'amount', e.target.value)} />
            </div>
            <div className="col-span-5 sm:col-span-3">
              <NumberInput value={l.estCost} onChange={(e) => setField(i, 'estCost', e.target.value)} />
            </div>
            <div className="col-span-2 sm:col-span-1 flex items-center justify-end gap-1">
              <span className={`text-[10px] tabular-nums hidden sm:inline ${
                lineMargin >= 30 ? 'text-emerald-400/70' : lineMargin >= 15 ? 'text-gold/70' : 'text-rose-400/70'
              }`}>
                {lineMargin.toFixed(0)}%
              </span>
              <button
                onClick={() => removeItem(i)}
                disabled={items.length <= 1}
                className="text-white/30 hover:text-rose-300 disabled:opacity-25"
                aria-label="Remove line"
              >
                <X size={14} />
              </button>
            </div>
          </div>
        )
      })}

      <div className="space-y-1.5 border-t border-white/10 pt-3">
        <div className="flex items-center justify-between">
          <span className="text-sm text-white/60">{t('Contract Value')}</span>
          <span className="font-display text-xl text-gold-light tabular-nums">{money2(total)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/40">{t('Estimated cost')}</span>
          <span className="text-white/60 tabular-nums">{money2(cost)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/40">{t('Gross profit')}</span>
          <span className={`tabular-nums ${marginTone}`}>{money2(total - cost)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/40">
            {t('Due on signing')} ({total ? ((dpAmount / total) * 100).toFixed(1) : '0.0'}%)
          </span>
          <span className="text-white/60 tabular-nums">{money2(dpAmount)}</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-white/40">{t('Billing stages')}</span>
          <span className="text-white/60 tabular-nums">{stages.length}</span>
        </div>
      </div>
    </Modal>
  )
}

export default function Quotations() {
  const quotations = useStore((s) => s.quotations)
  const sendQuotation = useStore((s) => s.sendQuotation)
  const acceptQuotation = useStore((s) => s.acceptQuotation)
  const cancelQuotation = useStore((s) => s.cancelQuotation)
  const templates = useStore((s) => s.mouTemplates)
  const role = useStore((s) => s.role)
  const t = useT()
  const navigate = useNavigate()
  const [modal, setModal] = useState(false)
  const [editing, setEditing] = useState(null)
  const [managingTemplates, setManagingTemplates] = useState(false)

  const pipeline = quotations.filter((q) => q.status !== 'Declined').reduce((a, q) => a + qValue(q), 0)
  const won = quotations.filter((q) => q.status === 'Accepted').reduce((a, q) => a + qValue(q), 0)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Sales · Contracts"
        title="Quotations & MoU"
        subtitle="Sales drafts a quote, sends it, and on client acceptance the system generates the MoU and pushes it to Finance as a ready deal — the very front of the pipeline."
        actions={
          <>
            <button onClick={() => setManagingTemplates(true)} className="btn-ghost">
              <FileCog size={15} /> {t('Manage Templates')}
            </button>
            <button onClick={() => setModal(true)} className="btn-gold">
              <Plus size={15} /> {t('New Quotation')}
            </button>
          </>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card><div className="text-xs text-white/40">{t('Open Pipeline')}</div><div className="mt-1 font-display text-xl text-white tabular-nums">{money(pipeline)}</div></Card>
        <Card><div className="text-xs text-white/40">{t('Accepted (Won)')}</div><div className="mt-1 font-display text-xl text-emerald-300 tabular-nums">{money(won)}</div></Card>
        <Card><div className="text-xs text-white/40">{t('Quotations')}</div><div className="mt-1 font-display text-xl text-white tabular-nums">{quotations.length}</div></Card>
        {/* Guarded: with no quotations this divided by zero and rendered "NaN%". Unreachable
            on seed data, which always had three, and reachable the moment the list comes from
            the API and is legitimately empty. */}
        <Card><div className="text-xs text-white/40">{t('Win Rate')}</div><div className="mt-1 font-display text-xl text-gold-light tabular-nums">{quotations.length ? Math.round((quotations.filter((q) => q.status === 'Accepted').length / quotations.length) * 100) : 0}%</div></Card>
      </div>

      <div className="space-y-3">
        {quotations.map((q) => (
          <Card key={q.id}>
            <div className="flex flex-wrap items-center gap-4">
              <span className="grid h-11 w-11 place-items-center rounded-xl bg-white/5 text-gold/70 shrink-0"><FileSignature size={20} /></span>
              <div className="min-w-[160px]">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs text-gold/80">{q.id}</span>
                  <Badge>{q.status}</Badge>
                  <span className="rounded-full border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] text-white/50">
                    {resolveTemplate(templates, q.template || DEFAULT_TEMPLATE)?.label}
                  </span>
                </div>
                <div className="text-sm text-white mt-0.5">{q.client} — {q.eventType}</div>
                <div className="text-[11px] text-white/40">
                  {t('Event')} {q.eventDate} · {dayCounter(q.eventDate)} · {q.createdBy}
                </div>
              </div>
              <div className="ml-auto text-right">
                <div className="text-sm text-white tabular-nums">{money2(qValue(q))}</div>
                {(() => {
                  const sched = resolveSchedule(stagesFor(q), qValue(q), {
                    signingDate: appToday(), eventDate: q.eventDate,
                  })
                  return (
                    <div className="text-[11px] text-white/40">
                      {t('DP')} {money(sched[0]?.amount || 0)} ({(sched[0]?.percent || 0).toFixed(0)}%)
                      {sched.length > 1 && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-gold/60">
                          <CalendarClock size={9} /> {sched.length} {t('stages')}
                        </span>
                      )}
                    </div>
                  )
                })()}
                {qCost(q) > 0 && (
                  <div className={`text-[11px] tabular-nums ${
                    qMargin(q) >= 30 ? 'text-emerald-300' : qMargin(q) >= 15 ? 'text-gold-light' : 'text-rose-300'
                  }`}>
                    {t('margin')} {pct2(qMargin(q))}
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2 w-full sm:w-auto justify-end">
                <button
                  onClick={() => quotationPDF(
                    q,
                    resolveTemplate(templates, q.template),
                    resolveSchedule(stagesFor(q), qValue(q), { signingDate: appToday(), eventDate: q.eventDate })
                  )}
                  className="btn-ghost text-xs py-1.5"
                >
                  <Download size={13} /> {q.status === 'Accepted' ? t('MoU') : t('PDF')}
                </button>
                {/* Editable up to acceptance. After that it is a live deal
                    Finance is acting on, so the store refuses the edit. */}
                {q.status !== 'Accepted' && q.status !== 'Declined' && (
                  <ActionButton
                    action="cancel_quotation"
                    role={role}
                    onClick={() => setEditing(q.id)}
                    className="btn-ghost text-xs py-1.5 disabled:opacity-30"
                  >
                    <Pencil size={13} /> {t('Edit')}
                  </ActionButton>
                )}
                {q.status === 'Draft' && (
                  <button onClick={() => sendQuotation(q.id)} className="btn-gold text-xs py-1.5"><Send size={13} /> {t('Send')}</button>
                )}
                {q.status === 'Sent' && (
                  <button onClick={() => acceptQuotation(q.id)} className="btn-gold text-xs py-1.5"><Check size={13} /> {t('Mark accepted')}</button>
                )}
                {q.status === 'Accepted' && (
                  <button onClick={() => navigate('/finance')} className="btn-ghost text-xs py-1.5 border-gold/40 text-gold-light">{t('To Finance')} <ArrowRight size={13} /></button>
                )}
                {/* Cancellation workflow (slide 2). Declining before a DP is
                    taken needs no refund decision — that only arises once a
                    project exists, and is handled on the Projects board. */}
                {q.status !== 'Declined' && q.status !== 'Accepted' && (
                  <ActionButton
                    action="cancel_quotation"
                    role={role}
                    onClick={() => cancelQuotation(q.id)}
                    className="btn-ghost text-xs py-1.5 border-rose-500/40 text-rose-300 disabled:opacity-30"
                  >
                    <Ban size={13} /> {t('Decline')}
                  </ActionButton>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>

      {managingTemplates && <TemplateManager onClose={() => setManagingTemplates(false)} />}
      {modal && <QuoteModal onClose={() => setModal(false)} />}
      {editing && (
        <QuoteModal
          quote={quotations.find((q) => q.id === editing) || null}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  )
}
