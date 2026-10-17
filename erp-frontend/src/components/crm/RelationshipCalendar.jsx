// CRM part 2 (BRD §5.2): when to get in touch. Event-cycle nudges ("Company A gathers every
// November — call them in August"), PIC birthdays and company anniversaries, soonest first.
// Overdue nudges lead: they are the conversations already late.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, Cake, Award, PhoneCall, Send, MessageCircle, Mail, Check } from 'lucide-react'
import { FilterPill } from '../ui'
import { useProto } from '../../store/useProto'
import { useStore } from '../../store/useStore'
import { useRelations } from '../../store/useRelations'
import { relationshipCalendar } from '../../lib/crm'
import { appToday } from '../../lib/format'
import { shortDate } from '../workspace/parts'
import { useT } from '../../i18n'

const KIND = {
  'Event nudge': { icon: CalendarClock, tone: 'text-gold-light bg-gold/15' },
  Birthday: { icon: Cake, tone: 'text-rose-200 bg-rose-500/15' },
  'Company anniversary': { icon: Award, tone: 'text-sky-200 bg-sky-500/15' },
}

export function greetingText(item) {
  return item.kind === 'Birthday'
    ? `Happy birthday, ${item.title}! Wishing you a wonderful year ahead — from all of us at Oscenia Events.`
    : `Happy anniversary to everyone at ${item.client}! Thank you for ${item.title.split(' ')[0]} years of celebrating with Oscenia Events.`
}

export default function RelationshipCalendar({ limit, compact = false }) {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const clients = useStore((s) => s.clients)
  const relations = useProto((s) => s.relations)
  const greetingLog = useProto((s) => s.greetingLog)
  const served = useRelations((s) => s.calendar)
  const servedDays = useRelations((s) => s.calendarDays)
  // One greeting per person per occasion per year.
  const alreadySent = (item) => greetingLog.some((l) =>
    l.clientId === item.clientId && l.kind === item.kind && l.to === (item.kind === 'Birthday' ? item.title : item.client) && l.at.slice(0, 4) === item.date.slice(0, 4))
  const pushToast = useStore((s) => s.pushToast)
  const [days, setDays] = useState(90)
  // Signed in, the server works out what is due (and prepares each greeting); offline, the demo does.
  useEffect(() => {
    if (live) useRelations.getState().loadCalendar(days)
  }, [live, days])
  const items = live
    ? served.filter((i) => i.inDays <= days)
    : relationshipCalendar(clients, relations, appToday(), days)
  const shown = limit ? items.slice(0, limit) : items

  const act = (item) => {
    const { handleNudge, sendGreeting } = useProto.getState()
    if (live) {
      if (item.kind === 'Event nudge') {
        useRelations.getState().handleNudge(item.clientUuid, item.key, '', `${item.client} · ${item.title}`)
      } else {
        useRelations.getState().markGreetingSent(item.clientUuid, {
          kind: item.kind,
          to: item.kind === 'Birthday' ? item.title : item.client,
          channel: item.channel || 'whatsapp',
          year: Number(item.date.slice(0, 4)),
        })
      }
      return
    }
    if (item.kind === 'Event nudge') {
      handleNudge(item.clientId, item.key, `Event-cycle nudge: asked about ${item.title}. ${item.detail}.`)
      pushToast({ title: t('Outreach logged'), body: `${item.client} · ${item.title} — ${t('added to the client’s history')}`, kind: 'cron' })
    } else {
      const r = relations[item.clientId]
      const channel = item.kind === 'Birthday' ? item.pic.channel : r.anniversaryChannel
      sendGreeting({ clientId: item.clientId, kind: item.kind, to: item.kind === 'Birthday' ? item.title : item.client, channel })
      pushToast({ title: t('Greeting sent (simulated)'), body: greetingText(item), kind: 'cron' })
    }
  }

  return (
    <div>
      {!compact && (
        <div className="mb-4 flex flex-wrap items-center gap-2">
          {[30, 60, 90].map((d) => <FilterPill key={d} active={days === d} onClick={() => setDays(d)}>{t('Next')} {d} {t('days')}</FilterPill>)}
          <span className="ml-auto text-xs text-white/40">{items.length} {t('items')}</span>
        </div>
      )}
      <div className="space-y-2">
        {shown.map((item) => {
          const k = KIND[item.kind]
          const Icon = k.icon
          const overdue = item.inDays < 0
          const autoOff = live
            ? item.kind !== 'Event nudge' && !item.greet
            : (item.kind === 'Birthday' && !item.pic.greet) || (item.kind === 'Company anniversary' && !relations[item.clientId].greetAnniversary)
          const sentAlready = live ? item.alreadySent : alreadySent(item)
          return (
            <div key={`${item.kind}-${item.clientId}-${item.title}-${item.date}`} className={`flex flex-wrap items-center gap-3 rounded-lg border p-3 ${overdue ? 'border-rose-500/30 bg-rose-500/5' : 'border-white/10 bg-white/[0.02]'}`}>
              <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${k.tone}`}><Icon size={17} /></span>
              <div className="min-w-0 flex-1">
                <div className="text-sm text-white/90">
                  {item.title} <span className="text-white/40">· </span>
                  <Link to={`/crm/${item.clientId}`} className="text-gold/80 hover:text-gold-light">{item.client}</Link>
                </div>
                <div className="text-[11px] text-white/45">{t(item.kind)} · {item.detail}{autoOff ? ` · ${t('automatic greeting off')}` : ''}</div>
              </div>
              <div className="text-right text-xs">
                <div className={overdue ? 'text-rose-300' : 'text-white/70'}>{shortDate(item.date)} {item.date.slice(0, 4)}</div>
                <div className={overdue ? 'text-rose-300/80' : 'text-white/40'}>
                  {overdue ? `${-item.inDays} ${t('days overdue')}` : item.inDays === 0 ? t('today') : `${t('in')} ${item.inDays} ${t('days')}`}
                </div>
              </div>
              {live && item.kind !== 'Event nudge' && !sentAlready && (
                <div className="flex gap-1">
                  {item.whatsappUrl && (
                    <a href={item.whatsappUrl} target="_blank" rel="noopener noreferrer" className="btn-ghost !py-1.5 text-xs" title={item.message}>
                      <MessageCircle size={13} />{t('WhatsApp')}
                    </a>
                  )}
                  {item.emailUrl && (
                    <a href={item.emailUrl} className="btn-ghost !py-1.5 text-xs" title={item.message}>
                      <Mail size={13} />{t('Email')}
                    </a>
                  )}
                </div>
              )}
              <button className={item.kind === 'Event nudge' ? 'btn-gold !py-1.5 text-xs' : 'btn-ghost !py-1.5 text-xs'} disabled={item.kind !== 'Event nudge' && sentAlready} onClick={() => act(item)}>
                {item.kind === 'Event nudge'
                  ? <><PhoneCall size={13} />{t('Log outreach')}</>
                  : sentAlready ? t('Sent') : live ? <><Check size={13} />{t('Mark sent')}</> : <><Send size={13} />{t('Send greeting')}</>}
              </button>
            </div>
          )
        })}
        {shown.length === 0 && <div className="rounded-lg border border-dashed border-white/10 p-6 text-center text-sm text-white/40">{t('Nothing coming up in this window.')}</div>}
      </div>
    </div>
  )
}
