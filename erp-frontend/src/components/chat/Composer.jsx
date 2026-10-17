// Message box. Typing `@` opens a people picker (people who can see this channel), `#` opens
// a task picker (tasks the persona can see). Enter sends, Shift+Enter adds a line. Mentions
// and task links are converted to id tokens by the store on send, so a pasted task URL works
// too.
import { useEffect, useRef, useState } from 'react'
import { Send, Hash, AtSign, Quote, X, Paperclip, Loader2, FileText } from 'lucide-react'
import { useProto, selectPersona } from '../../store/chatProto'
import { visibleTasks } from '../../lib/workspaceAccess'
import { snippet } from '../../lib/chat'
import { Avatar } from '../workspace/parts'
import { formatSize } from './LiveParts'
import { useT } from '../../i18n'

const MENTION_AT_CARET = /(?:^|\s)@([^\s@#]*(?: [^\s@#]*)?)$/
const TASK_AT_CARET = /(?:^|\s)#([\w-]*)$/

/**
 * `quote` (CH1): the message being replied to in the main chat, shown above the box until the
 * reply is sent or the quote is dismissed (× or Escape). The reply posts at the bottom of the
 * stream with the quote above it; there are no thread replies (round 3).
 */
export default function Composer({ channelId, channelName, audience, placeholder, onSent, quote = null, onClearQuote }) {
  const t = useT()
  const ref = useRef(null)
  const persona = useProto(selectPersona)
  const tasks = useProto((s) => s.tasks)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const live = useProto((s) => s.live)
  const fileRef = useRef(null)
  // Files being attached (live only): uploaded as they are chosen, sent with the message.
  const [files, setFiles] = useState([])
  const [text, setText] = useState('')
  const [caret, setCaret] = useState(0)
  const [highlight, setHighlight] = useState(0)
  const [dismissedAt, setDismissedAt] = useState(null)

  // Clicking Reply on a message puts the cursor here, ready to type.
  useEffect(() => { if (quote?.id) ref.current?.focus() }, [quote?.id])

  const before = text.slice(0, caret)
  const mention = before.match(MENTION_AT_CARET)
  const taskRef = !mention && before.match(TASK_AT_CARET)
  const query = (mention?.[1] ?? taskRef?.[1] ?? '').toLowerCase()

  let options = []
  if (dismissedAt !== caret) {
    if (mention) {
      // Matching nobody (e.g. a space typed after an email-like @) simply closes the picker.
      options = audience.filter((m) => m.name.toLowerCase().includes(query)).slice(0, 6)
    } else if (taskRef) {
      options = visibleTasks(persona, tasks, projectDivisions)
        .filter((x) => x.id.toLowerCase().includes(query) || x.title.toLowerCase().includes(query))
        .slice(0, 6)
    }
  }
  const open = options.length > 0
  const active = Math.min(highlight, options.length - 1)

  const setAndTrack = (value, pos) => {
    setText(value)
    setCaret(pos)
    setHighlight(0)
    setDismissedAt(null)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(pos, pos)
    })
  }

  const pick = (option) => {
    const typed = (mention || taskRef)[1]
    const start = before.length - typed.length - 1
    const insert = mention ? `@${option.name} ` : `#${option.id} `
    const value = text.slice(0, start) + insert + text.slice(caret)
    setAndTrack(value, start + insert.length)
  }

  const addFiles = (list) => {
    const room = Math.max(0, 5 - files.length)
    Array.from(list).slice(0, room).forEach((file) => {
      const key = `${file.name}-${file.size}-${Math.random().toString(16).slice(2)}`
      setFiles((f) => [...f, { key, name: file.name, size: file.size, uploading: true }])
      useProto.getState().uploadFile(channelId, file)
        .then((attachment) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, uploading: false, attachment } : x))))
        .catch((err) => setFiles((f) => f.map((x) => (x.key === key ? { ...x, uploading: false, error: err?.message || 'Upload failed' } : x))))
    })
    if (fileRef.current) fileRef.current.value = ''
  }
  const uploading = files.some((f) => f.uploading)

  const send = () => {
    if (!text.trim() || uploading) return
    const ready = files.filter((f) => f.attachment).map((f) => f.attachment)
    const id = useProto.getState().postMessage(channelId, text, null, quote?.id || null, ready)
    if (id) {
      setText('')
      setFiles([])
      setCaret(0)
      onClearQuote?.()
      onSent?.(id)
    }
  }

  const onKeyDown = (e) => {
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((active + 1) % options.length); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((active - 1 + options.length) % options.length); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pick(options[active]); return }
      if (e.key === 'Escape') { e.preventDefault(); setDismissedAt(caret); return }
    }
    if (e.key === 'Escape' && quote) { e.preventDefault(); onClearQuote?.(); return }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  const insertTrigger = (ch) => {
    const pad = before && !/\s$/.test(before) ? ' ' : ''
    const value = `${before}${pad}${ch}${text.slice(caret)}`
    setAndTrack(value, before.length + pad.length + 1)
  }

  return (
    <div className="relative">
      {open && (
        <div className="absolute bottom-full left-0 right-0 mb-2 rounded-lg border border-white/10 bg-navy-800 p-1 shadow-2xl z-10">
          <div className="px-2 py-1 text-[10px] uppercase tracking-wider text-white/35">
            {mention ? t('Mention someone in this channel') : t('Link a task')}
          </div>
          {options.map((o, i) => (
            <button
              key={o.id}
              onMouseDown={(e) => { e.preventDefault(); pick(o) }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm ${i === active ? 'bg-gold/15 text-white' : 'text-white/75 hover:bg-white/5'}`}
            >
              {mention ? (
                <><Avatar member={o} size="sm" /> {o.name} <span className="text-xs text-white/35">{t(o.division)}</span></>
              ) : (
                <><span className="font-mono text-[11px] text-white/40">{o.id}</span> <span className="truncate">{o.title}</span></>
              )}
            </button>
          ))}
        </div>
      )}
      {quote && (
        <div className="mb-1 flex items-center gap-2 rounded-t-lg border border-b-0 border-white/10 bg-white/[0.03] px-3 py-1.5 text-xs">
          <Quote size={12} className="shrink-0 text-gold/70" />
          <span className="min-w-0 flex-1 truncate text-white/60">
            {t('Replying to')} <span className="text-white/85">{members.find((m) => m.id === quote.authorId)?.name || quote.authorId}</span>:{' '}
            {quote.deleted ? <em>{t('message deleted')}</em> : snippet(quote.text, members)}
          </span>
          <button onClick={onClearQuote} className="text-white/40 hover:text-white" aria-label={t('Cancel reply')}><X size={14} /></button>
        </div>
      )}
      <div className="flex items-end gap-2 rounded-lg border border-white/10 bg-navy-900 p-2 focus-within:border-gold/40">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={placeholder || `${t('Message')} ${channelName.startsWith('@') ? channelName : `#${channelName}`}`}
          onChange={(e) => {
            setText(e.target.value); setCaret(e.target.selectionStart); setDismissedAt(null)
            if (e.target.value) useProto.getState().sendTyping?.(channelId) // live: others see "is typing…"
          }}
          onSelect={(e) => setCaret(e.target.selectionStart)}
          onKeyDown={onKeyDown}
          className="max-h-40 min-h-[36px] flex-1 resize-none bg-transparent px-1 py-1.5 text-sm text-white/90 outline-none placeholder:text-white/30"
        />
        <button onClick={() => insertTrigger('@')} className="p-1.5 text-white/40 hover:text-gold-light" title={t('Mention someone')} aria-label={t('Mention someone')}><AtSign size={16} /></button>
        <button onClick={() => insertTrigger('#')} className="p-1.5 text-white/40 hover:text-gold-light" title={t('Link a task')} aria-label={t('Link a task')}><Hash size={16} /></button>
        {live && (
          <>
            <input ref={fileRef} type="file" multiple hidden onChange={(e) => addFiles(e.target.files)}
              accept=".pdf,.png,.jpg,.jpeg,.webp,.csv,.txt,application/pdf,image/png,image/jpeg,image/webp,text/csv,text/plain" />
            <button onClick={() => fileRef.current?.click()} disabled={files.length >= 5} className="p-1.5 text-white/40 hover:text-gold-light disabled:opacity-30"
              title={t('Attach a file')} aria-label={t('Attach a file')}><Paperclip size={16} /></button>
          </>
        )}
        <button onClick={send} disabled={!text.trim() || uploading} className="btn-gold !px-3 !py-1.5" aria-label={t('Send')}><Send size={15} /></button>
      </div>
      {files.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1.5" aria-label={t('Files to send')}>
          {files.map((f) => (
            <span key={f.key} className={`flex max-w-[16rem] items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${f.error ? 'border-rose-400/40 text-rose-300' : 'border-white/15 text-white/70'}`}>
              {f.uploading ? <Loader2 size={12} className="shrink-0 animate-spin" /> : <FileText size={12} className="shrink-0" />}
              <span className="truncate">{f.name}</span>
              <span className="shrink-0 text-white/35">{f.error ? f.error : formatSize(f.size)}</span>
              <button onClick={() => setFiles((l) => l.filter((x) => x.key !== f.key))} aria-label={`${t('Remove')} ${f.name}`} className="shrink-0 text-white/40 hover:text-white"><X size={12} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="mt-1 px-1 text-[10px] text-white/25">{t('@ to mention · # to link a task · Enter to send, Shift+Enter for a new line')}</div>
    </div>
  )
}
