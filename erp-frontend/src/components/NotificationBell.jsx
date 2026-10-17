// The bell in the top bar: what needs this person's attention, newest first. Clicking an
// item opens the task, chat, event or client it is about and marks it read.
import { useCallback, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Bell, CheckCircle2, UserPlus, AtSign, Ban, Undo2, BadgeCheck, CalendarClock, Cake, Award, Ticket, DoorOpen, KeyRound } from 'lucide-react'
import { useProto, selectPersona } from '../store/chatProto'
import { useStore } from '../store/useStore'
import { notificationsFor, isUnread, sortNotifications } from '../lib/notifications'
import { useNotifications } from '../store/useNotifications'
import { useAuth } from '../store/useAuth'
import { WORKSPACE_ROLES } from '../lib/workspaceAccess'
import { appToday } from '../lib/format'
import { stamp } from './workspace/parts'
import { useT } from '../i18n'
import { useDismiss } from './useDismiss'

const ICON = {
  'Needs your approval': [CheckCircle2, 'text-amber-300 bg-amber-500/15'],
  'Assigned to you': [UserPlus, 'text-sky-300 bg-sky-500/15'],
  'Mentioned you': [AtSign, 'text-gold-light bg-gold/15'],
  Blocked: [Ban, 'text-rose-300 bg-rose-500/15'],
  'Sent back': [Undo2, 'text-rose-300 bg-rose-500/15'],
  Approved: [BadgeCheck, 'text-emerald-300 bg-emerald-500/15'],
  'New RSVP': [Ticket, 'text-emerald-300 bg-emerald-500/15'],
  'RSVP declined': [Ticket, 'text-white/60 bg-white/10'],
  'Time to reach out': [CalendarClock, 'text-gold-light bg-gold/15'],
  'Event nudge': [CalendarClock, 'text-gold-light bg-gold/15'],
  Birthday: [Cake, 'text-rose-200 bg-rose-500/15'],
  'Company anniversary': [Award, 'text-sky-200 bg-sky-500/15'],
  'Wants to join': [DoorOpen, 'text-amber-300 bg-amber-500/15'],
  'Added to channel': [KeyRound, 'text-emerald-300 bg-emerald-500/15'],
  'Request declined': [KeyRound, 'text-white/60 bg-white/10'],
}

export default function NotificationBell() {
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const box = useRef(null)
  const close = useCallback(() => setOpen(false), [])
  useDismiss(box, open, close)
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const tasks = useProto((s) => s.tasks)
  const messages = useProto((s) => s.messages)
  const channels = useProto((s) => s.channels)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const events = useProto((s) => s.events)
  const guests = useProto((s) => s.guests)
  const relations = useProto((s) => s.relations)
  const read = useProto((s) => s.notifRead[s.personaId])
  const clients = useStore((s) => s.clients)
  const role = useStore((s) => s.role)
  // Live: the server works out the items — chat's (mentions, join requests and their answers, and
  // your tasks: needs your approval, assigned, sent back, approved, blocked) and the events and CRM
  // ones (invitations to review, RSVPs, client birthdays). The demo's items belong to the demo
  // persona, not to you, so they are not mixed in.
  const live = useProto((s) => s.live)
  const liveItems = useProto((s) => s.chatNotifications)
  const bizItems = useNotifications((s) => s.items)
  const bizRead = useNotifications((s) => s.read)
  const me = useAuth((s) => s.user)

  const demoItems = useMemo(
    () => notificationsFor({ persona, members, tasks, messages, channels, projectDivisions, events, guests, clients, relations, role, today: appToday() }),
    [persona, members, tasks, messages, channels, projectDivisions, events, guests, clients, relations, role]
  )
  const bizIds = useMemo(() => new Set(bizItems.map((i) => i.id)), [bizItems])
  const liveAll = useMemo(() => sortNotifications([...(liveItems || []), ...bizItems]), [liveItems, bizItems])
  const items = live ? liveAll : demoItems
  // A mention is read once you have read its channel (the server knows); the rest are read
  // when you have opened them, which this browser remembers — chat's and the others' separately.
  const isFresh = (i) => {
    if (live && bizIds.has(i.id)) return isUnread(i, bizRead)
    return live && i.read != null ? !i.read : isUnread(i, read)
  }
  const unread = items.filter(isFresh).length

  const go = (item) => {
    if (live && bizIds.has(item.id)) useNotifications.getState().markRead(item.id)
    else useProto.getState().markNotificationRead(item.id)
    setOpen(false)
    navigate(item.to)
  }

  return (
    <div className="relative" ref={box}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="relative grid h-9 w-9 place-items-center rounded-lg border border-white/15 bg-white/5 text-white/70 hover:border-gold/50 hover:text-white"
        aria-label={`${t('Notifications')}${unread ? ` (${unread} ${t('unread')})` : ''}`}
      >
        <Bell size={17} />
        {unread > 0 && (
          <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-semibold leading-[18px] text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          <div className="fixed right-2 left-2 top-16 z-20 sm:absolute sm:left-auto sm:right-0 sm:top-auto sm:mt-2 sm:w-96 rounded-xl border border-white/10 bg-navy-800 shadow-2xl animate-fade-up">
            <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
              <div className="min-w-0">
                <div className="text-sm font-medium text-white">{t('Notifications')}</div>
                <div className="truncate text-[11px] text-white/40">
                  {persona ? `${t('For')} ${persona.name} · ${t(WORKSPACE_ROLES[persona.workspaceRole])}` : `${t('For')} ${me?.fullName || me?.name || ''}`}
                </div>
              </div>
              {unread > 0 && (
                <button onClick={() => { useProto.getState().markAllNotificationsRead(); if (live) useNotifications.getState().markAllRead() }} className="ml-auto shrink-0 text-xs text-gold/80 hover:text-gold-light">
                  {t('Mark all read')}
                </button>
              )}
            </div>
            <div className="max-h-[70vh] overflow-y-auto p-1.5">
              {items.map((item) => {
                const [Icon, tone] = ICON[item.kind] || [Bell, 'text-white/60 bg-white/10']
                const fresh = isFresh(item)
                return (
                  <button key={item.id} onClick={() => go(item)}
                    className={`flex w-full items-start gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-white/5 ${fresh ? 'bg-white/[0.03]' : ''}`}>
                    <span className={`mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg ${tone}`}><Icon size={15} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className={`text-[10px] uppercase tracking-wider ${fresh ? 'text-gold-light' : 'text-white/40'}`}>{t(item.kind)}</span>
                        <span className="ml-auto shrink-0 text-[10px] text-white/30">{stamp(item.at)}</span>
                      </span>
                      <span className={`block truncate text-sm ${fresh ? 'text-white' : 'text-white/70'}`}>{item.title}</span>
                      <span className="block truncate text-xs text-white/45">{item.body}</span>
                    </span>
                    {fresh && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-gold" />}
                  </button>
                )
              })}
              {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-white/40">{t('Nothing needs your attention.')}</div>}
            </div>
            <div className="border-t border-white/10 px-4 py-2 text-[10px] text-white/35">
              {live ? t('Your chat, event and client notifications.') : t('Switch “Viewing as” in Workspace or Chat to see another person’s notifications.')}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
