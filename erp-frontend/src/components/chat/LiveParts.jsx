// The pieces of team chat that only exist against a real server: whether we are connected, who is
// typing, files on messages, a message that is still being sent (or did not go), earlier history,
// and the page that stands in while the workspace loads.
//
// None of them render in demo mode: each reads `live` from the facade and returns nothing when
// it is false, so the screens can mount them unconditionally.

import { useEffect, useState } from 'react'
import { AlertTriangle, FileText, Loader2, Lock, RefreshCw, WifiOff } from 'lucide-react'
import { useProto } from '../../store/chatProto'
import { useChat } from '../../store/useChat'
import { useT } from '../../i18n'

const KB = 1024
export const formatSize = (bytes) => (bytes < KB * KB ? `${Math.max(1, Math.round(bytes / KB))} KB` : `${(bytes / KB / KB).toFixed(1)} MB`)

/** A thin bar when the live connection is down. Messages still send (over HTTP); new ones from
 *  other people arrive when it is back. */
export function ConnectionBanner() {
  const t = useT()
  const live = useProto((s) => s.live)
  const connection = useProto((s) => s.connection)
  if (!live || connection === 'open' || connection === 'connecting' || connection === 'closed') return null
  return (
    <div role="status" className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-4 py-1.5 text-xs text-amber-200">
      <WifiOff size={13} className="shrink-0" />
      {connection === 'forbidden'
        ? t('Live updates are switched off for this account.')
        : t('Reconnecting… new messages from others will appear when the connection is back.')}
    </div>
  )
}

/** "Rina is typing…", under the messages. Entries expire on their own after a few seconds. */
export function TypingLine({ channelId }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const typing = useProto((s) => s.typing)
  const members = useProto((s) => s.members)
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  if (!live) return <div className="h-5" />
  const now = Date.now()
  const names = Object.entries(typing?.[channelId] || {})
    .filter(([, until]) => until > now)
    .map(([no]) => members.find((m) => m.id === no)?.name?.split(' ')[0] || no)
  let text = ''
  if (names.length === 1) text = `${names[0]} ${t('is typing…')}`
  else if (names.length === 2) text = `${names[0]} ${t('and')} ${names[1]} ${t('are typing…')}`
  else if (names.length > 2) text = t('Several people are typing…')
  return <div className="h-5 px-1 text-[11px] italic text-white/40" aria-live="polite">{text}</div>
}

/** Files on a message. Pictures show in place; anything else is a chip that opens the file.
 *  Links last a few minutes, so an expired one is replaced with a fresh one when it fails. */
export function Attachments({ list }) {
  const t = useT()
  const refresh = useProto((s) => s.refreshAttachment)
  const [retried, setRetried] = useState({})
  if (!list?.length) return null
  const open = async (att) => {
    let url = att.url
    try { url = await refresh(att) } catch { /* use the one we have */ }
    window.open(url, '_blank', 'noopener,noreferrer')
  }
  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {list.map((att) =>
        att.contentType?.startsWith('image/') ? (
          <button key={att.id} onClick={() => open(att)} className="block overflow-hidden rounded-lg border border-white/10" title={att.filename}>
            <img src={att.url} alt={att.filename} loading="lazy" className="max-h-56 max-w-xs object-cover"
              onError={async (e) => {
                if (retried[att.id]) return
                setRetried((r) => ({ ...r, [att.id]: true }))
                try { e.currentTarget.src = await refresh(att) } catch { /* leave it broken */ }
              }} />
          </button>
        ) : (
          <button key={att.id} onClick={() => open(att)}
            className="flex max-w-xs items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-sm text-white/80 hover:bg-white/[0.07]">
            <FileText size={16} className="shrink-0 text-gold/80" />
            <span className="min-w-0">
              <span className="block truncate">{att.filename}</span>
              <span className="block text-[10px] text-white/35">{formatSize(att.sizeBytes)} · {t('Open')}</span>
            </span>
          </button>
        )
      )}
    </div>
  )
}

/** Under a message of yours that is on its way, or did not arrive. */
export function SendState({ msg }) {
  const t = useT()
  const retry = useProto((s) => s.retrySend)
  const discard = useProto((s) => s.discardSend)
  if (msg.pending) {
    return <div className="mt-0.5 flex items-center gap-1 text-[10px] text-white/35"><Loader2 size={10} className="animate-spin" />{t('Sending…')}</div>
  }
  if (msg.failed) {
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-2 text-[11px] text-rose-300" role="alert">
        <AlertTriangle size={12} className="shrink-0" />
        <span className="min-w-0">{t('Not sent')}{msg.error ? ` — ${msg.error}` : ''}</span>
        <button onClick={() => retry(msg.id)} className="inline-flex items-center gap-1 rounded border border-rose-400/40 px-1.5 py-0.5 hover:bg-rose-500/10"><RefreshCw size={11} />{t('Retry')}</button>
        <button onClick={() => discard(msg.id)} className="text-white/50 hover:text-white">{t('Discard')}</button>
      </div>
    )
  }
  return null
}

/** At the top of the messages: earlier history, when there is more. */
export function LoadEarlier({ channelId }) {
  const t = useT()
  const live = useProto((s) => s.live)
  const state = useProto((s) => s.loaded?.[channelId])
  const loadOlder = useProto((s) => s.loadOlder)
  if (!live || !state?.hasMoreBefore) return null
  return (
    <div className="mb-2 flex justify-center">
      <button onClick={() => loadOlder(channelId)} disabled={state.loading}
        className="rounded-full border border-white/15 px-3 py-1 text-xs text-white/60 hover:border-gold/40 hover:text-white disabled:opacity-50">
        {state.loading ? t('Loading…') : t('Load earlier messages')}
      </button>
    </div>
  )
}

/** What the chat page shows instead of the chat while the workspace loads, or when it cannot. */
export function ChatGate({ status, error, area = 'Chat' }) {
  const t = useT()
  if (status === 'forbidden') {
    return (
      <Centered icon={<Lock className="text-gold/70" size={28} />} title={t('You are not in the workspace yet')}>
        {t(`${area} is for people on the project team. Ask the project manager to add you.`)}
      </Centered>
    )
  }
  if (status === 'error') {
    return (
      <Centered icon={<WifiOff className="text-gold/70" size={28} />} title={t(`${area} could not be reached`)}>
        <span className="block">{error?.message || t('The server did not answer.')}</span>
        <button className="btn-gold mt-3" onClick={() => useChat.getState().start()}>{t('Try again')}</button>
      </Centered>
    )
  }
  return (
    <Centered icon={<Loader2 className="animate-spin text-gold/70" size={26} />} title={t(`Loading ${area.toLowerCase()}…`)} />
  )
}

function Centered({ icon, title, children }) {
  return (
    <div className="flex h-[calc(100vh-4rem)] items-center justify-center p-6">
      <div className="max-w-sm text-center">
        <div className="flex justify-center">{icon}</div>
        <div className="mt-3 font-display text-lg text-white">{title}</div>
        {children && <p className="mt-2 text-sm text-white/50">{children}</p>}
      </div>
    </div>
  )
}
