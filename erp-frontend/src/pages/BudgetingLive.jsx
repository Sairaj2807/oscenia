import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Pencil, Plus, Trash2 } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store/useStore'
import { adaptAlerts, adaptBudget, budgetBody, defaultBudgetRows } from '../store/budgetAdapters'
import { canDo } from '../lib/roles'
import { PageHeader, Card, Select, TextInput, NumberInput, money } from '../components/ui'
import Modal from '../components/Modal'
import { formatDate } from '../lib/format'
import { useT } from '../i18n'

// Budgeting against the server's per-project budgets: pick a project, see each category's ceiling
// against what the ledger says was spent, edit the ceilings (Finance and the CEO), and see which
// projects have been flagged for running past their tolerance. What is "spent" is worked out from
// the ledger every time; nothing here posts a cost (the demo's "log unplanned cost" is gone: a real
// cost is posted by a purchase order, an expense or a procurement request).

function Bar({ cat }) {
  const pct = cat.ceiling ? Math.round((cat.spent / cat.ceiling) * 100) : cat.spent ? 100 : 0
  const color = cat.over ? 'bg-rose-500' : pct > 85 ? 'bg-amber-400' : 'bg-gold'
  return (
    <div className={`rounded-xl border p-4 ${cat.over ? 'border-rose-500/50 bg-rose-500/[0.06]' : 'border-white/10 bg-white/[0.02]'}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-white flex items-center gap-2">
          {cat.label}
          {cat.over && <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-rose-300"><AlertTriangle size={12} /> over</span>}
        </span>
        <span className="text-xs tabular-nums text-white/60">{money(cat.spent)} / {money(cat.ceiling)}</span>
      </div>
      <div className="h-2.5 rounded-full bg-white/10 overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      <div className="mt-1.5 flex items-center justify-between text-[11px]">
        <span className="text-white/40">{pct}% of ceiling · {cat.codes.join(', ')}</span>
        <span className={cat.over ? 'text-rose-300' : 'text-emerald-300/80'}>
          {cat.over ? `${money(cat.spent - cat.ceiling)} over` : `${money(cat.ceiling - cat.spent)} left`}
        </span>
      </div>
    </div>
  )
}

function Editor({ rows: initial, costAccounts, onSave, onClose, saving }) {
  const t = useT()
  const [rows, setRows] = useState(initial)
  const [error, setError] = useState(null)
  const set = (i, patch) => setRows((rs) => rs.map((r, k) => (k === i ? { ...r, ...patch } : r)))
  const toggleCode = (i, code) => set(i, { codes: rows[i].codes.includes(code) ? rows[i].codes.filter((c) => c !== code) : [...rows[i].codes, code] })
  const save = () => {
    const { body, error: bad } = budgetBody(rows)
    if (bad) { setError(bad); return }
    setError(null)
    onSave(body)
  }
  return (
    <Modal
      title="Budget ceilings"
      subtitle={t('Each ceiling is measured against the cost accounts you tick; what was spent comes from the ledger.')}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto text-[11px] text-amber-300">{error}</span>}
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={save} disabled={saving} className="btn-gold">{saving ? t('Saving…') : t('Save budget')}</button>
        </>
      }
    >
      <div className="space-y-3">
        {rows.map((r, i) => (
          <div key={i} className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
            <div className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-7"><TextInput value={r.label} onChange={(e) => set(i, { label: e.target.value })} placeholder={t('Category name')} /></div>
              <div className="col-span-4"><NumberInput value={r.ceiling} onChange={(e) => set(i, { ceiling: e.target.value })} min={0} /></div>
              <button onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))} className="col-span-1 text-white/30 hover:text-rose-300" aria-label={t('Remove category')}><Trash2 size={14} /></button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {costAccounts.map((a) => (
                <button
                  key={a.code}
                  onClick={() => toggleCode(i, a.code)}
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${r.codes.includes(a.code) ? 'border-gold/45 bg-gold/15 text-gold-light' : 'border-white/12 bg-white/5 text-white/55'}`}
                >
                  {a.code} {a.name.replace(/^Event COGS\s*[—-]\s*/, '')}
                </button>
              ))}
            </div>
          </div>
        ))}
        <button onClick={() => setRows((rs) => [...rs, { key: '', label: '', ceiling: 0, codes: [] }])} className="text-xs text-gold/80 hover:text-gold-light inline-flex items-center gap-1">
          <Plus size={12} /> {t('Add category')}
        </button>
      </div>
    </Modal>
  )
}

