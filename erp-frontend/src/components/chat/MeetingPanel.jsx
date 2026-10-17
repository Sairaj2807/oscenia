// A meeting record (CH4): Summary & MOM, Transcript, Files and — for the host or PM — Access.
// Opened from a call line in the chat (`?meeting=MTG-1`). What a persona may read or change is
// worked out in lib/meetings.js and checked again by the store. Signed in, the server decides:
// the meeting says what you may do (`canRead`, `canManage`, …) and the minutes are written there.
import { useEffect, useState } from 'react'
import { X, Sparkles, Copy, Download, ListPlus, Send, Lock, RefreshCw } from 'lucide-react'
import { Avatar } from '../workspace/parts'
import AttachmentList from '../AttachmentList'
import { useProto, selectPersona } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { canSeeMeeting, canManageMeeting, canOpenMeetingFiles, momMarkdown, ACCESS_LABEL, MEETING_ACCESS } from '../../lib/meetings'
import { summarizeMeeting } from '../../lib/meetingAi'
import { canOpenChannel } from '../../lib/workspaceAccess'
import { callLength, minutesBetween } from '../../lib/chat'
import { useT } from '../../i18n'

const TABS = ['Summary & MOM', 'Transcript', 'Files', 'Access']
// Why the minutes were written by rules instead of the AI (the server's `reason`).
const REASONS = {
  not_configured: 'No AI service is connected, so rules wrote the minutes from the transcript.',
  limit: 'You have used today’s AI summaries, so rules wrote the minutes from the transcript.',
  failed: 'The AI service did not answer well, so rules wrote the minutes from the transcript.',
}

