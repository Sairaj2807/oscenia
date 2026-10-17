// A call in a channel or a direct message (CH2) — group or one-to-one, voice or video, with
// screen sharing. Mute and deafen live in the chat's user panel (CH3) and are shared with it;
// the call can be minimised back to the chat while it keeps running.
//
// Prototype: simulated. No microphone, camera or screen is used and nothing is transmitted;
// teammates "join" on their own after a moment. Real calls need a calling service (e.g.
// WebRTC with a media server) on the backend.
import { useEffect, useState } from 'react'
import { Mic, MicOff, Video, VideoOff, MonitorUp, PhoneOff, Users, Headphones, HeadphoneOff, Minimize2, NotebookPen, X } from 'lucide-react'
import AttachmentList from '../AttachmentList'
import { useProto, selectPersona } from '../../store/useProto'
import { Avatar } from '../workspace/parts'
import { useT } from '../../i18n'

const TILE_GRADIENTS = [
  'from-sky-900 to-indigo-950', 'from-emerald-900 to-teal-950', 'from-rose-900 to-fuchsia-950', 'from-amber-900 to-orange-950',
]

export default function CallOverlay({ title, audience, muted = false, deafened = false, onToggleMute, onToggleDeafen, minimized = false, onMinimize }) {
  const t = useT()
  const call = useProto((s) => s.activeCall)
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const { joinCall, leaveCall, toggleShare } = useProto.getState()
  const [camera, setCamera] = useState(Boolean(call?.video))
  const [speaking, setSpeaking] = useState(0)
  // Notes & files (CH4): typed and shared during the call, kept in the meeting record.
  const [panel, setPanel] = useState(false)
  const [note, setNote] = useState('')
  // The on-screen timer counts real seconds since you joined (the demo clock only has minutes).
  const [joinedAt] = useState(() => Date.now())
  const [now, setNow] = useState(() => Date.now())

  // Teammates who can see the channel pick up after a moment — up to three of them.
  useEffect(() => {
    if (!call) return undefined
    const others = audience.filter((m) => m.id !== persona.id && !call.participantIds.includes(m.id)).slice(0, Math.max(0, 4 - call.participantIds.length))
    const timers = others.map((m, i) => setTimeout(() => joinCall(m.id), 900 + i * 700))
    return () => timers.forEach(clearTimeout)
    // Only when the call starts: who joins is decided once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.startedAt])

  // The speaking ring moves between people, and the timer ticks.
  useEffect(() => {
    const talk = setInterval(() => setSpeaking((n) => n + 1), 1600)
    const clockTick = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(talk); clearInterval(clockTick) }
  }, [])

  // Minimised: the call goes on (teammates still join) but the chat stays in view.
  if (!call || minimized) return null
  const people = call.participantIds.map((id) => members.find((m) => m.id === id)).filter(Boolean)
  const sharer = members.find((m) => m.id === call.sharingId)
  const talking = people[speaking % Math.max(1, people.length)]?.id
  const secs = Math.max(0, Math.floor((now - joinedAt) / 1000))
  const clock = `${String(Math.floor(secs / 60)).padStart(2, '0')}:${String(secs % 60).padStart(2, '0')}`

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#05070d] text-white" role="dialog" aria-label={t('Call')}>
      <header className="flex items-center gap-3 border-b border-white/10 px-4 py-3">
        <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{title}</div>
          <div className="text-[11px] text-white/45">{t(call.video ? 'Video call' : 'Voice call')} · {clock}</div>
        </div>
        <span className="inline-flex items-center gap-1 text-xs text-white/50"><Users size={14} />{people.length}</span>
        {onMinimize && (
          <button onClick={onMinimize} className="rounded-md p-1.5 text-white/60 hover:bg-white/10 hover:text-white" title={t('Back to chat')} aria-label={t('Back to chat')}>
            <Minimize2 size={16} />
          </button>
        )}
      </header>

      <div className="relative flex min-h-0 flex-1">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 sm:p-4">
        {sharer && (
          <div className="relative min-h-[220px] flex-[2] overflow-hidden rounded-xl border border-white/10 bg-navy-950">
            <SharedScreen />
            <div className="absolute left-3 top-3 rounded-md bg-black/60 px-2 py-1 text-xs"><MonitorUp size={12} className="mr-1 inline" />{sharer.name} {t('is presenting')}</div>
          </div>
        )}
        <div className={`grid flex-1 gap-3 ${people.length <= 1 ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'} ${sharer ? 'sm:grid-cols-4' : ''}`}>
          {people.map((m, i) => {
            const me = m.id === persona.id
            const camOn = call.video && (me ? camera : true)
            return (
              <div key={m.id} className={`relative flex min-h-[120px] items-center justify-center overflow-hidden rounded-xl border ${talking === m.id && !(me && muted) ? 'border-emerald-400 ring-2 ring-emerald-400/40' : 'border-white/10'} ${camOn ? `bg-gradient-to-br ${TILE_GRADIENTS[i % TILE_GRADIENTS.length]}` : 'bg-white/[0.04]'}`}>
                <div className={camOn ? 'scale-150 opacity-90' : 'scale-125'}><Avatar member={m} /></div>
                <div className="absolute bottom-2 left-2 flex items-center gap-1 rounded bg-black/55 px-1.5 py-0.5 text-[11px]">
                  {me && deafened && <HeadphoneOff size={11} className="text-rose-300" />}{me && muted && <MicOff size={11} className="text-rose-300" />}{m.name}{me ? ` (${t('you')})` : ''}
                </div>
              </div>
            )
          })}
        </div>
        {people.length === 1 && <p className="text-center text-sm text-white/45">{t('Calling…')}</p>}
      </div>
      {panel && (
        <aside className="absolute inset-0 z-10 flex flex-col border-l border-white/10 bg-navy-900 sm:static sm:w-80" aria-label={t('Notes & files')}>
          <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
            <div className="text-sm font-medium">{t('Notes & files')}</div>
            <button onClick={() => setPanel(false)} className="text-white/50 hover:text-white" aria-label={t('Close')}><X size={16} /></button>
          </div>
          <div className="flex-1 space-y-2 overflow-y-auto p-3">
            <p className="text-[11px] text-white/40">{t('Saved with the meeting. Who can read them is decided by the host afterwards.')}</p>
            {(call.notes || []).map((n) => (
              <div key={n.id} className="rounded-md bg-white/[0.04] px-2 py-1.5 text-xs text-white/80">
                <b className="text-gold-light">{members.find((m) => m.id === n.by)?.name}</b> · {n.at.slice(11, 16)} — {n.text}
              </div>
            ))}
            <form onSubmit={(e) => { e.preventDefault(); if (useProto.getState().addCallNote(note)) setNote('') }} className="flex gap-1.5">
              <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder={t('Type a note…')} aria-label={t('Note')}
                className="min-w-0 flex-1 rounded-md border border-white/10 bg-navy-950 px-2 py-1.5 text-sm text-white/85 outline-none focus:border-gold/50" />
              <button className="btn-gold !px-2.5 !py-1.5 text-xs" disabled={!note.trim()}>{t('Add')}</button>
            </form>
            <div className="pt-2 text-[11px] font-semibold uppercase tracking-wide text-white/40">{t('Shared files')}</div>
            <AttachmentList list={call.files || []} canAdd compact onAdd={(file) => useProto.getState().addCallFile(file)} />
          </div>
        </aside>
      )}
      </div>

      <footer className="flex flex-wrap items-center justify-center gap-3 border-t border-white/10 px-4 py-3">
        <Ctl on={!muted} onClick={onToggleMute} label={muted ? 'Unmute' : 'Mute'} icon={muted ? MicOff : Mic} />
        <Ctl on={!deafened} onClick={onToggleDeafen} label={deafened ? 'Undeafen' : 'Deafen'} icon={deafened ? HeadphoneOff : Headphones} />
        {call.video && <Ctl on={camera} onClick={() => setCamera((v) => !v)} label={camera ? 'Turn camera off' : 'Turn camera on'} icon={camera ? Video : VideoOff} />}
        <Ctl on={!panel} onClick={() => setPanel((v) => !v)} label={panel ? 'Hide notes & files' : 'Notes & files'} icon={NotebookPen} />
        <Ctl on={call.sharingId !== persona.id} onClick={toggleShare} label={call.sharingId === persona.id ? 'Stop sharing' : 'Share screen'} icon={MonitorUp} accent={call.sharingId === persona.id} />
        <button onClick={leaveCall} className="inline-flex items-center gap-2 rounded-full bg-rose-600 px-5 py-2.5 text-sm font-medium hover:bg-rose-500">
          <PhoneOff size={16} />{t('Leave')}
        </button>
        <p className="w-full text-center text-[10px] text-white/30">{t('Prototype: simulated call. Real audio, video and screen sharing need a calling service (e.g. WebRTC) on the backend.')}</p>
      </footer>
    </div>
  )
}

