import { useCallback, useEffect, useState } from 'react'
import { Clock, Play, Gift, CheckCircle2, AlertTriangle, History, RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { useStore } from '../store/useStore'
import { adaptJob, adaptOps, adaptReminder, adaptRun } from '../store/jobAdapters'
import { canDo } from '../lib/roles'
import { PageHeader, Card, Badge } from '../components/ui'
import { formatDate } from '../lib/format'
import { useT } from '../i18n'

// The Daily Jobs screen against the real scheduler: what each job is, how its last run went, a
// way to run one (Finance and the CEO), the reminders the jobs have raised and a way to close them.
//
// The server decides what is due and when; this screen only reads it and asks. It does not draft
// WhatsApp or e-mail messages: the server raises a reminder (a subject and a detail) and nothing is
// sent from here.

const STATUS_TONE = { succeeded: 'text-emerald-300', failed: 'text-rose-300', skipped: 'text-white/50' }

function RunLine({ run }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-white/50">
      <span className={STATUS_TONE[run.status] || 'text-white/60'}>{run.status}</span>
      <span>for {run.runFor}</span>
      {run.finishedAt && <span>{formatDate(run.finishedAt.slice(0, 10))}</span>}
      {run.facts.map((f) => <span key={f.key}>{f.key}: {f.value}</span>)}
      {run.failure && <span className="text-rose-300">{run.failure}</span>}
    </div>
  )
}