export default function MeetingPanel({ meetingId, onClose, onOpenTask }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const meeting = useProto((s) => s.meetings.find((m) => m.id === meetingId))
  const channels = useProto((s) => s.channels)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const projects = useStore((s) => s.projects)
  const live = useProto((s) => s.live)
  const state = useProto((s) => s.meetingState?.[meetingId])
  const [tab, setTab] = useState(TABS[0])
  const channel = channels.find((c) => c.id === meeting?.channelId)
  // Signed in, the list only knows that the meeting happened; what was said is fetched on opening.
  useEffect(() => {
    if (live) useProto.getState().loadMeeting?.(meetingId)
  }, [live, meetingId])
  const name = (id) => members.find((m) => m.id === id)?.name || id

  const head = (
    <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
      <div className="min-w-0">
        <div className="text-sm font-medium text-white">{t('Meeting')} {meeting?.id}</div>
        {meeting && <div className="truncate text-[11px] text-white/40">{channel?.dm ? t('Direct message') : channel?.kind === 'voice' ? channel.name : `#${channel?.name}`} · {meeting.startedAt.slice(0, 10)}</div>}
      </div>
      <button onClick={onClose} className="text-white/50 hover:text-white" aria-label={t('Close')}><X size={18} /></button>
    </div>
  )
  const mayRead = live ? Boolean(meeting?.canRead) : Boolean(meeting && canSeeMeeting(persona, meeting, channels, projectDivisions))
  if (live && mayRead && !meeting.detail && state !== 'missing') {
    return <>{head}<div className="flex flex-1 items-center justify-center p-6 text-sm text-white/45">{t('Loading…')}</div></>
  }
  if (live && !meeting && state !== 'missing') {
    return <>{head}<div className="flex flex-1 items-center justify-center p-6 text-sm text-white/45">{t('Loading…')}</div></>
  }
  if (!mayRead) {
    // Not found and not shared look the same, so a link reveals nothing about the meeting.
    return (
      <>
        <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
          <div className="text-sm font-medium text-white">{t('Meeting')}</div>
          <button onClick={onClose} className="text-white/50 hover:text-white" aria-label={t('Close')}><X size={18} /></button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <Lock size={24} className="text-gold/70" />
          <div className="mt-3 text-sm text-white">{t('Minutes restricted')}</div>
          <p className="mt-1 text-xs text-white/45">{t('These minutes have not been shared with you.')}</p>
        </div>
      </>
    )
  }

  const manages = live ? meeting.canManage : canManageMeeting(persona, meeting, channels)
  const filesOpen = live ? meeting.canOpenFiles : canOpenMeetingFiles(persona, meeting, channels, projectDivisions)
  const tabs = TABS.filter((x) => x !== 'Access' || manages)
  return (
    <>
      {head}
      <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-white/10 px-2">
        {tabs.map((x) => (
          <button key={x} role="tab" aria-selected={tab === x} onClick={() => setTab(x)}
            className={`whitespace-nowrap border-b-2 px-2.5 py-2 text-xs ${tab === x ? 'border-gold text-gold-light' : 'border-transparent text-white/50 hover:text-white/80'}`}>
            {t(x)}{x === 'Files' && meeting.files.length ? ` · ${meeting.files.length}` : ''}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto p-4" role="tabpanel">
        {tab === 'Summary & MOM' && <Summary meeting={meeting} channel={channel} name={name} manages={manages} projectName={projects.find((p) => p.id === channel?.projectId)?.name} onOpenTask={onOpenTask} />}
        {tab === 'Transcript' && (
          <div className="space-y-2 text-sm">
            {!live && <p className="text-[11px] text-white/35">{t('Prototype: the call is simulated, so this transcript is too.')}</p>}
            {meeting.transcript.map((l, i) => (
              <div key={i} className="flex gap-2">
                <span className="w-10 shrink-0 text-[11px] text-white/35">{l.at.slice(11, 16)}</span>
                <span className="min-w-0"><span className="font-medium text-white/85">{name(l.speakerId)}</span> <span className="text-white/70">{l.text}</span></span>
              </div>
            ))}
            {meeting.notes.length > 0 && <div className="pt-3 text-[11px] font-semibold uppercase tracking-wide text-white/40">{t('Notes taken during the call')}</div>}
            {meeting.notes.map((n) => <div key={n.id} className="rounded-md bg-gold/[0.06] px-2 py-1.5 text-xs text-white/75"><b className="text-gold-light">{name(n.by)}</b> · {n.at.slice(11, 16)} — {n.text}</div>)}
          </div>
        )}
        {tab === 'Files' && (
          <AttachmentList list={meeting.files} canAdd={false} viewOnly={!filesOpen} />
        )}
        {tab === 'Access' && manages && <AccessForm meeting={meeting} channel={channel} members={members} projectDivisions={projectDivisions} />}
      </div>
    </>
  )
}

function Summary({ meeting, channel, name, manages, projectName, onOpenTask }) {
  const t = useT()
  const members = useProto((s) => s.members)
  const pushToast = useStore((s) => s.pushToast)
  const lang = useStore((s) => s.lang)
  const live = useProto((s) => s.live)
  const [busy, setBusy] = useState(false)
  const s = meeting.summary
  const title = channel?.dm ? t('Direct message') : `${channel?.kind === 'voice' ? channel.name : `#${channel?.name}`}${projectName ? ` · ${projectName}` : ''}`
  const md = () => momMarkdown(meeting, members, title)

  const generate = async () => {
    setBusy(true)
    try {
      if (live) {
        // The server writes them from the stored transcript: with the AI when it is connected and
        // you are under your daily limit, otherwise by rules — and says which.
        const r = await useProto.getState().writeMinutes(meeting.id, { lang })
        if (r.ok && r.reason) pushToast({ title: t('Written without AI'), body: t(REASONS[r.reason] || REASONS.failed), kind: 'redflag' })
        return
      }
      // The minutes come back in the app's language (English or Bahasa Indonesia).
      const result = await summarizeMeeting(meeting, members, { projectName, title, lang })
      useProto.getState().saveMeetingSummary(meeting.id, result)
      if (result.reason) pushToast({ title: t('AI unavailable — demo summary used'), body: result.reason, kind: 'redflag' })
    } finally { setBusy(false) }
  }
  const copy = async () => {
    try { await navigator.clipboard.writeText(md()); pushToast({ title: t('Minutes copied'), body: t('Paste them into an email or a document.') }) } catch {
      pushToast({ title: t('Could not copy'), body: t('Use Download instead.'), kind: 'redflag' })
    }
  }
  const download = () => {
    const url = URL.createObjectURL(new Blob([md()], { type: 'text/markdown' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: `MOM-${meeting.id}-${meeting.startedAt.slice(0, 10)}.md` })
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  const toTasks = async () => {
    const r = await useProto.getState().createTasksFromMeeting(meeting.id)
    if (r.error && !r.created.length) return pushToast({ title: t('No tasks created'), body: t(r.error), kind: 'redflag' })
    pushToast({
      title: `${r.created.length} ${t(r.created.length === 1 ? 'task created' : 'tasks created')}`,
      body: r.skipped.length ? `${t('Skipped (you can’t assign them, or already a task)')}: ${r.skipped.join('; ')}` : r.created.join(', '),
      kind: r.skipped.length ? 'redflag' : 'project',
    })
  }
  const post = async () => { if (await useProto.getState().postMeetingSummary(meeting.id)) pushToast({ title: t('Summary posted'), body: title }) }
  const mayPost = live ? meeting.canPostSummary || Boolean(meeting.summaryPostedAt) : s && !meeting.dm && meeting.access.mode === 'channel' && meeting.logChannelId

  const btn = 'inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2.5 py-1.5 text-xs text-white/75 hover:bg-white/5 disabled:opacity-40'
  return (
    <div className="space-y-4 text-sm">
      <div className="text-xs text-white/50">
        {meeting.startedAt.slice(0, 10)} · {meeting.startedAt.slice(11, 16)}–{meeting.endedAt.slice(11, 16)} · {t(callLength(minutesBetween(meeting.startedAt, meeting.endedAt)))}
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {meeting.participantIds.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded-full bg-white/5 py-0.5 pl-0.5 pr-2 text-[11px] text-white/70">
              <Avatar member={members.find((m) => m.id === id)} size="sm" />{name(id)}{id === meeting.hostId ? ` · ${t('host')}` : ''}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {/* Anyone who reads the meeting may write the first minutes; only the host or PM replaces them. */}
        {(!s || manages) && (
          <button className="btn-gold !py-1.5 text-xs" onClick={generate} disabled={busy}>
            {s ? <RefreshCw size={13} /> : <Sparkles size={13} />}{busy ? t('Working…') : t(s ? 'Regenerate' : live ? 'Write summary & MOM' : 'Generate AI summary & MOM')}
          </button>
        )}
        {s && <button className={btn} onClick={copy}><Copy size={13} />{t('Copy MOM')}</button>}
        {s && <button className={btn} onClick={download}><Download size={13} />{t('Download MOM (.md)')}</button>}
        {s?.actionItems.length > 0 && <button className={btn} onClick={toTasks}><ListPlus size={13} />{t('Create tasks from action items')}</button>}
        {/* Only offered when everyone in the channel may read the minutes anyway. */}
        {s && mayPost && (
          <button className={btn} onClick={post} disabled={Boolean(meeting.summaryPostedAt)}><Send size={13} />{t(meeting.summaryPostedAt ? 'Summary posted' : 'Post summary to channel')}</button>
        )}
      </div>

      {!s ? (
        <p className="text-xs text-white/45">{t('No summary yet. Generate one from the transcript and the notes taken during the call.')}</p>
      ) : (
        <>
          <div className={`rounded-md px-2 py-1 text-[11px] ${s.source === 'ai' ? 'bg-emerald-500/10 text-emerald-200' : s.source === 'demo' ? 'bg-gold/10 text-gold-light' : 'bg-white/5 text-white/50'}`}>
            {s.source === 'ai' ? `${t('AI summary')} · ${s.provider} · ${s.model}`
              : s.source === 'demo' ? t('Demo AI summary — simulated, no AI service connected')
                : s.source === 'offline' ? t('Rule-based summary — written without AI') : t('Summary prepared for the demo')}
          </div>
          <p className="text-white/80">{s.overview}</p>
          <Section title="Agenda" items={s.agenda} />
          <Section title="Discussion" items={s.discussion} />
          <Section title="Decisions" items={s.decisions} />
          <div>
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">{t('Action items')}</div>
            {s.actionItems.length === 0 && <div className="text-xs text-white/35">{t('None.')}</div>}
            <ul className="space-y-1">
              {s.actionItems.map((a, i) => (
                <li key={i} className="rounded-md border border-white/10 px-2 py-1.5 text-xs">
                  <div className="text-white/85">{a.text}</div>
                  <div className="mt-0.5 text-white/40">
                    {a.ownerId ? name(a.ownerId) : t('No owner')}{a.due ? ` · ${t('due')} ${a.due}` : ''}
                    {a.taskId && <> · <button className="text-sky-300 hover:underline" onClick={() => onOpenTask?.(a.taskId)}>{a.taskId}</button></>}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  )
}

function Section({ title, items }) {
  const t = useT()
  if (!items?.length) return null
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/40">{t(title)}</div>
      <ul className="list-disc space-y-0.5 pl-4 text-white/75">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}

/** Host / PM: who may read the minutes and whether files can be opened. */
function AccessForm({ meeting, channel, members, projectDivisions }) {
  const t = useT()
  const pushToast = useStore((s) => s.pushToast)
  const [mode, setMode] = useState(meeting.access.mode)
  const [extraIds, setExtraIds] = useState(meeting.access.extraIds)
  const [viewOnly, setViewOnly] = useState(meeting.filesViewOnly)
  // Only people who can open the channel can be named, and those on the call already can read.
  const candidates = members.filter((m) => canOpenChannel(m, channel, projectDivisions) && !meeting.participantIds.includes(m.id) && m.workspaceRole !== 'pm')
  const modes = channel.dm ? ['participants'] : MEETING_ACCESS
  const save = async () => {
    if (!(await useProto.getState().setMeetingAccess(meeting.id, { mode, extraIds, filesViewOnly: viewOnly }))) return
    setExtraIds(useProto.getState().meetings.find((m) => m.id === meeting.id).access.extraIds)
    pushToast({ title: t('Access saved'), body: t(ACCESS_LABEL[mode]) })
  }
  return (
    <div className="space-y-3 text-sm">
      <fieldset>
        <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">{t('Who can read the minutes and files')}</legend>
        {modes.map((k) => (
          <label key={k} className={`mb-1.5 flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 ${mode === k ? 'border-gold/50 bg-gold/[0.06]' : 'border-white/10'}`}>
            <input type="radio" name="meeting-access" checked={mode === k} onChange={() => setMode(k)} className="accent-[#c6a15b]" />{t(ACCESS_LABEL[k])}
          </label>
        ))}
        {channel.dm && <p className="text-xs text-white/40">{t('A call in a direct message stays between its two people.')}</p>}
        {!channel.dm && <p className="text-xs text-white/40">{t('The PM can always read minutes of channel calls.')}</p>}
      </fieldset>
      {mode === 'people' && (
        <fieldset>
          <legend className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-white/45">{t('Also share with')}</legend>
          <div className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-white/10 p-1">
            {candidates.map((m) => (
              <label key={m.id} className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-white/80 hover:bg-white/5">
                <input type="checkbox" checked={extraIds.includes(m.id)} className="accent-[#c6a15b]"
                  onChange={() => setExtraIds((l) => (l.includes(m.id) ? l.filter((x) => x !== m.id) : [...l, m.id]))} />
                <Avatar member={m} size="sm" />{m.name}
              </label>
            ))}
            {candidates.length === 0 && <div className="px-1.5 py-1 text-xs text-white/30">{t('Nobody to show.')}</div>}
          </div>
        </fieldset>
      )}
      <label className="flex items-start gap-2 text-white/80">
        <input type="checkbox" checked={viewOnly} onChange={(e) => setViewOnly(e.target.checked)} className="mt-1 accent-[#c6a15b]" />
        <span>{t('Files view-only')}<span className="block text-xs text-white/40">{t('Others see the name and size, but cannot open or download them.')}</span></span>
      </label>
      <button className="btn-gold" onClick={save}>{t('Save access')}</button>
    </div>
  )
}
