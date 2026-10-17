import { useState } from 'react'
import Modal from '../components/Modal'
import { Link } from 'react-router-dom'
import { ClipboardList, BadgeCheck, Check, AlertTriangle, Plus, Pencil, Trash2, UserX, UserCheck } from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  PageHeader, Card, TableWrap, money, money2, Badge, Select, ActionButton, Field, TextInput, NumberInput,
} from '../components/ui'
import { canDo } from '../lib/roles'
import { useT } from '../i18n'
import SurveyLinkButton from '../components/SurveyLinkButton'

export default function Payroll() {
  const crew = useStore((s) => s.crew)
  const projects = useStore((s) => s.projects)
  const role = useStore((s) => s.role)
  const latestFeedback = useStore((s) => s.latestFeedback)
  const incentivesPaid = useStore((s) => s.incentivesPaid)
  const disburseIncentives = useStore((s) => s.disburseIncentives)
  // Threshold is policy, held in the store next to the tax rates and the budget
  // tolerance rather than as a constant compiled into this component.
  const threshold = useStore((s) => s.bonusThreshold)
  const setBonusThreshold = useStore((s) => s.setBonusThreshold)
  const t = useT()

  // The allocation target is an explicit choice, not an inference. It defaults
  // to the project whose rating produced the pool, but the posting cannot
  // happen without one, so it has to be selectable.
  const [allocation, setAllocation] = useState('')
  const allocatable = projects.filter((p) => !p.cancelled)
  const projectId = allocation || latestFeedback?.projectId || ''
  const allocatedProject = allocatable.find((p) => p.id === projectId)

  // Bonus = base rate × (client rating / 10), gated by the minimum threshold.
  // Per the deck the driving score is the final event rating from the closed
  // project — so once feedback is registered, every crew row uses that single
  // event score. Before any closure we fall back to each member's last rating.
  const eventScore = latestFeedback?.score ?? null
  // Someone deactivated is left out of the pool (the server leaves them out too).
  const withBonus = crew.filter((c) => c.active !== false).map((c) => {
    const rating = eventScore ?? c.lastRating
    const qualifies = rating >= threshold
    const bonus = qualifies ? Math.round(c.baseRate * (rating / 10)) : 0
    return { ...c, rating, qualifies, bonus, total: c.baseRate + bonus }
  })

  const poolTotal = withBonus.reduce((a, c) => a + c.bonus, 0)
  const belowThreshold = withBonus.filter((c) => !c.qualifies).length

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Performance Pay"
        title="Crew & Feedback-Driven Incentives"
        subtitle="Bonuses are calculated from the client's post-event rating (scale 1–10) × the crew base rate, gated by a minimum-rating policy. Disbursing posts to the general ledger against the project."
        actions={
          <>
            <Link to="/survey" className="btn-ghost"><ClipboardList size={15} /> {t('Open client survey')}</Link>
            {/* The client's own link for the project chosen below (signed in, once it can be rated). */}
            <SurveyLinkButton project={allocatedProject} />
            {/* Mandatory allocation target - the posting is refused without it. */}
            <Select
              value={projectId}
              onChange={(e) => setAllocation(e.target.value)}
              className="w-auto"
              disabled={incentivesPaid}
            >
              <option value="">{t('— allocate to project —')}</option>
              {allocatable.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
            </Select>
            <ActionButton
              action="approve_incentive"
              role={role}
              onClick={() => disburseIncentives(poolTotal, projectId)}
              disabled={incentivesPaid || poolTotal <= 0 || !allocatedProject}
              title={!allocatedProject ? t('Pick a Project ID to allocate the cost to') : undefined}
            >
              <BadgeCheck size={15} />
              {incentivesPaid ? t('Incentive Disbursed ✓') : t('Approve & Disburse Incentive')}
            </ActionButton>
          </>
        }
      />

      {latestFeedback && (
        <Card className="mb-5 border-gold/40 bg-gradient-to-br from-gold/[0.1] to-transparent animate-pop">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-gold/15 text-gold-light shrink-0 text-lg">★</span>
            <div className="flex-1 min-w-[180px]">
              <div className="eyebrow mb-1">{t('Incentive Pool Recalculated · auto')}</div>
              <div className="text-sm text-white">
                {t('New client rating')} <span className="text-gold-light">{latestFeedback.score.toFixed(2)}/10</span> {t('from')}{' '}
                <span className="text-gold-light">{latestFeedback.name}</span>
              </div>
              {/* Mandatory project tag — the deck required explicit cost
                  allocation so the bonus lands on the right project's P&L. */}
              <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
                <span className="text-white/40">{t('Cost allocated to')}</span>
                <span className="font-mono text-gold/80">{latestFeedback.projectId}</span>
                {incentivesPaid && <Badge>Disbursed</Badge>}
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-white/40">{t('This cycle’s pool')}</div>
              <div className="font-display text-xl text-emerald-300 tabular-nums">{money2(poolTotal)}</div>
            </div>
          </div>
        </Card>
      )}

      <Card className="mb-5 border-gold/25 bg-gradient-to-br from-gold/[0.06] to-transparent">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="text-sm text-white">
              {t('Formula')}: <span className="text-gold-light">{t('Bonus = Base Rate × (Client Rating ÷ 10)')}</span>
            </div>
            <div className="text-xs text-white/50 mt-1">
              {t('Ratings captured via the client survey portal at project closure.')}
            </div>
          </div>
          {/* Policy, not a constant: editable by whoever sets policy. */}
          <div className="rounded-lg border border-white/15 bg-white/5 px-3 py-2 text-xs">
            <span className="text-white/45">{t('Minimum threshold')}</span>
            <div className="mt-1 flex items-center gap-1.5">
              <input
                type="number"
                step="0.5"
                min="0"
                max="10"
                value={threshold}
                onChange={(e) => setBonusThreshold(e.target.value)}
                disabled={!canDo(role, 'approve_incentive')}
                className="w-16 rounded-md border border-white/10 bg-navy-900 px-2 py-1 text-right text-sm tabular-nums text-gold-light focus:border-gold/50 outline-none disabled:opacity-40"
              />
              <span className="text-white/40">/ 10</span>
            </div>
          </div>
        </div>
        {belowThreshold > 0 && (
          <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2 text-[11px] text-amber-200">
            {belowThreshold} {t('crew member(s) below the threshold earn no bonus this cycle.')}
          </div>
        )}
      </Card>

      {!allocatedProject && poolTotal > 0 && (
        <Card className="mb-5 border-amber-500/30 bg-amber-500/[0.05]">
          <div className="flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span>
              {t('Pick a Project ID above before disbursing. Bonuses must be allocated to a project, or the cost lands on no P&L at all.')}
            </span>
          </div>
        </Card>
      )}

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Crew')}</th>
            <th className="th">{t('Role')}</th>
            <th className="th">{t('Project ID')}</th>
            <th className="th text-right">{t('Base Rate')}</th>
            <th className="th text-center">{t('Last Rating')}</th>
            <th className="th text-right">{t('Bonus')}</th>
            <th className="th text-right">{t('Total Payout')}</th>
          </tr>
        </thead>
        <tbody>
          {withBonus.map((c) => (
            <tr key={c.id}>
              <td className="td font-medium text-white">{c.name}</td>
              <td className="td text-white/60">{c.role}</td>
              <td className="td font-mono text-xs text-gold/80">{projectId || '—'}</td>
              <td className="td text-right tabular-nums">{money2(c.baseRate)}</td>
              <td className="td text-center">
                <span className={`tabular-nums ${c.rating >= 9 ? 'text-emerald-400' : c.rating >= threshold ? 'text-gold-light' : 'text-rose-300'}`}>
                  {c.rating.toFixed(2)}
                </span>
                <span className="text-white/30 text-xs"> / 10</span>
                {eventScore != null && <span className="ml-1 text-[9px] uppercase tracking-wider text-gold/60">{t('event')}</span>}
              </td>
              <td className="td text-right tabular-nums">
                {c.qualifies
                  ? <span className="text-emerald-300">{money2(c.bonus)}</span>
                  : <span className="text-white/30" title={t('Below minimum rating threshold')}>{money2(0)}</span>}
              </td>
              <td className="td text-right tabular-nums text-white">{money2(c.total)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-white/15">
            <td className="td text-white/50 uppercase text-xs" colSpan={5}>{t('Incentive pool')}</td>
            <td className="td text-right tabular-nums text-emerald-300 font-medium">{money2(poolTotal)}</td>
            <td className="td text-right tabular-nums text-white font-medium">
              {money2(withBonus.reduce((a, c) => a + c.total, 0))}
            </td>
          </tr>
        </tfoot>
      </TableWrap>

      {incentivesPaid && (
        <div className="mt-3 inline-flex items-center gap-1.5 text-xs text-emerald-300">
          <Check size={13} /> {t('Posted to the general ledger')} · 5102 Event COGS — Crew / 1101 Main Bank Cash
        </div>
      )}

      <div className="mt-3 text-[11px] text-white/30">
        {t('Base rates shown per event, not monthly.')} {t('Pool')}: {money(poolTotal)}
      </div>

      <ManageCrew crew={crew} role={role} />
    </div>
  )
}

/** Add, edit, deactivate or remove crew. A pool that was already paid keeps who was paid and how
 *  much; a new rate applies to pools not yet disbursed. Deleting is for a mistake: once someone may have
 *  been paid they can only be deactivated (the server says so). */
function ManageCrew({ crew, role }) {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const { addCrew, updateCrew, setCrewActive, deleteCrew } = useStore.getState()
  const [editing, setEditing] = useState(null) // a crew member, or {} for a new one
  const can = canDo(role, 'approve_incentive')
  if (!live || !can) return null

  const remove = (c) => {
    if (window.confirm(t('Remove this crew member? This is only for someone added by mistake; anyone who may have been paid can only be deactivated.'))) deleteCrew(c.id)
  }
  return (
    <Card className="mt-6">
      <div className="mb-3 flex items-center gap-2">
        <div className="eyebrow">{t('Manage crew')}</div>
        <button type="button" className="btn-ghost ml-auto !py-1.5 text-xs" onClick={() => setEditing({})}><Plus size={14} />{t('Add crew member')}</button>
      </div>
      <div className="divide-y divide-white/5">
        {crew.map((c) => (
          <div key={c.id} className="flex flex-wrap items-center gap-3 py-2 text-sm">
            <span className={`min-w-[10rem] ${c.active === false ? 'text-white/35 line-through' : 'text-white/85'}`}>{c.name}</span>
            <span className="text-xs text-white/45">{c.role || '—'}</span>
            <span className="text-xs tabular-nums text-white/55">{money2(c.baseRate)}</span>
            {c.active === false && <Badge>Deactivated</Badge>}
            <span className="ml-auto flex gap-2">
              <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setEditing(c)}><Pencil size={13} />{t('Edit')}</button>
              <button type="button" className="btn-ghost !py-1 text-xs" onClick={() => setCrewActive(c.id, c.active === false)}>
                {c.active === false ? <UserCheck size={13} /> : <UserX size={13} />}{t(c.active === false ? 'Reactivate' : 'Deactivate')}
              </button>
              <button type="button" className="text-white/30 hover:text-rose-300" onClick={() => remove(c)} aria-label={`${t('Remove')} ${c.name}`}><Trash2 size={14} /></button>
            </span>
          </div>
        ))}
        {!crew.length && <div className="py-3 text-sm text-white/35">{t('No crew yet.')}</div>}
      </div>
      {editing && (
        <CrewForm
          member={editing}
          onClose={() => setEditing(null)}
          onSave={async (draft) => {
            const out = editing.id ? await updateCrew(editing.id, draft) : await addCrew(draft)
            if (out?.ok !== false) setEditing(null)
          }}
        />
      )}
    </Card>
  )
}

function CrewForm({ member, onClose, onSave }) {
  const t = useT()
  const [form, setForm] = useState({
    name: member.name || '', role: member.role || '', baseRate: member.baseRate ?? '', lastRating: member.lastRating ?? 0,
  })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    await onSave(form)
    setBusy(false)
  }
  return (
    <Modal title={member.id ? 'Edit crew member' : 'Add crew member'} subtitle="A pool already paid keeps its own figures" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Name"><TextInput value={form.name} onChange={set('name')} required autoFocus /></Field>
        <Field label="Role"><TextInput value={form.role} onChange={set('role')} /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Base rate (per event)"><NumberInput min="0" value={form.baseRate} onChange={set('baseRate')} required /></Field>
          <Field label="Last rating (0–10)"><NumberInput min="0" max="10" step="0.5" value={form.lastRating} onChange={set('lastRating')} /></Field>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn-gold text-xs" disabled={busy}>{t('Save')}</button>
        </div>
      </form>
    </Modal>
  )
}