export default function BudgetingLive() {
  const t = useT()
  const projects = useStore((s) => s.projects)
  const accounts = useStore((s) => s.accounts)
  const role = useStore((s) => s.role)
  const tolerance = useStore((s) => s.budgetTolerancePct)
  const pushToast = useStore((s) => s.pushToast)
  const mayEdit = canDo(role, 'approve_cash')

  const live = useMemo(() => projects.filter((p) => !p.cancelled && p.uuid), [projects])
  const [projectNo, setProjectNo] = useState('')
  const project = live.find((p) => p.id === projectNo) || live[0]
  const costAccounts = useMemo(() => accounts.filter((a) => (a.type === 'cogs' || a.code === '6901') && a.active !== false), [accounts])

  const [budget, setBudget] = useState(undefined) // undefined = loading, null = none set
  const [alerts, setAlerts] = useState([])
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    if (!project) return
    setBudget(undefined)
    try {
      setBudget(adaptBudget(await api.get(`/projects/${project.uuid}/budget`)))
      setError(null)
    } catch (err) {
      if (err?.status === 404) setBudget(null)
      else setError(err?.message || 'Could not load the budget.')
    }
  }, [project])
  useEffect(() => { load() }, [load])

  const loadAlerts = useCallback(async () => {
    try { setAlerts(adaptAlerts(await api.get('/alerts/budget-breaches'), projects)) } catch { /* the bars still work */ }
  }, [projects])
  useEffect(() => { loadAlerts() }, [loadAlerts])

  const save = async (body) => {
    setSaving(true)
    try {
      await api.put(`/projects/${project.uuid}/budget`, body)
      setEditing(false)
      await load()
      pushToast({ title: 'Budget saved', body: project.id, kind: 'finance' })
    } catch (err) {
      pushToast({ title: err?.status === 403 ? 'Not permitted' : 'That did not save', body: err?.message || '', kind: 'redflag' })
    } finally {
      setSaving(false)
    }
  }

  const editorRows = budget
    ? budget.categories.map((c) => ({ key: c.key, label: c.label, ceiling: c.ceiling, codes: c.codes }))
    : defaultBudgetRows(costAccounts)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Cost Control"
        title="Budgeting System"
        subtitle="Expenditure ceilings against what the ledger says was spent, per project. Spend is worked out from postings every time, so the plan and the reality cannot drift."
        actions={
          <>
            <Select value={project?.id || ''} onChange={(e) => setProjectNo(e.target.value)} className="w-auto">
              {live.map((p) => <option key={p.id} value={p.id}>{p.id} — {p.name}</option>)}
            </Select>
            {mayEdit && project && (
              <button onClick={() => setEditing(true)} className="btn-gold">
                <Pencil size={15} /> {budget ? t('Edit ceilings') : t('Set a budget')}
              </button>
            )}
          </>
        }
      />

      {!project && <Card><div className="text-sm text-white/50">{t('There is no live project to budget yet.')}</div></Card>}
      {error && <Card className="mb-4 border-amber-500/40 bg-amber-500/[0.06]"><div className="text-sm text-amber-200">{error}</div></Card>}

      {project && budget === null && (
        <Card className="mb-4">
          <div className="text-sm text-white">{t('No budget is set for')} {project.id}.</div>
          <div className="mt-1 text-xs text-white/50">
            {mayEdit ? t('Set ceilings per cost category to start tracking spend against them.') : t('Finance or the CEO can set one.')}
          </div>
        </Card>
      )}

      {budget && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
            <Card><div className="text-xs text-white/40">Total Ceiling</div><div className="mt-1 font-display text-xl text-white tabular-nums">{money(budget.totalCeiling)}</div></Card>
            <Card><div className="text-xs text-white/40">Spent</div><div className="mt-1 font-display text-xl text-white tabular-nums">{money(budget.totalSpent)}</div></Card>
            <Card><div className="text-xs text-white/40">Remaining</div><div className={`mt-1 font-display text-xl tabular-nums ${budget.totalRemaining < 0 ? 'text-rose-400' : 'text-emerald-300'}`}>{money(budget.totalRemaining)}</div></Card>
            <Card><div className="text-xs text-white/40">Utilization</div><div className="mt-1 font-display text-xl text-gold-light tabular-nums">{Math.round(budget.utilisation)}%</div></Card>
          </div>
          <div className="grid sm:grid-cols-2 gap-4">
            {budget.categories.map((c) => <Bar key={c.key} cat={c} />)}
          </div>
        </>
      )}

      <Card className="mt-6">
        <div className="eyebrow mb-2">{t('Projects flagged for running over')}</div>
        <div className="text-[11px] text-white/40 mb-3">
          {t('A project is flagged once, when total spend passes its estimate by the tolerance')} ({tolerance}%). {t('The check runs when a procurement request is disbursed.')}
        </div>
        {alerts.length === 0 ? (
          <div className="text-sm text-white/40">{t('No project has been flagged.')}</div>
        ) : (
          <div className="space-y-2">
            {alerts.map((a) => (
              <div key={a.projectId} className="flex flex-wrap items-center gap-3 rounded-lg border border-rose-500/30 bg-rose-500/[0.05] px-4 py-2.5 text-sm">
                <AlertTriangle size={14} className="text-rose-300" />
                <span className="text-white">{a.project || a.projectId}{a.name ? ` — ${a.name}` : ''}</span>
                <span className="text-white/50">{money(a.spent)} {t('of')} {money(a.ceiling)}</span>
                <span className="text-rose-300">{money(a.overBy)} {t('over')}</span>
                <span className="ml-auto text-[11px] text-white/40">{formatDate(a.raisedOn)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      {editing && <Editor rows={editorRows} costAccounts={costAccounts} onSave={save} onClose={() => setEditing(false)} saving={saving} />}
    </div>
  )
}
