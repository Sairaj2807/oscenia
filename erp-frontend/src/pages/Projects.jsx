import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronRight, ChevronLeft, KanbanSquare, GanttChartSquare, XCircle, Ban } from 'lucide-react'
import { useStore } from '../store/useStore'
import { STAGES } from '../store/seed'
import { PageHeader, money, money2, Card, Badge, ActionButton, Field, Select } from '../components/ui'
import { canDo, denialReason } from '../lib/roles'
import Modal from '../components/Modal'
import { dayCounter, daysUntil, daysSince } from '../lib/format'
import { useT } from '../i18n'

const STAGE_ACCENT = {
  'DP Paid': 'border-t-gold',
  'Design Uploaded': 'border-t-sky-400',
  'Client Approval': 'border-t-violet-400',
  'Vendor Dispatch': 'border-t-amber-400',
  'Execution Event': 'border-t-emerald-400',
  'Post-Event Feedback': 'border-t-pink-400',
  'Finished': 'border-t-white/40',
}

const DIVISIONS = ['Sales', 'Design', 'Warehouse', 'Field']
const DIV_COLOR = {
  Sales: { bar: 'bg-gold', dot: 'bg-gold' },
  Design: { bar: 'bg-sky-400', dot: 'bg-sky-400' },
  Warehouse: { bar: 'bg-violet-400', dot: 'bg-violet-400' },
  Field: { bar: 'bg-emerald-400', dot: 'bg-emerald-400' },
}

function Progress({ stage }) {
  const idx = STAGES.indexOf(stage)
  const pct = ((idx + 1) / STAGES.length) * 100
  return (
    <div className="mt-3 h-1 w-full rounded-full bg-white/10 overflow-hidden">
      <div className="h-full rounded-full bg-gold" style={{ width: `${pct}%` }} />
    </div>
  )
}

