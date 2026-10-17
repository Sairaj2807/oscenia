import { useState } from 'react'
import { Clock, Play, Gift, MessageCircle, CheckCircle2, X, Mail, Send } from 'lucide-react'
import { useStore } from '../store/useStore'
import { PageHeader, Card, Badge } from '../components/ui'
import { useT } from '../i18n'
import CronLive from './CronLive'

function TemplateModal({ reminder, onClose }) {
  const pushToast = useStore((s) => s.pushToast)
  const [tab, setTab] = useState('whatsapp')
  const [wa, setWa] = useState(reminder.whatsapp)
  const [subject, setSubject] = useState(reminder.emailSubject)
  const [body, setBody] = useState(reminder.emailBody)
  const [sent, setSent] = useState(false)

  const send = () => {
    setSent(true)
    pushToast({ title: 'Reminder sent to Sales', body: `${reminder.event} draft → ${reminder.client} · ${reminder.channel}`, kind: 'cron' })
    setTimeout(onClose, 900)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative z-10 w-full max-w-lg card p-0 animate-pop max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/10">
          <div>
            <div className="eyebrow">Message Template · auto-merged</div>
            <div className="text-sm text-white mt-0.5">{reminder.client} — {reminder.event}</div>
          </div>
          <button onClick={onClose} className="text-white/50 hover:text-white"><X size={18} /></button>
        </div>

        {/* channel tabs */}
        <div className="flex gap-2 px-5 pt-4">
          <button onClick={() => setTab('whatsapp')} className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${tab === 'whatsapp' ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30' : 'border border-white/15 text-white/60'}`}>
            <MessageCircle size={14} /> WhatsApp
          </button>
          <button onClick={() => setTab('email')} className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm ${tab === 'email' ? 'bg-sky-500/15 text-sky-300 border border-sky-500/30' : 'border border-white/15 text-white/60'}`}>
            <Mail size={14} /> Email
          </button>
        </div>

        <div className="p-5">
          {tab === 'whatsapp' ? (
            <>
              <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">Message to {reminder.contact}</div>
              <textarea value={wa} onChange={(e) => setWa(e.target.value)} rows={7}
                className="w-full rounded-lg border border-white/10 bg-navy-900 p-3 text-sm text-white/85 focus:border-gold/50 outline-none resize-none" />
            </>
          ) : (
            <>
              <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">Subject</div>
              <input value={subject} onChange={(e) => setSubject(e.target.value)}
                className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none mb-3" />
              <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">Body</div>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={8}
                className="w-full rounded-lg border border-white/10 bg-navy-900 p-3 text-sm text-white/85 focus:border-gold/50 outline-none resize-none whitespace-pre-wrap" />
            </>
          )}
          <div className="mt-2 text-[11px] text-white/35">Merge fields (name, event, date) pre-filled by the system. Edit freely before sending.</div>

          <div className="mt-4 flex justify-end gap-2">
            <button onClick={onClose} className="btn-ghost">Cancel</button>
            <button onClick={send} disabled={sent} className="btn-gold">
              <Send size={14} /> {sent ? 'Sent ✓' : `Send via ${reminder.channel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CronDemo() {
  const cronJobs = useStore((s) => s.cronJobs)
  const reminders = useStore((s) => s.reminders)
  const cronRan = useStore((s) => s.cronRan)
  const runCron = useStore((s) => s.runCron)
  const t = useT()
  const [preview, setPreview] = useState(null)

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Background Automation"
        title="Automated Cron Jobs"
        subtitle="Scheduled daily processes run without anyone lifting a finger. The birthday & milestone scan notifies Sales 7 days before each client date — with WhatsApp/Email drafts ready to send."
        actions={
          <button onClick={runCron} disabled={cronRan} className="btn-gold">
            <Play size={15} /> {cronRan ? t('Daily jobs ran') : t('Run daily jobs now')}
          </button>
        }
      />

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Schedule */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Clock size={16} className="text-gold/70" />
            <div className="eyebrow">Scheduled Jobs</div>
          </div>
          <div className="space-y-2">
            {cronJobs.map((j) => (
              <div key={j.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-4 py-3">
                <div className="flex-1 min-w-[160px]">
                  <div className="text-sm text-white">{j.name}</div>
                  <div className="text-[11px] text-white/40">{j.schedule} · last run {j.lastRun}</div>
                </div>
                <Badge>{j.status}</Badge>
              </div>
            ))}
          </div>
          <div className="mt-4 text-[11px] text-white/40 border-t border-white/10 pt-3">
            In production these run on a server scheduler (cron) and fire WhatsApp/Email via API — no manual trigger needed.
          </div>
        </Card>

        {/* Reminder output */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <Gift size={16} className="text-gold/70" />
            <div className="eyebrow">Reminders Generated · Next 7 Days</div>
          </div>

          {!cronRan ? (
            <div className="rounded-lg border border-dashed border-white/10 py-12 text-center">
              <Clock size={28} className="mx-auto text-white/20" />
              <div className="mt-2 text-sm text-white/40">Run the daily jobs to see what the 7-day scan surfaces.</div>
            </div>
          ) : (
            <div className="space-y-3">
              {reminders.map((r, i) => (
                <div key={i} className="rounded-lg border border-gold/25 bg-gold/[0.05] p-4 animate-pop">
                  <div className="flex items-start gap-3">
                    <span className="grid h-9 w-9 place-items-center rounded-lg bg-gold/15 text-gold-light shrink-0"><Gift size={17} /></span>
                    <div className="flex-1">
                      <div className="text-sm text-white">
                        <span className="text-gold-light">{r.client}</span> — {r.contact}
                      </div>
                      <div className="text-xs text-white/50 mt-0.5">
                        {t(r.event)} · {r.date} · <span className="text-gold/80">{t('in')} {r.inDays} {t('days')}</span> · {r.channel}
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <button onClick={() => setPreview(r)} className="btn-gold text-xs py-1.5"><MessageCircle size={13} /> {t('Preview draft')}</button>
                        <button className="btn-ghost text-xs py-1.5">{t('Assign to Sales')}</button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11px] text-emerald-300 pt-1">
                <CheckCircle2 size={13} /> {reminders.length} reminders queued for the Sales team.
              </div>
            </div>
          )}
        </Card>
      </div>

      {preview && <TemplateModal reminder={preview} onClose={() => setPreview(null)} />}
    </div>
  )
}

// Signed in, the screen reads the server's scheduler (jobs, runs, reminders); the demo keeps its
// simulated run so a signed-out visit still shows what the screen is for.
export default function Cron() {
  const live = useStore((s) => s.hydrated)
  return live ? <CronLive /> : <CronDemo />
}
