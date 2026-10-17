// Reminders the Oscenia team configures (decision 8): any number of D-n rules before the event
// and D+n follow-ups after it (R4, e.g. a D+1 thank-you with a feedback link), each with an
// audience, a channel and an editable message. Sending is simulated in the prototype; the
// backend will send through Oscenia's WhatsApp Business account and email (decision 9).
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Send, MessageCircle, Mail, HeartHandshake } from 'lucide-react'
import { Card, Badge, DEMO_TODAY } from '../ui'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { reminderAudience, reminderDate, fillTemplate, personalLink, ruleLabel, AUDIENCES, safeLink } from '../../lib/events'
import { shortDate, stamp } from '../workspace/parts'
import { useT } from '../../i18n'

const CHANNELS = { whatsapp: 'WhatsApp', email: 'Email', both: 'WhatsApp + email' }

// Days relative to the event: D-3 is -3, D+1 is +1.
const offset = (rule) => (rule.when === 'after' ? rule.daysBefore : -rule.daysBefore)

export default function RemindersTab({ event }) {
  const t = useT()
  // Select the stored array and filter outside the selector: a selector that builds a new
  // array on every call makes zustand re-render forever.
  const all = useProto((s) => s.guests)
  const live = useProto((s) => s.live)
  const guests = useMemo(() => all.filter((g) => g.eventId === event.id), [all, event.id])
  const pushToast = useStore((s) => s.pushToast)
  const { addReminder, updateReminder, removeReminder, sendReminderNow } = useProto.getState()
  const sample = guests.find((g) => g.rsvp === 'Attending') || guests[0]
  // {link} goes into a WhatsApp message or an email, so it must be a full URL; the origin
  // only exists in the browser.
  const path = `${import.meta.env.BASE_URL}invite/${event.id}`
  const [link, setLink] = useState(path)
  useEffect(() => { setLink(`${window.location.origin}${path}`) }, [path])

  return (
    <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
      <div className="space-y-3">
        {event.reminders.length === 0 && <Card className="text-sm text-white/45">{t('No reminders yet. Add one below.')}</Card>}
        {/* In the order they fire: D-10 … D-1, then D+1 … */}
        {[...event.reminders].sort((a, b) => offset(a) - offset(b)).map((rule) => {
          const after = rule.when === 'after'
          const on = reminderDate(event, rule.daysBefore, rule.when)
          const reach = reminderAudience(rule, guests).length
          const when = on < DEMO_TODAY ? 'Past' : on === DEMO_TODAY ? 'Due today' : 'Scheduled'
          // A follow-up is about the event that happened; before the day there is nothing to send.
          const tooEarly = after && DEMO_TODAY < event.date
          const set = (patch) => updateReminder(event.id, rule.id, patch)
          return (
            <Card key={rule.id} className={`${rule.active ? '' : 'opacity-60'} ${after ? 'border-sky-500/20' : ''}`}>
              <div className="flex flex-wrap items-center gap-3">
                <select value={after ? 'after' : 'before'} onChange={(e) => set({ when: e.target.value })} aria-label={t('Before or after the event')}
                  className="rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-sm text-white/80">
                  <option value="before">{t('Before the event')}</option>
                  <option value="after">{t('After the event')}</option>
                </select>
                <label className="flex items-center gap-2 text-sm text-white">
                  {after ? 'D+' : 'D-'}
                  <input type="number" min={after ? 1 : 0} max={60} value={rule.daysBefore}
                    onChange={(e) => set({ daysBefore: Math.min(60, Math.max(after ? 1 : 0, Number(e.target.value) || 0)) })}
                    className="w-14 rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-sm" aria-label={t(after ? 'Days after the event' : 'Days before the event')} />
                </label>
                <span className="text-xs text-white/45">{shortDate(on)} · <Badge>{when}</Badge></span>
                <select value={rule.audience} onChange={(e) => set({ audience: e.target.value })} className="rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-sm text-white/80" aria-label={t('Audience')}>
                  {Object.entries(AUDIENCES[after ? 'after' : 'before']).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
                </select>
                <select value={rule.channel} onChange={(e) => set({ channel: e.target.value })} className="rounded-md border border-white/10 bg-navy-950 px-2 py-1 text-sm text-white/80" aria-label={t('Channel')}>
                  {Object.entries(CHANNELS).map(([k, v]) => <option key={k} value={k}>{t(v)}</option>)}
                </select>
                <label className="ml-auto flex items-center gap-2 text-xs text-white/60">
                  <input type="checkbox" className="accent-[#c6a15b]" checked={rule.active} onChange={() => set({ active: !rule.active })} />{t('Active')}
                </label>
                <button onClick={() => removeReminder(event.id, rule.id)} className="text-white/35 hover:text-rose-300" aria-label={t('Remove')}><Trash2 size={15} /></button>
              </div>
              <textarea value={rule.template} onChange={(e) => set({ template: e.target.value })} rows={2}
                className="mt-3 w-full rounded-lg border border-white/10 bg-navy-950 p-2.5 text-sm text-white/80 outline-none focus:border-gold/50" />
              <div className="mt-2 flex flex-wrap items-center gap-3">
                <span className="text-[11px] text-white/35">{t('Placeholders')}: {'{name} {event} {date} {venue} {link} {feedback}'}</span>
                <span className="ml-auto text-xs text-white/50">{tooEarly ? t('Sends after the event') : `${reach} ${t('recipients now')}`}</span>
                <button
                  className="btn-ghost !py-1.5 text-xs"
                  disabled={!rule.active || reach === 0 || tooEarly}
                  onClick={() => {
                    const n = sendReminderNow(event.id, rule.id)
                    pushToast({ title: `${t('Sent (simulated)')} · ${n}`, body: `${ruleLabel(rule)} ${t('via')} ${t(CHANNELS[rule.channel])}`, kind: 'cron' })
                  }}
                >
                  <Send size={13} />{t('Send now')}
                </button>
              </div>
              {rule.template.includes('{feedback}') && !safeLink(event.feedbackUrl || '') && (
                <p className="mt-2 text-[11px] text-amber-300">{t('No feedback link yet — add one under Invitation → Event details, or {feedback} stays empty.')}</p>
              )}
              {sample && (
                <div className="mt-3 rounded-lg bg-emerald-500/5 border border-emerald-500/15 p-3 text-xs text-white/70">
                  <div className="mb-1 flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-300/70">
                    {rule.channel === 'email' ? <Mail size={11} /> : <MessageCircle size={11} />} {t('Preview')}
                  </div>
                  {fillTemplate(rule.template, { guest: sample, event, link: personalLink(link, sample) })}
                </div>
              )}
            </Card>
          )
        })}
        <div className="flex flex-wrap gap-2">
          <button className="btn-ghost" onClick={() => addReminder(event.id)}><Plus size={15} />{t('Add reminder')}</button>
          <button className="btn-ghost" onClick={() => addReminder(event.id, 'after')}><HeartHandshake size={15} />{t('Add follow-up (after the event)')}</button>
        </div>
        <p className="text-[11px] text-white/35">
          {live
            ? t('Not connected yet: reminders are not saved or sent. This needs the messaging provider and the scheduler, which come in a later backend phase.')
            : t('Prototype: nothing is actually sent. With the backend, active rules send automatically on their day through Oscenia’s WhatsApp Business account and email.')}
        </p>
      </div>

      <Card>
        <div className="eyebrow mb-3">{t('Send log')}</div>
        <div className="space-y-2">
          {[...event.sendLog].reverse().map((l) => (
            <div key={l.id} className="rounded-lg border border-white/5 p-2.5 text-sm">
              <div className="flex justify-between gap-2"><span className="text-white/85">{l.label}</span><span className="tabular-nums text-white/60">{l.count}</span></div>
              <div className="text-[11px] text-white/40">{stamp(l.at)} · {t(CHANNELS[l.channel] || l.channel)} · {t(l.audience)}</div>
            </div>
          ))}
          {event.sendLog.length === 0 && <div className="text-sm text-white/35">{t('Nothing sent yet.')}</div>}
        </div>
      </Card>
    </div>
  )
}