function Ctl({ on, onClick, label, icon: Icon, accent = false }) {
  const t = useT()
  return (
    <button onClick={onClick} aria-label={t(label)} title={t(label)} aria-pressed={!on}
      className={`grid h-11 w-11 place-items-center rounded-full ${accent ? 'bg-emerald-600 hover:bg-emerald-500' : on ? 'bg-white/10 hover:bg-white/20' : 'bg-white text-navy-950'}`}>
      <Icon size={18} />
    </button>
  )
}

/** A stand-in for a shared screen: a task board drawn in CSS. */
function SharedScreen() {
  const cols = [['To do', 3], ['In progress', 4], ['Submitted', 2], ['Done', 3]]
  return (
    <div className="absolute inset-0 flex flex-col gap-2 p-4 pt-12" aria-hidden>
      <div className="h-3 w-40 rounded bg-white/15" />
      <div className="grid min-h-0 flex-1 grid-cols-4 gap-2">
        {cols.map(([name, n]) => (
          <div key={name} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-white/[0.04] p-2">
            <div className="truncate text-[10px] uppercase tracking-wider text-white/40">{name}</div>
            {Array.from({ length: n }, (_, i) => (
              <div key={i} className="rounded-md border border-white/10 bg-navy-800 p-1.5">
                <div className="h-1.5 w-3/4 rounded bg-white/25" />
                <div className="mt-1 h-1.5 w-1/2 rounded bg-gold/40" />
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
