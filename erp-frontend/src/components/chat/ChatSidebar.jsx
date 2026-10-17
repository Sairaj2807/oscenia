// The left side of the chat, laid out like Discord (CH3) in Oscenia navy and gold: the server
// rail, the channel list of the server in view (text and voice categories, direct messages)
// and the user panel at the bottom. On a phone the same pieces open as a slide-in drawer.
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import {
  Hash, Lock, Phone, Plus, Building2, ChevronDown, ChevronRight, Volume2, Mic, MicOff, Headphones, HeadphoneOff,
  Settings, CheckCheck, Link2, SquareKanban, PhoneOff, Maximize2, CirclePlus, SlidersHorizontal,
} from 'lucide-react'
import { Avatar } from '../workspace/parts'
import { useDismiss } from '../useDismiss'
import { useProto, selectPersona } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { USER_STATUSES, STATUS_LABEL, presenceOf, mentions } from '../../lib/chat'
import { channelAccess } from '../../lib/workspaceAccess'
import { useT } from '../../i18n'

const STATUS_DOT = { online: 'bg-emerald-400', idle: 'bg-amber-400', dnd: 'bg-rose-500', invisible: 'bg-slate-500', offline: 'bg-slate-500' }

/** An avatar with a presence dot in the corner. */
export function PresenceAvatar({ member, status, size = 'md' }) {
  const t = useT()
  if (!member) return null
  return (
    <span className="relative inline-flex shrink-0">
      <Avatar member={member} size={size} />
      <span role="img" className={`absolute -bottom-0.5 -right-0.5 rounded-full ring-2 ring-navy-900 ${size === 'sm' ? 'h-2.5 w-2.5' : 'h-3 w-3'} ${STATUS_DOT[status] || STATUS_DOT.offline}`}
        title={t(STATUS_LABEL[status] || 'Offline')} aria-label={t(STATUS_LABEL[status] || 'Offline')} />
    </span>
  )
}

// Which categories are folded is a per-browser preference, not shared demo data.
const COLLAPSE_KEY = 'oscenia.chat.collapsed'
function readCollapsed() {
  try { return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {} } catch { return {} }
}
function useCollapsed() {
  const [folded, setFolded] = useState(readCollapsed)
  const toggle = (key) => setFolded((f) => {
    const next = { ...f, [key]: !f[key] }
    if (!next[key]) delete next[key]
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next)) } catch { /* private mode: keep it for this visit */ }
    return next
  })
  return [folded, toggle]
}

/** The column of servers: the company first, a divider, then each project. */
export function ServerRail({ servers, activeKey, unreadOf, pingsOf, onPick }) {
  const t = useT()
  const [tip, setTip] = useState(null)
  const show = (e, label) => {
    const r = e.currentTarget.getBoundingClientRect()
    setTip({ label, left: r.right + 10, top: r.top + r.height / 2 })
  }
  return (
    <nav className="flex w-[72px] shrink-0 flex-col items-center gap-2 overflow-y-auto bg-navy-950 py-3" aria-label={t('Servers')}>
      {servers.map((s, i) => {
        const on = s.key === activeKey
        const unread = unreadOf(s) > 0
        const pings = pingsOf(s)
        return (
          <div key={s.key} className="contents">
            <div className="group relative flex w-full justify-center">
              {/* The white pill: tall for the server in view, a dot for one with unread messages. */}
              <span aria-hidden className={`absolute left-0 top-1/2 w-1 -translate-y-1/2 rounded-r-full bg-white transition-all ${
                on ? 'h-10' : unread ? 'h-2 group-hover:h-5' : 'h-0 group-hover:h-5'}`} />
              <button
                onClick={() => onPick(s)}
                onMouseEnter={(e) => show(e, s.label)} onMouseLeave={() => setTip(null)}
                onFocus={(e) => show(e, s.label)} onBlur={() => setTip(null)}
                aria-label={s.label} aria-current={on ? 'true' : undefined}
                className={`relative flex h-12 w-12 items-center justify-center text-xs font-semibold transition-all ${
                  on ? 'rounded-xl bg-gold text-navy-950' : 'rounded-3xl bg-navy-800 text-white/70 hover:rounded-xl hover:bg-gold/80 hover:text-navy-950'}`}
              >
                {s.key === 'company' ? <Building2 size={20} /> : s.short}
                {pings > 0 && (
                  <span className="absolute -bottom-1 -right-1 min-w-[18px] rounded-full bg-rose-500 px-1 text-center text-[10px] font-bold leading-[18px] text-white ring-4 ring-navy-950">{pings}</span>
                )}
              </button>
            </div>
            {i === 0 && servers.length > 1 && <div className="h-0.5 w-8 shrink-0 rounded bg-white/10" aria-hidden />}
          </div>
        )
      })}
      {tip && (
        <div role="tooltip" className="pointer-events-none fixed z-[60] -translate-y-1/2 whitespace-nowrap rounded-md bg-black px-3 py-1.5 text-sm font-medium text-white shadow-xl"
          style={{ left: tip.left, top: tip.top }}>
          {tip.label}
        </div>
      )}
    </nav>
  )
}

