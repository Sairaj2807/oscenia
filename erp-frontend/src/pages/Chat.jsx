// Team chat, Discord-style (BRD §3, CH3): a "server" per project with text and voice channels
// inside, plus company-wide channels and direct messages. Messages from one author close
// together read as one block; the rail, channel list and user panel live in ChatSidebar.
// Who sees which channel follows the workspace access rules; messages can mention people and link tasks, which open the same task drawer as
// the workspace. A reply posts at the bottom of the main chat with a quote of the original above
// it (CH1; threads were removed in client round 3); any channel or DM can hold a (simulated)
// voice or video call with screen sharing (CH2).
import { useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import {
  Hash, Lock, Reply, Pencil, Trash2, ListPlus, SmilePlus, X, Quote, Phone, Video, AtSign, MessageCircle, Menu,
} from 'lucide-react'
import { PersonaSwitcher, Avatar, useOpenTask, stamp, shortDate, initials } from '../components/workspace/parts'
import TaskDrawer from '../components/workspace/TaskDrawer'
import NewTaskModal from '../components/workspace/NewTaskModal'
import Composer from '../components/chat/Composer'
import CallOverlay from '../components/chat/CallOverlay'
import { MessageText, TaskLinkCard } from '../components/chat/MessageParts'
import { ServerRail, ChannelList, UserPanel, PresenceAvatar } from '../components/chat/ChatSidebar'
import ChannelSettings from '../components/chat/ChannelSettings'
import MeetingPanel from '../components/chat/MeetingPanel'
import { canSeeMeeting } from '../lib/meetings'
import Modal from '../components/Modal'
import { useProto, selectPersona, demoNow } from '../store/chatProto'
import { ConnectionBanner, TypingLine, Attachments, SendState, LoadEarlier, ChatGate } from '../components/chat/LiveParts'
import { useStore } from '../store/useStore'
import {
  visibleChannels, discoverableChannels, canManageChannel, canCreateChannel, channelAccess, canAssign, WORKSPACE_ROLES,
} from '../lib/workspaceAccess'
import {
  REACTIONS, canEditMessage, canDeleteMessage, mentions, taskIdsIn, toDisplay, EDIT_WINDOW_MIN, dmName, snippet,
  startsGroup, isVoice, presenceOf, STATUS_LABEL,
} from '../lib/chat'
import { useT } from '../i18n'

function ChatScreen() {
  const t = useT()
  const { channelId } = useParams()
  const navigate = useNavigate()
  const persona = useProto(selectPersona)
  const channels = useProto((s) => s.channels)
  const messages = useProto((s) => s.messages)
  const lastRead = useProto((s) => s.lastRead)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const storeProjects = useStore((s) => s.projects)
  // Live: the projects the server says you are on (their ids are the channels' project ids).
  const chatProjects = useProto((s) => s.chatProjects)
  const live = useProto((s) => s.live)
  const projects = chatProjects || storeProjects
  const { openTask } = useOpenTask()
  const [taskFrom, setTaskFrom] = useState(null)
  const [quoteOf, setQuoteOf] = useState(null)
  const [newDm, setNewDm] = useState(false)
  const [drawer, setDrawer] = useState(false)
  // Mic and headphones (CH3): set in the user panel, used by the call. Deafening also mutes,
  // and undeafening gives back the mic as it was.
  const [voice, setVoice] = useState({ muted: false, deafened: false, mutedBefore: false })
  const toggleMute = () => setVoice((v) => (v.deafened ? { muted: false, deafened: false, mutedBefore: false } : { ...v, muted: !v.muted }))
  const toggleDeafen = () => setVoice((v) => (v.deafened ? { muted: v.mutedBefore, deafened: false, mutedBefore: false } : { muted: true, deafened: true, mutedBefore: v.muted }))
  const [callMinimized, setCallMinimized] = useState(false)
  const activeCall = useProto((s) => s.activeCall)
  const endRef = useRef(null)

  const mine = useMemo(() => visibleChannels(persona, channels, projectDivisions), [persona, channels, projectDivisions])
  // Channels shown locked, with "Request to join" (CH5).
  const lockedList = useMemo(() => discoverableChannels(persona, channels, projectDivisions), [persona, channels, projectDivisions])
  const locked = useMemo(() => new Set(lockedList.map((c) => c.id)), [lockedList])
  const [searchParams, setSearchParams] = useSearchParams()
  const [settingsFor, setSettingsFor] = useState(null) // { channel } or { projectId } to create
  const [askFor, setAskFor] = useState(null) // a locked voice channel to ask into
  const manages = (c) => canManageChannel(persona, c, projectDivisions)
  const requested = channelId ? channels.find((c) => c.id === channelId) : null
  // A voice channel has no messages: a link to one opens its text channel instead.
  const linked = isVoice(requested) ? channels.find((c) => c.id === requested.textChannelId) : requested
  const current = channelId ? linked : mine.find((c) => !isVoice(c))
  const allowed = Boolean(current && mine.includes(current))

  // Live: tell the store which channel is open (so its new messages are not counted as unread)
  // and fetch its newest messages the first time. Both are no-ops in the demo.
  useEffect(() => {
    const { setOpenChannel, loadChannel } = useProto.getState()
    setOpenChannel?.(allowed ? current.id : null)
    if (allowed) loadChannel?.(current.id)
    return () => setOpenChannel?.(null)
  }, [allowed, current?.id])

  const inChannel = useMemo(
    () => messages.filter((m) => m.channelId === current?.id).sort((a, b) => a.at.localeCompare(b.at)),
    [messages, current?.id]
  )
  // Every message sits in the one stream (round 3). A reply saved by an older version as a
  // thread reply (`parentId`) shows there too, as a quote of its parent.
  const quotedIdOf = (m) => m.quoteId || m.parentId || null

  // Opening a channel marks it read; so does a new message arriving while it is open.
  useEffect(() => {
    if (allowed) useProto.getState().markRead(current.id)
  }, [allowed, current?.id, inChannel.length, persona.id])

  // A quote being written belongs to its channel; switching channel or persona drops it.
  useEffect(() => { setQuoteOf(null) }, [current?.id, persona.id])

  // Settings belong to the persona who opened them.
  useEffect(() => { setSettingsFor(null); setAskFor(null) }, [persona.id])

  // `?settings=<channel>` (from a "wants to join" notification) opens that channel's settings.
  // Runs once per link: the param is consumed either way, and the store re-checks on save.
  // `?meeting=MTG-1` opens a meeting record beside the chat (CH4).
  const meetingParam = searchParams.get('meeting')
  const openMeeting = (id) => setSearchParams((p) => { p.set('meeting', id); return p })
  const closeMeeting = () => setSearchParams((p) => { p.delete('meeting'); return p })
  const settingsParam = searchParams.get('settings')
  useEffect(() => {
    if (!settingsParam) return
    const c = channels.find((x) => x.id === settingsParam)
    if (c && canManageChannel(persona, c, projectDivisions)) setSettingsFor({ channel: c })
    setSearchParams((p) => { p.delete('settings'); return p }, { replace: true })
  }, [settingsParam])

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [current?.id, inChannel.length])

  // The phone drawer closes on Escape, like the other pop-ups. Focus moves into it on open and
  // back to the ☰ button on close.
  const drawerRef = useRef(null)
  const menuRef = useRef(null)
  const drawerWasOpen = useRef(false)
  useEffect(() => {
    if (!drawer) {
      if (drawerWasOpen.current) menuRef.current?.focus()
      drawerWasOpen.current = false
      return undefined
    }
    drawerWasOpen.current = true
    drawerRef.current?.querySelector('button')?.focus()
    const onKey = (e) => { if (e.key === 'Escape') setDrawer(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [drawer])

  // A link to a voice channel lands on its text channel; the address follows.
  useEffect(() => {
    if (isVoice(requested) && linked) navigate(`/chat/${linked.id}`, { replace: true })
  }, [requested?.id, linked?.id])

  // A new call opens full screen.
  useEffect(() => { setCallMinimized(false) }, [activeCall?.startedAt])

  const seen = lastRead[persona.id] || {}
  // Live: the server counts what is unread (a channel's messages are not all loaded here) and
  // how many of those mention you; the list is shaped so the badges below read it unchanged.
  const unread = (ch) => {
    if (isVoice(ch) || !mine.includes(ch)) return []
    if (live) return Array.from({ length: ch.unread || 0 }, (_, i) => ({ text: i < (ch.unreadMentions || 0) ? `<@${persona.id}>` : '' }))
    return messages.filter((m) => m.channelId === ch.id && m.authorId !== persona.id && !m.deleted && m.at > (seen[ch.id] || ''))
  }
  const audience = members.filter((m) => current && visibleChannels(m, [current], projectDivisions).length > 0)

  // Servers: the company (with direct messages), then each project the persona has a channel in.
  const dms = mine.filter((c) => c.dm)
  const label = (c) => (c.dm ? dmName(c, persona.id, members) : c.name)
  // Each server lists what the persona can open plus what they can ask into, in seed order.
  const listed = channels.filter((c) => !c.dm && (mine.includes(c) || locked.has(c.id)))
  const servers = [
    { key: 'company', label: 'Oscenia', short: 'OS', channels: listed.filter((c) => !c.projectId), dms },
    ...projects
      .map((p) => ({ key: p.id, label: p.name, short: initials(p.name), channels: listed.filter((c) => c.projectId === p.id) }))
      .filter((s) => s.channels.some((c) => !isVoice(c))),
  ]
  const serverKey = current?.projectId || 'company'
  const server = servers.find((s) => s.key === serverKey) || servers[0]
  const go = (id) => { setDrawer(false); navigate(`/chat/${id}`) }
  const serverChannels = (s) => [...s.channels, ...(s.dms || [])]
  // Discord's red badge: mentions, plus every unread direct message.
  const pingsOf = (s) => serverChannels(s).reduce((n, c) => n + unread(c).filter((m) => c.dm || mentions(m.text, persona.id)).length, 0)
  const unreadOf = (s) => serverChannels(s).reduce((n, c) => n + unread(c).length, 0)

  // Clicking a voice channel joins the call there, or starts one; you stay in the text chat.
  const joinVoice = (vc) => {
    const { activeCall: call, joinCall, startCall } = useProto.getState()
    if (call && call.channelId !== vc.id) return
    const ok = !call ? startCall(vc.id, false) : call.participantIds.includes(persona.id) || joinCall()
    if (!ok) return
    setCallMinimized(false)
    if (mine.some((c) => c.id === vc.textChannelId)) go(vc.textChannelId)
    else setDrawer(false)
  }

  const callChannel = activeCall ? channels.find((c) => c.id === activeCall.channelId) : null
  const callTitle = !callChannel ? ''
    : callChannel.dm ? dmName(callChannel, persona.id, members)
      : isVoice(callChannel) ? `${t(callChannel.name)} · ${servers.find((s) => s.key === (callChannel.projectId || 'company'))?.label || ''}`
        : `#${callChannel.name}`

  const sidebar = server && (
    <>
      {/* Picking a server keeps the phone drawer open, so you can browse its channels. */}
      <ServerRail servers={servers} activeKey={server.key} unreadOf={unreadOf} pingsOf={pingsOf}
        onPick={(s) => { const first = s.channels.find((c) => !isVoice(c) && mine.includes(c)) || s.dms?.[0]; if (first) navigate(`/chat/${first.id}`) }} />
      <div className="flex w-60 min-w-0 flex-col bg-navy-900">
        <ChannelList server={server} current={current} members={members} unread={unread} label={label}
          onGo={go} onVoice={joinVoice} onNewDm={() => { setDrawer(false); setNewDm(true) }}
          locked={locked} canManage={manages}
          onCreate={canCreateChannel(persona, server.key === 'company' ? null : server.key, projectDivisions)
            ? () => { setDrawer(false); setSettingsFor({ projectId: server.key === 'company' ? null : server.key }) } : null}
          onSettings={(c) => { setDrawer(false); setSettingsFor({ channel: c }) }}
          onLockedVoice={(c) => { setDrawer(false); setAskFor(c) }} />
        <UserPanel muted={voice.muted} deafened={voice.deafened} onToggleMute={toggleMute} onToggleDeafen={toggleDeafen}
          callTitle={callTitle} onOpenCall={() => { setDrawer(false); setCallMinimized(false) }} />
      </div>
    </>
  )

  return (
    <div className="-mx-4 sm:-mx-6 lg:-mx-8 -my-6 flex h-[calc(100vh-4rem)] overflow-hidden">
      {/* Rail + channel list: a column on a laptop, a slide-in drawer on a phone. */}
      <div className="hidden md:flex">{sidebar}</div>
      {drawer && (
        <div className="fixed inset-0 z-40 flex md:hidden" role="dialog" aria-modal="true" aria-label={t('Channels')}>
          <div ref={drawerRef} className="flex h-full max-w-[calc(100vw-3rem)] shadow-2xl">{sidebar}</div>
          <button className="flex-1 bg-black/60" onClick={() => setDrawer(false)} aria-label={t('Close')} />
        </div>
      )}

      {/* Messages */}
      <section className="flex min-w-0 flex-1 flex-col bg-navy-800/40">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-black/30 px-4 py-2.5 shadow-sm">
          <button ref={menuRef} className="md:hidden -ml-1 rounded-md p-1.5 text-white/70 hover:bg-white/10" onClick={() => setDrawer(true)}
            aria-label={t('Open channel list')} title={t('Channels')} aria-expanded={drawer}>
            <Menu size={20} />
          </button>
          <div className="min-w-0 flex-1 md:flex-none">
            <div className="flex items-center gap-1.5 text-white">
              {current?.dm ? <AtSign size={18} className="shrink-0 text-white/50" /> : current && (locked.has(current.id) || channelAccess(current).access === 'invite') ? <Lock size={18} className="shrink-0 text-white/50" /> : <Hash size={18} className="shrink-0 text-white/50" />}
              <span className="truncate font-semibold">{current ? label(current) : ''}</span>
              <span className="truncate text-xs text-white/40 md:hidden">· {server?.label}</span>
            </div>
            {current?.dm ? <div className="hidden text-xs text-white/40 md:block">{t('Direct message — only the two of you can see it')}</div>
              : current?.topic && (allowed || locked.has(current.id)) && <div className="hidden truncate text-xs text-white/40 md:block">{current.topic}</div>}
          </div>
          {allowed && !live && (
            <div className="flex items-center gap-1">
              <button className="btn-ghost !p-2" disabled={Boolean(activeCall)} onClick={() => useProto.getState().startCall(current.id, false)}
                title={t(current.dm ? 'Voice call' : 'Start a group voice call')} aria-label={t('Voice call')}><Phone size={16} /></button>
              <button className="btn-ghost !p-2" disabled={Boolean(activeCall)} onClick={() => useProto.getState().startCall(current.id, true)}
                title={t(current.dm ? 'Video call' : 'Start a group video call')} aria-label={t('Video call')}><Video size={16} /></button>
            </div>
          )}
          <div className="w-full min-w-0 md:ml-auto md:w-auto">
            {live
              ? <div className="truncate text-xs text-white/45">{t('Signed in as')} <span className="text-white/75">{persona.name}</span></div>
              : <PersonaSwitcher />}
          </div>
        </header>
        <ConnectionBanner />

        {/* On a phone the user panel is in the drawer, so a minimised call needs its own way back. */}
        {callMinimized && activeCall?.participantIds.includes(persona.id) && (
          <button onClick={() => setCallMinimized(false)}
            className="flex items-center gap-2 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-left text-sm text-emerald-200 md:hidden">
            <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-emerald-400" />
            <span className="min-w-0 flex-1 truncate">{t('Voice connected')} · {callTitle}</span>
            <span className="shrink-0 font-medium">{t('Open the call')}</span>
          </button>
        )}
        {!current ? (
          channelId
            ? <Blocked title="Channel not found" body="This link points to a channel that does not exist." />
            : <Blocked title="No channels" body="This persona is not on any project yet." />
        ) : !allowed && locked.has(current.id) ? (
          <LockedChannel channel={current} manages={manages(current)} onSettings={() => setSettingsFor({ channel: current })} />
        ) : !allowed ? (
          <Blocked
            title={current.dm ? 'You can’t see this conversation' : `You can’t see #${current.name}`}
            body={current.dm
              ? `It is a direct message between two other people. Not even the PM can open it.`
              : channelAccess(current).blockedIds.includes(persona.id)
                ? `${persona.name} has been kept out of this channel by whoever manages it.`
                : channelAccess(current).access === 'invite'
                  ? `It is a private channel for named members, and ${persona.name} is not one of them.`
                  : `It belongs to a project or division ${persona.name} (${WORKSPACE_ROLES[persona.workspaceRole]}) is not on.`}
          />
        ) : (
          <>
            {activeCall?.channelId === current.id && !activeCall.participantIds.includes(persona.id) && (
              <div className="flex flex-wrap items-center gap-3 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-200">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                {t(activeCall.video ? 'Video call in progress' : 'Voice call in progress')} · {activeCall.participantIds.length} {t('in the call')}
                <button className="btn-gold ml-auto !py-1 text-xs" onClick={() => useProto.getState().joinCall()}><Phone size={13} />{t('Join')}</button>
              </div>
            )}
            <div className="flex-1 overflow-y-auto px-2 py-4 sm:px-4">
              <LoadEarlier channelId={current.id} />
              {inChannel.map((m, i) => {
                const prev = inChannel[i - 1]
                const newDay = !prev || prev.at.slice(0, 10) !== m.at.slice(0, 10)
                return (
                  <div key={m.id}>
                    {newDay && <DayDivider date={m.at.slice(0, 10)} />}
                    <Message
                      msg={m}
                      compact={!startsGroup(prev, m)}
                      onOpenTask={openTask}
                      onQuote={() => setQuoteOf(m.id)}
                      onMeeting={openMeeting}
                      quotedId={quotedIdOf(m)}
                      quoted={quotedIdOf(m) ? inChannel.find((q) => q.id === quotedIdOf(m)) : null}
                      onCreateTask={current.projectId && canAssign(persona, current.projectId, members, projectDivisions) ? () => setTaskFrom(m) : null}
                    />
                  </div>
                )
              })}
              {inChannel.length === 0 && <div className="py-10 text-center text-sm text-white/35">{t('No messages yet. Say hello.')}</div>}
              <div ref={endRef} />
            </div>
            <div className="px-5"><TypingLine channelId={current.id} /></div>
            <div className="px-4 pb-4">
              {/* Keyed by channel and persona: a half-typed message must never follow you elsewhere. */}
              <Composer key={`${current.id}:${persona.id}`} channelId={current.id} channelName={current.dm ? `@${label(current)}` : current.name} audience={audience}
                quote={quoteOf ? inChannel.find((m) => m.id === quoteOf) : null} onClearQuote={() => setQuoteOf(null)} />
            </div>
          </>
        )}
      </section>

      {/* A meeting record, or who is in the channel */}
      {allowed && (
        <aside className={`${meetingParam ? 'flex' : 'hidden xl:flex'} w-full sm:w-96 shrink-0 flex-col border-l border-black/30 bg-navy-900 ${meetingParam ? 'fixed inset-y-0 right-0 z-30 xl:static' : ''}`}>
          {meetingParam ? (
            <MeetingPanel key={`${meetingParam}:${persona.id}`} meetingId={meetingParam} onClose={closeMeeting} onOpenTask={openTask} />
          ) : (
            <MemberList audience={audience} onMessage={async (id) => { const dm = await useProto.getState().openDm(id); if (dm) go(dm) }} />
          )}
        </aside>
      )}

      {taskFrom && (
        <NewTaskModal
          projectId={current.projectId}
          initialTitle={toDisplay(taskFrom.text, members).slice(0, 80)}
          initialDescription={`From #${current.name} — ${members.find((m) => m.id === taskFrom.authorId)?.name}: “${toDisplay(taskFrom.text, members)}”`}
          onClose={() => setTaskFrom(null)}
          onCreated={(id) => {
            // Leave a trail in the conversation: a reply, quoting the message, linking the task.
            useProto.getState().postMessage(current.id, `Created task #${id} from this message.`, null, taskFrom.id)
            openTask(id)
          }}
        />
      )}
      {newDm && (
        <NewDmModal members={members.filter((m) => m.id !== persona.id)} onClose={() => setNewDm(false)}
          onPick={async (id) => { const dm = await useProto.getState().openDm(id); setNewDm(false); if (dm) go(dm) }} />
      )}
      {activeCall && activeCall.participantIds.includes(persona.id) && (
        <CallOverlay
          title={callTitle}
          audience={members.filter((m) => visibleChannels(m, channels.filter((c) => c.id === activeCall.channelId), projectDivisions).length > 0)}
          muted={voice.muted} deafened={voice.deafened} onToggleMute={toggleMute} onToggleDeafen={toggleDeafen}
          minimized={callMinimized} onMinimize={() => setCallMinimized(true)}
        />
      )}
      {settingsFor && (
        <ChannelSettings key={settingsFor.channel?.id || 'new'} channel={settingsFor.channel || null}
          projectId={settingsFor.channel ? settingsFor.channel.projectId : settingsFor.projectId}
          onClose={() => setSettingsFor(null)}
          onSaved={(id) => { const c = useProto.getState().channels.find((x) => x.id === id); if (c && !isVoice(c) && !settingsFor.channel) go(id) }} />
      )}
      {askFor && (
        <Modal title="Request to join" subtitle={askFor.name} onClose={() => setAskFor(null)} size="sm">
          <JoinRequest channel={askFor} onDone={() => setAskFor(null)} />
        </Modal>
      )}
      <TaskDrawer />
    </div>
  )
}

/** What the persona sees in a channel they may ask into (CH5): the rule, and their request. */
function LockedChannel({ channel, manages, onSettings }) {
  const t = useT()
  const a = channelAccess(channel)
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="w-full max-w-sm text-center">
        <Lock className="mx-auto text-gold/70" size={28} />
        <div className="mt-3 font-display text-lg text-white">#{channel.name} {t('is locked')}</div>
        <p className="mt-2 text-sm text-white/50">
          {a.access === 'divisions' ? `${t('It is for the')} ${a.divisions.map((d) => t(d)).join(', ')} ${t(a.divisions.length === 1 ? 'division' : 'divisions')}.`
            : t('It is for invited people only.')} {t('Its messages stay hidden until you are let in.')}
        </p>
        <div className="mt-4 text-left"><JoinRequest channel={channel} /></div>
        {manages && <button className="btn-ghost mt-3 text-sm" onClick={onSettings}>{t('Open channel settings')}</button>}
      </div>
    </div>
  )
}

/** Ask to join, or see where the request stands. */
function JoinRequest({ channel, onDone }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const live = useProto((s) => s.channels.find((c) => c.id === channel.id))
  const [note, setNote] = useState('')
  const mineReq = (live?.requests || []).find((r) => r.memberId === persona.id)
  if (mineReq?.status === 'pending') {
    return (
      <div className="rounded-lg border border-gold/30 bg-gold/[0.06] p-3 text-sm text-gold-light" role="status">
        {t('Request sent')}{mineReq.at ? ` · ${stamp(mineReq.at)}` : ''}
        <div className="mt-1 text-xs text-white/50">{t('The PM or a leader on the project will decide. You’ll get a notification.')}</div>
      </div>
    )
  }
  return (
    <div className="space-y-2">
      {mineReq?.status === 'declined' && (
        <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 text-xs text-white/55">
          {t('Your last request was declined by')} {members.find((m) => m.id === mineReq.decidedBy)?.name}. {t('You can ask again.')}
        </div>
      )}
      <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={200} aria-label={t('Why do you need access? (optional)')}
        placeholder={t('Why do you need access? (optional)')}
        className="w-full rounded-lg border border-white/10 bg-navy-950 p-2 text-sm text-white/85 outline-none focus:border-gold/50" />
      <button className="btn-gold w-full justify-center" onClick={async () => { if (await useProto.getState().requestToJoin(channel.id, note)) onDone?.() }}>
        {t('Request to join')}
      </button>
    </div>
  )
}

/** Pick a teammate to message directly. */
function NewDmModal({ members, onPick, onClose }) {
  const t = useT()
  const [q, setQ] = useState('')
  const shown = members.filter((m) => m.name.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 p-4 pt-24" onClick={onClose}>
      <div className="w-full max-w-sm rounded-xl border border-white/10 bg-navy-800 p-3 shadow-2xl" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t('New message')}>
        <div className="mb-2 flex items-center justify-between">
          <div className="text-sm font-medium text-white">{t('New message')}</div>
          <button onClick={onClose} className="text-white/50 hover:text-white" aria-label={t('Close')}><X size={16} /></button>
        </div>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find a teammate')}
          className="mb-2 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" />
        <div className="max-h-72 space-y-0.5 overflow-y-auto">
          {shown.map((m) => (
            <button key={m.id} onClick={() => onPick(m.id)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-white/80 hover:bg-white/5">
              <Avatar member={m} size="sm" /> {m.name}
              <span className="ml-auto text-[10px] text-white/35">{t(m.division)} {t(WORKSPACE_ROLES[m.workspaceRole])}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function DayDivider({ date }) {
  return (
    <div className="my-4 flex items-center gap-3 text-[11px] text-white/35">
      <div className="h-px flex-1 bg-white/10" />{shortDate(date)}<div className="h-px flex-1 bg-white/10" />
    </div>
  )
}

function Blocked({ title, body }) {
  const t = useT()
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <Lock className="mx-auto text-gold/70" size={28} />
        <div className="mt-3 font-display text-lg text-white">{t(title)}</div>
        <p className="mt-2 text-sm text-white/50">{t(body)}</p>
      </div>
    </div>
  )
}

/** Scrolls to a message and flashes it — used when a quote is clicked. */
function jumpTo(id) {
  const el = document.getElementById(`msg-${id}`)
  if (!el) return
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.add('ring-2', 'ring-gold/60')
  setTimeout(() => el.classList.remove('ring-2', 'ring-gold/60'), 1400)
}

/**
 * One message. `compact` (CH3): a follow-on from the same author within a few minutes — no
 * avatar or name, and the time shows in the gutter on hover.
 */
function Message({ msg, compact = false, onOpenTask, onQuote, onMeeting, quotedId = null, quoted = null, onCreateTask }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const author = members.find((m) => m.id === msg.authorId)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const now = demoNow()
  const mayEdit = canEditMessage(persona, msg, now)
  const mayDelete = canDeleteMessage(persona, msg, now)
  const pinged = mentions(msg.text, persona.id)
  const { editMessage, deleteMessage, toggleReaction } = useProto.getState()
  const meeting = useProto((s) => (msg.meetingId ? s.meetings.find((x) => x.id === msg.meetingId) : null))
  const channels = useProto((s) => s.channels)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const live = useProto((s) => s.live)

  // A call that took place here (CH2): a line in the conversation, not a message.
  if (msg.kind === 'call') {
    return (
      <div id={`msg-${msg.id}`} className="my-2 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-white/50">
        <span className="grid h-6 w-6 place-items-center rounded-full bg-emerald-500/15 text-emerald-300"><Phone size={12} /></span>
        <span className="text-white/70">{msg.text}</span>
        <span className="text-white/30">· {stamp(msg.at)}</span>
        {/* The meeting record (CH4): its minutes, or a note that they are not shared with you. */}
        {meeting && ((live ? meeting.canRead : canSeeMeeting(persona, meeting, channels, projectDivisions))
          ? <button onClick={() => onMeeting?.(meeting.id)} className="ml-1 rounded-md border border-gold/30 px-1.5 py-0.5 text-[11px] text-gold-light hover:bg-gold/10">{t(meeting.summary || meeting.hasSummary ? 'Minutes' : 'Meeting record')}</button>
          : <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-white/35"><Lock size={11} />{t('Minutes restricted')}</span>)}
      </div>
    )
  }

  return (
    <div id={`msg-${msg.id}`} className={`group relative flex gap-3 rounded-md px-2 transition-shadow ${msg.pending ? 'opacity-60' : ''} ${compact ? 'py-0.5' : 'mt-3 py-1'} ${pinged ? 'bg-gold/[0.06] border-l-2 border-gold/60' : 'hover:bg-black/20'}`}>
      {compact ? (
        <span className="w-8 shrink-0 pt-0.5 text-right text-[10px] leading-5 text-white/30 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100" title={stamp(msg.at)}>
          {msg.at.slice(11, 16)}
        </span>
      ) : (
        <span className="pt-0.5"><Avatar member={author} /></span>
      )}
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="text-sm font-semibold text-white">{author?.name || msg.authorId}</span>
            <span className="text-[11px] text-white/30">{stamp(msg.at)}</span>
            {msg.editedAt && !msg.deleted && <span className="text-[10px] text-white/30">({t('edited')})</span>}
          </div>
        )}

        {msg.deleted ? (
          <div className="text-sm italic text-white/30">{t('message deleted')}</div>
        ) : editing ? (
          <div className="mt-1">
            <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} autoFocus
              className="w-full rounded-lg border border-white/10 bg-navy-950 p-2 text-sm text-white/85 outline-none focus:border-gold/50" />
            <div className="mt-1 flex gap-2 text-xs">
              <button className="text-gold-light" onClick={() => { if (editMessage(msg.id, draft)) setEditing(false) }}>{t('Save')}</button>
              <button className="text-white/50" onClick={() => setEditing(false)}>{t('Cancel')}</button>
            </div>
          </div>
        ) : (
          <>
            {/* The quote of the message replied to, above the reply; up to two lines. */}
            {quotedId && (
              <button onClick={() => jumpTo(quotedId)} className="mb-1 mt-0.5 flex w-full max-w-xl items-start gap-2 rounded-md border-l-2 border-white/25 bg-white/[0.03] px-2 py-1 text-left text-xs hover:bg-white/[0.06]"
                title={t('Go to the original message')} data-quote={quotedId}>
                <Quote size={11} className="mt-0.5 shrink-0 text-white/35" />
                {quoted && !quoted.deleted ? (
                  <span className="min-w-0 line-clamp-2 text-white/55">
                    <span className="text-white/75">{members.find((m) => m.id === quoted.authorId)?.name || quoted.authorId}</span>: {snippet(quoted.text, members, 220)}
                  </span>
                ) : (
                  <em className="text-white/35">{t('Original message deleted')}</em>
                )}
              </button>
            )}
            <div className="text-sm text-white/80">
              <MessageText text={msg.text} onOpenTask={onOpenTask} />
              {compact && msg.editedAt && <span className="ml-1 text-[10px] text-white/30">({t('edited')})</span>}
            </div>
            {taskIdsIn(msg.text).map((id) => <TaskLinkCard key={id} taskId={id} onOpenTask={onOpenTask} />)}
            <Attachments list={msg.attachments} />
          </>
        )}

        {Object.keys(msg.reactions).length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {Object.entries(msg.reactions).map(([emoji, who]) => (
              <button key={emoji} onClick={() => toggleReaction(msg.id, emoji)}
                title={who.map((id) => members.find((m) => m.id === id)?.name).join(', ')}
                className={`rounded-full border px-2 py-0.5 text-xs ${who.includes(persona.id) ? 'border-gold/50 bg-gold/15 text-gold-light' : 'border-white/10 text-white/60'}`}>
                {emoji} {who.length}
              </button>
            ))}
          </div>
        )}

        <SendState msg={msg} />
      </div>

      {!msg.deleted && !editing && !msg.pending && !msg.failed && (
        <div className="absolute -top-3 right-2 hidden items-center gap-0.5 rounded-lg border border-white/10 bg-navy-800 p-0.5 shadow-lg group-hover:flex group-focus-within:flex">
          {picking ? (
            REACTIONS.map((e) => (
              <button key={e} className="rounded px-1.5 py-1 hover:bg-white/10" onClick={() => { toggleReaction(msg.id, e); setPicking(false) }}>{e}</button>
            ))
          ) : (
            <>
              <Tool icon={SmilePlus} label="React" onClick={() => setPicking(true)} />
              {onQuote && <Tool icon={Reply} label="Reply" onClick={onQuote} />}
              {onCreateTask && <Tool icon={ListPlus} label="Create task from message" onClick={onCreateTask} />}
              {mayEdit && <Tool icon={Pencil} label={`Edit (within ${EDIT_WINDOW_MIN} min)`} onClick={() => { setDraft(toDisplay(msg.text, members)); setEditing(true) }} />}
              {mayDelete && <Tool icon={Trash2} label="Delete" onClick={() => { if (window.confirm(t('Delete this message?'))) deleteMessage(msg.id) }} />}
            </>
          )}
        </div>
      )}
    </div>
  )
}

function Tool({ icon: Icon, label, onClick }) {
  const t = useT()
  return (
    <button onClick={onClick} title={t(label)} aria-label={t(label)} className="rounded p-1.5 text-white/50 hover:bg-white/10 hover:text-white">
      <Icon size={15} />
    </button>
  )
}

/** Who can see the channel, Online then Offline (CH3), each ordered PM → leaders → staff → interns. */
function MemberList({ audience, onMessage }) {
  const persona = useProto(selectPersona)
  const presence = useProto((s) => s.presence)
  const t = useT()
  const order = Object.keys(WORKSPACE_ROLES)
  const sorted = [...audience].sort((a, b) => order.indexOf(a.workspaceRole) - order.indexOf(b.workspaceRole) || a.name.localeCompare(b.name))
  const status = (m) => presenceOf(m, presence, persona.id)
  const groups = [
    ['Online', sorted.filter((m) => status(m) !== 'offline')],
    ['Offline', sorted.filter((m) => status(m) === 'offline')],
  ]
  return (
    <div className="flex-1 overflow-y-auto p-4">
      {groups.map(([label, group]) => {
        if (!group.length) return null
        return (
          <div key={label} className="mb-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">{t(label)} — {group.length}</div>
            {group.map((m) => (
              <div key={m.id} className={`group/m flex items-center gap-2 rounded-md px-1 py-1 text-sm hover:bg-white/5 ${label === 'Offline' ? 'opacity-45 hover:opacity-80' : 'text-white/75'}`}>
                <PresenceAvatar member={m} status={status(m)} size="sm" />
                <span className="min-w-0">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate text-[10px] text-white/35">
                    {status(m) === 'dnd' || status(m) === 'idle' ? `${t(STATUS_LABEL[status(m)])} · ` : ''}{t(WORKSPACE_ROLES[m.workspaceRole])}
                  </span>
                </span>
                <span className="ml-auto text-[10px] text-white/30">{t(m.division)}</span>
                {m.id !== persona.id && (
                  <button onClick={() => onMessage(m.id)} className="text-white/35 hover:text-gold-light" title={`${t('Message')} ${m.name}`} aria-label={`${t('Message')} ${m.name}`}>
                    <MessageCircle size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Live chat has to load before there is anyone "you" to show. Until it has — or when it cannot —
 * a plain page stands in; the screen proper only mounts once it can rely on its data.
 */
export default function Chat() {
  const live = useProto((s) => s.live)
  const status = useProto((s) => s.chatStatus)
  const error = useProto((s) => s.chatError)
  if (live && status !== 'ready') return <ChatGate status={status} error={error} />
  return <ChatScreen />
}