// ---------- Board (Kanban — 7 stage columns) ----------
function Board({ projects, advanceStage, revertStage, onCancel, role, justCreatedId, navigate, t }) {
  const moveProjectToStage = useStore((s) => s.moveProjectToStage)
  const pushToast = useStore((s) => s.pushToast)
  const [dragging, setDragging] = useState(null)
  const [overStage, setOverStage] = useState(null)

  // A role may be allowed to move a card forward but not back (Sales can
  // advance, only Finance/PM/CEO can revert), so the direction is what decides
  // — and it is only knowable on drop.
  const canMove = canDo(role, 'advance_stage') || canDo(role, 'revert_stage')

  const drop = (stage) => {
    setOverStage(null)
    const card = dragging
    setDragging(null)
    if (!card || card.stage === stage) return
    const forward = STAGES.indexOf(stage) > STAGES.indexOf(card.stage)
    const action = forward ? 'advance_stage' : 'revert_stage'
    if (!canDo(role, action)) {
      pushToast({ title: 'Not permitted', body: denialReason(role, action), kind: 'redflag' })
      return
    }
    moveProjectToStage(card.id, stage)
  }

  return (
    <div className="overflow-x-auto pb-4 -mx-1 px-1">
      <div className="flex gap-4 min-w-max">
        {STAGES.map((stage) => {
          const cards = projects.filter((p) => p.stage === stage)
          return (
            <div
              key={stage}
              className={`w-[248px] shrink-0 rounded-xl transition-colors ${
                overStage === stage && dragging?.stage !== stage
                  ? 'bg-gold/[0.07] ring-1 ring-gold/30'
                  : ''
              }`}
              onDragOver={(e) => { if (dragging) { e.preventDefault(); setOverStage(stage) } }}
              onDragLeave={() => setOverStage((cur) => (cur === stage ? null : cur))}
              onDrop={(e) => { e.preventDefault(); drop(stage) }}
            >
              <div className="flex items-center justify-between px-1 mb-3">
                <span className="text-xs font-medium uppercase tracking-wider text-white/60">{t(stage)}</span>
                <span className="grid h-5 min-w-5 place-items-center rounded-full bg-white/10 px-1.5 text-[11px] text-white/60">
                  {cards.length}
                </span>
              </div>
              <div className="space-y-3">
                {cards.map((p) => {
                  const highlight = p.id === justCreatedId
                  return (
                    <div
                      key={p.id}
                      draggable={canMove}
                      onDragStart={(e) => { setDragging(p); e.dataTransfer.effectAllowed = 'move' }}
                      onDragEnd={() => { setDragging(null); setOverStage(null) }}
                      className={`card border-t-2 ${STAGE_ACCENT[stage]} p-4 ${
                        highlight ? 'animate-pop ring-2 ring-gold' : ''
                      } ${canMove ? 'cursor-grab active:cursor-grabbing' : ''} ${
                        dragging?.id === p.id ? 'opacity-40' : ''
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] text-gold/80">{p.id}</span>
                        <span className="text-[10px] text-white/40">{p.division}</span>
                      </div>
                      <button onClick={() => navigate(`/projects/${p.id}`)} className="mt-1.5 block text-left text-sm font-medium text-white hover:text-gold-light">
                        {p.name}
                      </button>
                      <div className="mt-1 text-xs text-white/40">{p.client}</div>
                      {/* Duration tracking: how long to the event, and how long
                          this card has been sitting in its current stage. */}
                      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                        <span className={`rounded px-1.5 py-0.5 border ${
                          (daysUntil(p.eventDate) ?? 99) < 14
                            ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                            : 'border-white/10 bg-white/5 text-white/50'
                        }`}>
                          {dayCounter(p.eventDate) || '—'}
                        </span>
                        {p.stageSince && (
                          <span className="rounded border border-white/10 bg-white/5 px-1.5 py-0.5 text-white/40">
                            {daysSince(p.stageSince)}d {t('in stage')}
                          </span>
                        )}
                      </div>
                      <Progress stage={stage} />
                      <div className="mt-3 flex items-center justify-between gap-1">
                        <span className="text-xs text-white/60 tabular-nums">{money(p.contractValue)}</span>
                        <div className="flex items-center gap-1.5">
                          {/* Back / Cancel, asked for three times on slide 3.
                              Stepping back undoes what the forward step set off. */}
                          {STAGES.indexOf(stage) > 0 && (
                            <ActionButton
                              action="revert_stage"
                              role={role}
                              onClick={() => revertStage(p.id)}
                              title={t('Move back a stage')}
                              className="inline-flex items-center text-[11px] text-white/40 hover:text-white disabled:opacity-25 disabled:cursor-not-allowed"
                            >
                              <ChevronLeft size={13} />
                            </ActionButton>
                          )}
                          {stage !== 'Finished' && (
                            <ActionButton
                              action="advance_stage"
                              role={role}
                              onClick={() => advanceStage(p.id)}
                              className="inline-flex items-center gap-0.5 text-[11px] text-gold/70 hover:text-gold-light disabled:opacity-25 disabled:cursor-not-allowed"
                            >
                              {t('advance')} <ChevronRight size={13} />
                            </ActionButton>
                          )}
                          <ActionButton
                            action="cancel_project"
                            role={role}
                            onClick={() => onCancel(p)}
                            title={t('Cancel project')}
                            className="inline-flex items-center text-[11px] text-white/30 hover:text-rose-300 disabled:opacity-20 disabled:cursor-not-allowed"
                          >
                            <XCircle size={13} />
                          </ActionButton>
                        </div>
                      </div>
                    </div>
                  )
                })}
                {cards.length === 0 && (
                  <div className={`rounded-lg border border-dashed py-8 text-center text-[11px] transition-colors ${
                    overStage === stage
                      ? 'border-gold/40 text-gold/70'
                      : 'border-white/10 text-white/20'
                  }`}>
                    {overStage === stage ? t('drop here') : t('empty')}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------- Timeline (Gantt) ----------
const MONTHS = [
  { key: '2026-06', label: 'Jun' }, { key: '2026-07', label: 'Jul' },
  { key: '2026-08', label: 'Aug' }, { key: '2026-09', label: 'Sep' },
  { key: '2026-10', label: 'Oct' }, { key: '2026-11', label: 'Nov' },
  { key: '2026-12', label: 'Dec' },
]
const AXIS_START = new Date('2026-06-01').getTime()
const AXIS_END = new Date('2026-12-31').getTime()
const span = AXIS_END - AXIS_START
const pctOf = (t) => Math.max(0, Math.min(100, ((t - AXIS_START) / span) * 100))

function Timeline({ projects, navigate, division, t }) {
  const rows = projects
    .filter((p) => division === 'All' || p.division === division)
    .filter((p) => p.eventDate)
    .sort((a, b) => (a.eventDate < b.eventDate ? -1 : 1))

  return (
    <div className="card p-5 overflow-x-auto">
      <div className="min-w-[640px]">
        {/* month axis */}
        <div className="flex ml-[220px] border-b border-white/10 pb-2 mb-3">
          {MONTHS.map((m) => (
            <div key={m.key} className="flex-1 text-[11px] uppercase tracking-wider text-white/40 text-center">{m.label}</div>
          ))}
        </div>

        <div className="space-y-3">
          {rows.map((p) => {
            const end = new Date(p.eventDate).getTime()
            const start = end - 50 * 24 * 3600 * 1000 // ~50-day prep window
            const left = pctOf(start)
            const width = Math.max(4, pctOf(end) - left)
            const c = DIV_COLOR[p.division] || DIV_COLOR.Sales
            return (
              <div key={p.id} className="flex items-center">
                <button
                  onClick={() => navigate(`/projects/${p.id}`)}
                  className="w-[220px] shrink-0 pr-3 text-left"
                >
                  <div className="text-sm text-white truncate hover:text-gold-light">{p.name}</div>
                  <div className="flex items-center gap-1.5 text-[11px] text-white/40">
                    <span className={`h-2 w-2 rounded-full ${c.dot}`} /> {p.division} · {p.eventDate}
                  </div>
                </button>
                <div className="relative flex-1 h-8">
                  {/* month gridlines */}
                  <div className="absolute inset-0 flex">
                    {MONTHS.map((m) => <div key={m.key} className="flex-1 border-l border-white/5" />)}
                  </div>
                  {/* bar */}
                  <div
                    className={`absolute top-1.5 h-5 rounded-md ${c.bar} opacity-80 flex items-center justify-end pr-2`}
                    style={{ left: `${left}%`, width: `${width}%` }}
                    title={`${p.name} — ${t(p.stage)}`}
                  >
                    <span className="text-[10px] text-navy-950 font-medium tabular-nums">{money(p.contractValue)}</span>
                  </div>
                </div>
              </div>
            )
          })}
          {!rows.length && <div className="text-sm text-white/30 py-8 text-center">{t('No projects in this division.')}</div>}
        </div>

        {/* legend */}
        <div className="flex flex-wrap gap-4 mt-5 pt-4 border-t border-white/10">
          {DIVISIONS.map((d) => (
            <div key={d} className="flex items-center gap-1.5 text-[11px] text-white/50">
              <span className={`h-2.5 w-2.5 rounded-full ${DIV_COLOR[d].dot}`} /> {d}
            </div>
          ))}
          <span className="text-[11px] text-white/30 ml-auto">{t('Bar = prep window to event date')}</span>
        </div>
      </div>
    </div>
  )
}

// Cancellation asks the refundable / non-refundable question from slide 2,
// because the answer changes what happens to money already taken.
function CancelProjectModal({ project, onClose }) {
  const cancelProject = useStore((s) => s.cancelProject)
  const invoices = useStore((s) => s.invoices)
  const t = useT()
  const [refund, setRefund] = useState('non')
  const [reason, setReason] = useState('')

  const received = invoices
    .filter((i) => i.project === project.id && i.status === 'Paid')
    .reduce((a, i) => a + i.amount, 0)

  return (
    <Modal
      title="Cancel Project"
      subtitle={`${project.id} — ${project.name}`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Keep project')}</button>
          <button
            onClick={() => { cancelProject(project.id, { refundDp: refund === 'refund', reason }); onClose() }}
            className="btn-gold"
          >
            <Ban size={14} /> {t('Cancel project')}
          </button>
        </>
      }
    >
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-1.5 text-xs">
        <div className="flex justify-between"><span className="text-white/40">{t('Received to date')}</span><span className="tabular-nums text-white/85">{money2(received)}</span></div>
        <div className="flex justify-between"><span className="text-white/40">{t('Cost incurred')}</span><span className="tabular-nums text-white/85">{money2(project.realizedCost)}</span></div>
      </div>

      <Field label="Down payment treatment">
        <Select value={refund} onChange={(e) => setRefund(e.target.value)}>
          <option value="non">{t('Non-refundable — retain the DP')}</option>
          <option value="refund">{t('Refundable — reverse and return the DP')}</option>
        </Select>
      </Field>

      <Field label="Reason (optional)">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('e.g. client postponed indefinitely')}
          className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none"
        />
      </Field>

      <div className={`rounded-lg border p-3 text-xs ${
        refund === 'refund' ? 'border-rose-500/40 bg-rose-500/[0.06] text-rose-200' : 'border-white/10 bg-white/[0.02] text-white/60'
      }`}>
        {refund === 'refund'
          ? t('Client receipts will be reversed in the ledger — cash goes back out and the revenue is unwound. Costs already incurred stay as a loss.')
          : t('Revenue already recognised stays. Costs already incurred stay. Nothing is reversed.')}
        {' '}{t('Live purchase orders on this project will be cancelled and their payments reversed.')}
      </div>
    </Modal>
  )
}

export default function Projects() {
  const projects = useStore((s) => s.projects)
  const advanceStage = useStore((s) => s.advanceStage)
  const revertStage = useStore((s) => s.revertStage)
  const role = useStore((s) => s.role)
  const justCreatedId = useStore((s) => s.justCreatedId)
  const clearJustCreated = useStore((s) => s.clearJustCreated)
  const navigate = useNavigate()
  const t = useT()
  const [view, setView] = useState('board')
  const [division, setDivision] = useState('All')
  const [cancelling, setCancelling] = useState(null)

  const live = projects.filter((p) => !p.cancelled)
  const cancelled = projects.filter((p) => p.cancelled)

  useEffect(() => {
    if (justCreatedId) {
      const timer = setTimeout(clearJustCreated, 2500)
      return () => clearTimeout(timer)
    }
  }, [justCreatedId, clearJustCreated])

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Production Workflow"
        title="Projects — Pipeline Board"
        subtitle="Kanban across the seven production milestones. Drag a card between columns to move a project, or use the arrows on each card. New projects appear automatically when a down payment is confirmed in Finance."
        actions={
          <div className="flex rounded-lg border border-white/15 overflow-hidden">
            <button onClick={() => setView('board')} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${view === 'board' ? 'bg-gold text-navy-950' : 'text-white/60 hover:text-white'}`}>
              <KanbanSquare size={15} /> {t('Board')}
            </button>
            <button onClick={() => setView('timeline')} className={`inline-flex items-center gap-1.5 px-3 py-2 text-sm ${view === 'timeline' ? 'bg-gold text-navy-950' : 'text-white/60 hover:text-white'}`}>
              <GanttChartSquare size={15} /> {t('Timeline')}
            </button>
          </div>
        }
      />

      {view === 'timeline' && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <span className="text-xs text-white/40">{t('Division')}:</span>
          {['All', ...DIVISIONS].map((d) => (
            <button
              key={d}
              onClick={() => setDivision(d)}
              className={`rounded-full px-3 py-1 text-xs transition-colors ${
                division === d ? 'bg-gold/20 text-gold-light border border-gold/40' : 'border border-white/15 text-white/60 hover:text-white'
              }`}
            >
              {t(d)}
            </button>
          ))}
        </div>
      )}

      {view === 'board'
        ? <Board
          projects={live}
          advanceStage={advanceStage}
          revertStage={revertStage}
          onCancel={setCancelling}
          role={role}
          justCreatedId={justCreatedId}
          navigate={navigate}
          t={t}
        />
        : <Timeline projects={live} navigate={navigate} division={division} t={t} />}

      {/* Cancelled projects stay visible but out of the working board. */}
      {cancelled.length > 0 && (
        <Card className="mt-5 border-rose-500/25">
          <div className="flex items-center gap-2 mb-3">
            <Ban size={15} className="text-rose-300" />
            <div className="eyebrow">{t('Cancelled')} ({cancelled.length})</div>
          </div>
          <div className="space-y-2">
            {cancelled.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-2.5 opacity-70">
                <span className="font-mono text-xs text-gold/70">{p.id}</span>
                <span className="text-sm text-white/80 flex-1 min-w-[140px]">{p.name}</span>
                <span className="text-xs text-white/40">{p.cancelReason || t('no reason given')}</span>
                <Badge>{p.dpRefunded ? 'DP refunded' : 'DP retained'}</Badge>
                <span className="text-xs text-white/50 tabular-nums">{money(p.contractValue)}</span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {cancelling && <CancelProjectModal project={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  )
}