/** The server's name, with a menu of what this persona can do there. */
function ServerHeader({ server, channelId, onMarkRead, onCreate, onSettings }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useDismiss(ref, open, () => setOpen(false))
  const invite = async () => {
    setOpen(false)
    const url = `${window.location.origin}${import.meta.env.BASE_URL.replace(/\/$/, '')}/chat/${channelId}`
    try { await navigator.clipboard.writeText(url) } catch { /* no clipboard: the toast still explains */ }
    useStore.getState().pushToast({ title: t('Invite link copied'), body: t('Only people who have access to the channel can open it.') })
  }
  return (
    <div ref={ref} className="relative">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="menu"
        className="flex h-12 w-full items-center gap-2 border-b border-black/30 px-4 text-left shadow-sm hover:bg-white/[0.04]">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-white">{server.label}</span>
        <ChevronDown size={16} className={`shrink-0 text-white/60 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div role="menu" className="absolute left-2 right-2 top-[52px] z-30 rounded-lg border border-white/10 bg-navy-950 p-1.5 shadow-2xl">
          {server.key !== 'company' && !live && (
            <Link role="menuitem" to={`/workspace/${server.key}`} onClick={() => setOpen(false)}
              className="flex items-center justify-between rounded px-2 py-1.5 text-sm text-white/80 hover:bg-gold hover:text-navy-950">
              {t('Task board')} <SquareKanban size={15} />
            </Link>
          )}
          {onCreate && (
            <button role="menuitem" onClick={() => { setOpen(false); onCreate() }}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-white/80 hover:bg-gold hover:text-navy-950">
              {t('Create channel')} <CirclePlus size={15} />
            </button>
          )}
          {onSettings && (
            <button role="menuitem" onClick={() => { setOpen(false); onSettings() }}
              className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-white/80 hover:bg-gold hover:text-navy-950">
              {t('Channel settings')} <SlidersHorizontal size={15} />
            </button>
          )}
          <button role="menuitem" onClick={invite} className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-gold-light hover:bg-gold hover:text-navy-950">
            {t('Invite people')} <Link2 size={15} />
          </button>
          <div className="my-1 h-px bg-white/10" />
          <button role="menuitem" onClick={() => { onMarkRead(); setOpen(false) }}
            className="flex w-full items-center justify-between rounded px-2 py-1.5 text-sm text-white/80 hover:bg-gold hover:text-navy-950">
            {t('Mark as read')} <CheckCheck size={15} />
          </button>
        </div>
      )}
    </div>
  )
}

function Category({ label, folded, onToggle, action }) {
  const t = useT()
  return (
    <div className="flex items-center justify-between px-0.5 pb-1 pt-4">
      <button onClick={onToggle} aria-expanded={!folded}
        className="flex items-center gap-0.5 text-[11px] font-semibold uppercase tracking-wide text-white/45 hover:text-white/80">
        {folded ? <ChevronRight size={12} /> : <ChevronDown size={12} />}{t(label)}
      </button>
      {action}
    </div>
  )
}

/**
 * The channels of one server. `unread(c)` gives the unread messages of a channel; a folded
 * category still shows the channel you are on, unread ones and a voice channel with a call.
 */
export function ChannelList({ server, current, members, unread, onGo, onVoice, onNewDm, label, locked, canManage, onCreate, onSettings, onLockedVoice }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const activeCall = useProto((s) => s.activeCall)
  const presence = useProto((s) => s.presence)
  const [folded, toggle] = useCollapsed()
  const text = server.channels.filter((c) => c.kind !== 'voice')
  const voice = server.channels.filter((c) => c.kind === 'voice')
  const key = (cat) => `${server.key}:${cat}`
  const keep = (c) => c.id === current?.id || unread(c).length > 0 || activeCall?.channelId === c.id
  const shown = (list, cat) => (folded[key(cat)] ? list.filter(keep) : list)
  const markAll = () => server.channels.concat(server.dms || []).filter((c) => !locked.has(c.id)).forEach((c) => useProto.getState().markRead(c.id))
  // A cog on the row, on hover, for whoever may manage the channel (CH5).
  const cog = (c) => canManage(c) && (
    <button onClick={() => onSettings(c)}
      className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-1 text-white/50 opacity-0 hover:bg-white/10 hover:text-white focus:opacity-100 group-hover/row:opacity-100"
      title={t('Channel settings')} aria-label={`${t('Channel settings')}: ${c.name}`}>
      <Settings size={13} />
    </button>
  )
  const rowTone = (on, u) => (on ? 'bg-white/10 text-white' : u ? 'text-white hover:bg-white/5' : 'text-white/50 hover:bg-white/5 hover:text-white/80')

  return (
    <>
      {/* Invite to a channel, never to a direct message. */}
      <ServerHeader server={server} channelId={(current && !current.dm ? current.id : text[0]?.id) || ''} onMarkRead={markAll}
        onCreate={onCreate} onSettings={current && !current.dm && canManage(current) ? () => onSettings(current) : null} />
      <div className="flex-1 overflow-y-auto px-2 pb-3">
        <Category label="Text channels" folded={folded[key('text')]} onToggle={() => toggle(key('text'))} />
        <div className="space-y-0.5">
          {shown(text, 'text').map((c) => {
            const shut = locked.has(c.id)
            const u = unread(c)
            const pings = u.filter((m) => mentions(m.text, persona.id)).length
            const on = c.id === current?.id
            return (
              <div key={c.id} className="group/row relative">
              <button onClick={() => onGo(c.id)} aria-current={on ? 'page' : undefined}
                title={shut ? t('You can’t open this channel yet. Ask to join.') : undefined}
                className={`relative flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm ${canManage(c) ? 'pr-7' : ''} ${shut && !on ? 'text-white/30 hover:bg-white/5' : rowTone(on, u.length)}`}>
                {u.length > 0 && !on && <span aria-hidden className="absolute -left-2 top-1/2 h-2 w-1 -translate-y-1/2 rounded-r-full bg-white" />}
                {shut || channelAccess(c).access === 'invite' ? <Lock size={16} className="shrink-0 opacity-60" aria-label={t(shut ? 'Locked' : 'Private')} /> : <Hash size={16} className="shrink-0 opacity-60" />}
                <span className={`truncate ${u.length && !on ? 'font-semibold' : ''}`}>{c.name}</span>
                {activeCall?.channelId === c.id && <Phone size={12} className="ml-auto shrink-0 text-emerald-400" aria-label={t('Call in progress')} />}
                {pings > 0 && <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{pings}</span>}
              </button>
              {cog(c)}
              </div>
            )
          })}
        </div>

        {voice.length > 0 && (
          <>
            <Category label="Voice channels" folded={folded[key('voice')]} onToggle={() => toggle(key('voice'))} />
            <div className="space-y-0.5">
              {shown(voice, 'voice').map((c) => {
                const shut = locked.has(c.id)
                const live = activeCall?.channelId === c.id && !shut
                const inIt = live && activeCall.participantIds.includes(persona.id)
                const busy = Boolean(activeCall) && !live
                const meElsewhere = busy && activeCall.participantIds.includes(persona.id)
                const people = live ? activeCall.participantIds.map((id) => members.find((m) => m.id === id)).filter(Boolean) : []
                return (
                  <div key={c.id}>
                    <div className="group/row relative">
                    <button onClick={() => (shut ? onLockedVoice(c) : onVoice(c))} disabled={busy && !shut}
                      title={shut ? t('You can’t join this voice channel yet. Ask to join.') : busy ? t(meElsewhere ? 'Leave the call you are in first' : 'Another call is in progress') : inIt ? t('Open the call') : live ? t('Join the call') : t('Join voice')}
                      className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left text-sm disabled:cursor-not-allowed disabled:opacity-40 ${canManage(c) ? 'pr-7' : ''} ${shut ? 'text-white/30 hover:bg-white/5' : rowTone(inIt, live)}`}>
                      {shut ? <Lock size={16} className="shrink-0 opacity-60" aria-label={t('Locked')} /> : <Volume2 size={16} className={`shrink-0 ${live ? 'text-emerald-400' : 'opacity-60'}`} />}
                      <span className="truncate">{t(c.name)}</span>
                      {live && <span className="ml-auto text-[10px] text-emerald-300">{people.length}</span>}
                    </button>
                    {cog(c)}
                    </div>
                    {people.length > 0 && (
                      <ul className="mb-1 ml-6 space-y-0.5" aria-label={`${t('In')} ${t(c.name)}`}>
                        {people.map((m) => (
                          <li key={m.id} className="flex items-center gap-2 rounded px-1.5 py-0.5 text-xs text-white/65">
                            <Avatar member={m} size="sm" /><span className="truncate">{m.name}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )
              })}
            </div>
          </>
        )}

        {server.dms && (
          <>
            <Category label="Direct messages" folded={folded[key('dm')]} onToggle={() => toggle(key('dm'))}
              action={<button onClick={onNewDm} className="text-white/45 hover:text-gold-light" aria-label={t('New message')} title={t('New message')}><Plus size={14} /></button>} />
            <div className="space-y-0.5">
              {shown(server.dms, 'dm').map((c) => {
                const u = unread(c)
                const on = c.id === current?.id
                const other = members.find((m) => m.id === c.memberIds.find((id) => id !== persona.id))
                return (
                  <button key={c.id} onClick={() => onGo(c.id)} aria-current={on ? 'page' : undefined}
                    className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${rowTone(on, u.length)}`}>
                    {other && <PresenceAvatar member={other} status={presenceOf(other, presence, persona.id)} size="sm" />}
                    <span className={`truncate ${u.length && !on ? 'font-semibold' : ''}`}>{label(c)}</span>
                    {activeCall?.channelId === c.id && <Phone size={12} className="ml-auto shrink-0 text-emerald-400" />}
                    {u.length > 0 && !on && <span className="ml-auto rounded-full bg-rose-500 px-1.5 text-[10px] font-bold text-white">{u.length}</span>}
                  </button>
                )
              })}
              {server.dms.length === 0 && <div className="px-2 text-[11px] text-white/30">{t('No conversations yet.')}</div>}
            </div>
          </>
        )}
      </div>
    </>
  )
}

/**
 * Bottom-left: who you are, your status, mic and headphones. While you are on a call, a
 * "Voice connected" strip sits above it with a way back to the call and a hang-up button.
 */
export function UserPanel({ muted, deafened, onToggleMute, onToggleDeafen, callTitle, onOpenCall }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const persona = useProto(selectPersona)
  const presence = useProto((s) => s.presence)
  const activeCall = useProto((s) => s.activeCall)
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useDismiss(ref, open, () => setOpen(false))
  const status = presenceOf(persona, presence, persona.id)
  const onCall = activeCall?.participantIds.includes(persona.id)
  const iconBtn = 'grid h-8 w-8 place-items-center rounded-md hover:bg-white/10'

  return (
    <div className="shrink-0 border-t border-black/30 bg-navy-950/80">
      {onCall && (
        <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-emerald-400">{t('Voice connected')}</div>
            <div className="truncate text-[11px] text-white/50">{callTitle}</div>
          </div>
          <button onClick={onOpenCall} className={`${iconBtn} text-white/70`} title={t('Open the call')} aria-label={t('Open the call')}><Maximize2 size={15} /></button>
          <button onClick={() => useProto.getState().leaveCall()} className={`${iconBtn} text-rose-400`} title={t('Disconnect')} aria-label={t('Disconnect')}><PhoneOff size={16} /></button>
        </div>
      )}
      <div ref={ref} className="relative flex items-center gap-1 px-2 py-2">
        <button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-white/10" title={t('Set your status')}>
          <PresenceAvatar member={persona} status={status} />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-white">{persona.name}</span>
            <span className="block truncate text-[11px] text-white/45">{t(STATUS_LABEL[status])}</span>
          </span>
        </button>
        {!live && <button onClick={onToggleMute} aria-pressed={muted} className={`${iconBtn} ${muted ? 'text-rose-400' : 'text-white/70'}`}
          title={t(muted ? 'Unmute' : 'Mute')} aria-label={t(muted ? 'Unmute' : 'Mute')}>
          {muted ? <MicOff size={17} /> : <Mic size={17} />}
        </button>}
        {!live && <button onClick={onToggleDeafen} aria-pressed={deafened} className={`${iconBtn} ${deafened ? 'text-rose-400' : 'text-white/70'}`}
          title={t(deafened ? 'Undeafen' : 'Deafen')} aria-label={t(deafened ? 'Undeafen' : 'Deafen')}>
          {deafened ? <HeadphoneOff size={17} /> : <Headphones size={17} />}
        </button>}
        <button onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className={`${iconBtn} text-white/70`} title={t('User settings')} aria-label={t('User settings')}>
          <Settings size={17} />
        </button>
        {open && (
          <div role="menu" className="absolute bottom-full left-2 right-2 z-30 mb-2 rounded-lg border border-white/10 bg-navy-950 p-1.5 shadow-2xl">
            <div className="px-2 pb-1 pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-white/40">{t('Status')}</div>
            {USER_STATUSES.map((s) => (
              <button key={s} role="menuitemradio" aria-checked={status === s}
                onClick={() => { useProto.getState().setStatus(s); setOpen(false) }}
                className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-white/10 ${status === s ? 'text-gold-light' : 'text-white/80'}`}>
                <span className={`h-2.5 w-2.5 rounded-full ${STATUS_DOT[s]}`} />{t(STATUS_LABEL[s])}
                {s === 'invisible' && <span className="ml-auto text-[10px] text-white/35">{t('shown as offline')}</span>}
              </button>
            ))}
            <p className="mt-1 border-t border-white/10 px-2 pt-1.5 text-[10px] leading-snug text-white/35">
              {live ? t('Others see this while you are connected. Invisible shows you as offline.') : t('Prototype: other people’s status is simulated. Mute and deafen apply to the (simulated) call.')}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