export default function CronLive() {
  const role = useStore((s) => s.role)
  const pushToast = useStore((s) => s.pushToast)
  const t = useT()
  const mayRun = canDo(role, 'post_journal')

  const [jobs, setJobs] = useState(null)
  const [reminders, setReminders] = useState([])
  const [ops, setOps] = useState(null)
  const [history, setHistory] = useState({}) // job key -> runs
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      const [j, r, o] = await Promise.all([api.get('/jobs'), api.get('/reminders'), api.get('/ops/summary')])
      setJobs(j.map(adaptJob))
      setReminders(r.map(adaptReminder))
      setOps(adaptOps(o))
      setError(null)
    } catch (err) {
      setError(err?.message || 'Could not load the jobs.')
    }
  }, [])
  useEffect(() => { load() }, [load])

  const run = async (job) => {
    setBusy(job.key)
    try {
      const out = adaptRun(await api.post(`/jobs/${job.key}/run`, {}))
      pushToast({
        title: out.status === 'failed' ? 'The run failed' : out.status === 'skipped' ? 'Nothing to do' : 'Job ran',
        body: `${job.name} · ${out.status}${out.failure ? ` · ${out.failure}` : ''}`,
        kind: out.status === 'failed' ? 'redflag' : 'cron',
      })
      setHistory((h) => ({ ...h, [job.key]: undefined }))
      await load()
    } catch (err) {
      pushToast({ title: err?.status === 403 ? 'Not permitted' : 'The run did not start', body: err?.message || '', kind: 'redflag' })
    } finally {
      setBusy(null)
    }
  }

  const toggleHistory = async (job) => {
    if (open === job.key) { setOpen(null); return }
    setOpen(job.key)
    if (!history[job.key]) {
      try {
        const runs = await api.get(`/jobs/${job.key}/runs`, { limit: 10 })
        setHistory((h) => ({ ...h, [job.key]: runs.map(adaptRun) }))
      } catch (err) {
        pushToast({ title: 'Could not load the history', body: err?.message || '', kind: 'redflag' })
      }
    }
  }

  const resolve = async (reminder, status) => {
    try {
      await api.post(`/reminders/${reminder.id}/resolve`, { status })
      setReminders((rs) => rs.filter((r) => r.id !== reminder.id))
      setOps((o) => (o ? { ...o, openReminders: Math.max(0, o.openReminders - 1) } : o))
    } catch (err) {
      pushToast({ title: 'That did not save', body: err?.message || '', kind: 'redflag' })
    }
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Background Automation"
        title="Automated Cron Jobs"
        subtitle="What the server's scheduler runs each day, how the last run went, and the reminders it has raised for someone to act on."
        actions={
          <button onClick={load} className="btn-ghost"><RefreshCw size={15} /> {t('Refresh')}</button>
        }
      />

      {error && (
        <Card className="mb-4 border-amber-500/40 bg-amber-500/[0.06]">
          <div className="text-sm text-amber-200">{t('Could not load the jobs')}: {error}</div>
        </Card>
      )}

      {ops?.failedRuns?.length > 0 && (
        <Card className="mb-4 border-rose-500/40 bg-rose-500/[0.06]">
          <div className="flex items-center gap-2 text-sm text-rose-200">
            <AlertTriangle size={15} /> {ops.failedRuns.length} {t('recent run(s) failed')}
          </div>
          <div className="mt-2 space-y-1">
            {ops.failedRuns.slice(0, 3).map((r) => <div key={r.id}><span className="font-mono text-[11px] text-white/60">{r.jobKey}</span> <RunLine run={r} /></div>)}
          </div>
        </Card>
      )}

      <div className="grid lg:grid-cols-2 gap-4">
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Clock size={16} className="text-gold/70" />
            <div className="eyebrow">Scheduled Jobs</div>
          </div>
          {!jobs && !error && <div className="text-sm text-white/40">{t('Loading…')}</div>}
          <div className="space-y-2">
            {(jobs || []).map((j) => (
              <div key={j.key} className="rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="flex-1 min-w-[160px]">
                    <div className="text-sm text-white">{j.name}</div>
                    <div className="text-[11px] text-white/40">{j.schedule}</div>
                  </div>
                  {j.lastRun ? <Badge>{j.lastRun.status}</Badge> : <Badge>{t('never run')}</Badge>}
                  <button onClick={() => toggleHistory(j)} className="text-white/40 hover:text-white" title={t('History')} aria-label={`${t('History')}: ${j.name}`}>
                    <History size={14} />
                  </button>
                  {mayRun && (
                    <button onClick={() => run(j)} disabled={busy === j.key} className="btn-gold text-xs py-1.5">
                      <Play size={13} /> {busy === j.key ? t('Running…') : t('Run now')}
                    </button>
                  )}
                </div>
                {j.description && <div className="mt-1 text-[11px] text-white/35">{j.description}</div>}
                {j.lastRun && <div className="mt-2"><RunLine run={j.lastRun} /></div>}
                {open === j.key && (
                  <div className="mt-3 space-y-1.5 border-t border-white/10 pt-2">
                    {!history[j.key] && <div className="text-[11px] text-white/35">{t('Loading…')}</div>}
                    {(history[j.key] || []).map((r) => <RunLine key={r.id} run={r} />)}
                    {history[j.key]?.length === 0 && <div className="text-[11px] text-white/35">{t('No runs yet.')}</div>}
                  </div>
                )}
              </div>
            ))}
          </div>
          {!mayRun && (
            <div className="mt-4 text-[11px] text-white/40 border-t border-white/10 pt-3">
              {t('Jobs run on the server\'s schedule. Finance and the CEO can also run one by hand.')}
            </div>
          )}
        </Card>

        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Gift size={16} className="text-gold/70" />
            <div className="eyebrow">Open reminders</div>
          </div>
          {reminders.length === 0 ? (
            <div className="rounded-lg border border-dashed border-white/10 py-12 text-center">
              <CheckCircle2 size={28} className="mx-auto text-white/20" />
              <div className="mt-2 text-sm text-white/40">{t('Nothing is waiting. The daily jobs raise reminders here.')}</div>
            </div>
          ) : (
            <div className="space-y-3">
              {reminders.map((r) => (
                <div key={r.id} className="rounded-lg border border-gold/25 bg-gold/[0.05] p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-gold/15 text-gold-light shrink-0"><Gift size={17} /></span>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-white">{r.subject}</div>
                      <div className="text-xs text-white/50 mt-0.5">
                        {t(r.kindLabel)}{r.dueDate ? ` · ${formatDate(r.dueDate)}` : ''}{r.ref ? ` · ${r.ref}` : ''}
                      </div>
                      {r.detail && <div className="mt-1 text-xs text-white/40">{r.detail}</div>}
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button onClick={() => resolve(r, 'done')} className="btn-gold text-xs py-1.5">{t('Done')}</button>
                        <button onClick={() => resolve(r, 'dismissed')} className="btn-ghost text-xs py-1.5">{t('Dismiss')}</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11px] text-white/40 pt-1">
                {ops ? `${ops.openReminders} ${t('open')}` : ''}
              </div>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
