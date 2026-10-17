// Meeting records (CH4): what a call leaves behind — who was there, a transcript, notes typed
// during it, files shared in it, and the summary + minutes (MOM). Who may read them is decided
// per meeting by the host. Pure functions over plain data, like the other access rules.
//
// Prototype: calls are simulated, so the transcript is too — built from a small bank of lines
// that read like a real project meeting, spoken by the people who took part. It is
// deterministic (the same call always gives the same transcript), so tests can rely on it.

import { canOpenChannel } from './workspaceAccess.js'

export const MEETING_ACCESS = ['participants', 'channel', 'people']
export const ACCESS_LABEL = {
  participants: 'People who were on the call',
  channel: 'Everyone in the channel',
  people: 'People on the call, plus named people',
}

// {a} … {d}: the 1st–4th person on the call. Lines marked as decisions or actions read that way
// to the rule-based summary below.
const SCRIPT = [
  ['{a}', 'Thanks for joining. Quick agenda: where we are on {project}, open issues, and next steps.'],
  ['{b}', 'From my side the run-of-show draft is ready, but the timings for the second half are still rough.'],
  ['{a}', 'What is blocking the second half?'],
  ['{b}', 'We are waiting on the venue for the load-in window. They promised it this week.'],
  ['{c}', 'Rigging needs that window too — without it we can’t book the crew.'],
  ['{a}', 'Agreed: we lock the load-in window before we book anything else.'],
  ['{c}', 'I’ll call the venue manager tomorrow morning and get it in writing.'],
  ['{d}', 'Catering asked for a final headcount. RSVPs are at about seventy percent.'],
  ['{a}', 'Then we send a reminder to everyone who hasn’t answered.'],
  ['{d}', 'I’ll send the RSVP reminder by Friday.'],
  ['{b}', 'Budget-wise we are on track, but the lighting quote came in ten percent higher.'],
  ['{a}', 'Decision: we keep the current lighting vendor and ask for a revised quote.'],
  ['{b}', 'Can you send me the old quote so I can compare?'],
  ['{a}', 'Yes — I’ll share the old lighting quote in the channel after this call.'],
  ['{c}', 'One more thing: the client wants a walkthrough next week.'],
  ['{a}', 'Let’s go with Tuesday afternoon for the client walkthrough.'],
  ['{b}', 'I’ll prepare the walkthrough deck by Monday.'],
  ['{a}', 'Good. Anything else? … Then that’s it — thanks, everyone.'],
]

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const addMinutes = (at, n) => new Date(Date.parse(`${at}:00Z`) + n * 60000).toISOString().slice(0, 16)
const minutes = (a, b) => Math.max(1, Math.round((Date.parse(`${b}:00Z`) - Date.parse(`${a}:00Z`)) / 60000))

/**
 * A believable transcript for a call: { at, speakerId, text }[]. Spread across the call's
 * length, spoken by its participants (the host leads). The same call gives the same lines.
 */
export function simulateTranscript({ participantIds, hostId, startedAt, endedAt }, projectName = 'the project') {
  const people = [hostId, ...participantIds.filter((id) => id !== hostId)]
  const length = minutes(startedAt, endedAt)
  // Every call gets the opening, one decision, one action item and the close, so even a
  // one-minute demo call has something to summarise; a longer call fills in more of the middle.
  const count = Math.min(SCRIPT.length, Math.max(4, Math.round(length * 1.2)))
  const required = [0, 5, 6, SCRIPT.length - 1]
  const rest = SCRIPT.map((_, i) => i).filter((i) => !required.includes(i))
  const refs = [...required, ...rest.slice(0, count - required.length)].sort((x, y) => x - y)
  return refs.map((ref, i) => {
    const [who, text] = SCRIPT[ref]
    const slot = { '{a}': 0, '{b}': 1, '{c}': 2, '{d}': 3 }[who]
    return {
      at: addMinutes(startedAt, Math.floor((i * length) / refs.length)),
      speakerId: people[slot % people.length],
      text: text.replace('{project}', projectName),
      // Which script line this is, so the demo AI summary can paraphrase it (demoMinutes).
      ref,
    }
  })
}

/** Can `member` read this meeting's summary, transcript and file list? */
export function canSeeMeeting(member, meeting, channels, projectDivisions) {
  const channel = channels.find((c) => c.id === meeting?.channelId)
  if (!member || !channel || !canOpenChannel(member, channel, projectDivisions)) return false
  if (meeting.hostId === member.id || meeting.participantIds.includes(member.id)) return true
  // A call in a direct message is for its two people: never the PM, never anyone else.
  if (channel.dm) return false
  if (member.workspaceRole === 'pm') return true
  if (meeting.access.mode === 'channel') return true
  return meeting.access.mode === 'people' && meeting.access.extraIds.includes(member.id)
}

/** The host decides who sees the minutes; the PM may too, except for a DM call. */
export function canManageMeeting(member, meeting, channels) {
  const channel = channels.find((c) => c.id === meeting?.channelId)
  if (!member || !channel) return false
  return meeting.hostId === member.id || (member.workspaceRole === 'pm' && !channel.dm)
}

/** View-only files show name and size; only the host (or PM) can still open them. */
export function canOpenMeetingFiles(member, meeting, channels, projectDivisions) {
  return canSeeMeeting(member, meeting, channels, projectDivisions) && (!meeting.filesViewOnly || canManageMeeting(member, meeting, channels))
}

// "by Friday" / "by Monday" / "tomorrow" → a date after the meeting; otherwise three days on.
function dueFrom(text, day) {
  const d = new Date(`${day}T12:00:00Z`)
  if (/tomorrow/i.test(text)) d.setUTCDate(d.getUTCDate() + 1)
  else {
    const named = DAYS.findIndex((n) => new RegExp(`\\b(by|on)\\s+${n}\\b`, 'i').test(text))
    d.setUTCDate(d.getUTCDate() + (named >= 0 ? ((named - d.getUTCDay() + 7) % 7 || 7) : 3))
  }
  return d.toISOString().slice(0, 10)
}

const DECISION = /^(agreed|decision)\b|let[’']s go with|\bwe keep\b|\bwe lock\b/i
const ACTION = /\bI[’']ll\b|\bI will\b/i

/**
 * The rule-based summary and MOM, used when the AI is not connected: decisions and action
 * items are picked out of the transcript by their wording; notes become discussion points.
 */
export function offlineMinutes(meeting, members, projectName = 'the project') {
  const name = (id) => members.find((m) => m.id === id)?.name || id
  const lines = meeting.transcript || []
  const decisions = lines.filter((l) => DECISION.test(l.text)).map((l) => l.text.replace(/^(agreed|decision)\s*:\s*/i, '').replace(/^./, (c) => c.toUpperCase()))
  const actionItems = lines.filter((l) => ACTION.test(l.text)).map((l) => ({
    text: l.text.replace(/^(yes\s*[—-]\s*)?I[’']ll\s+|^I will\s+/i, '').replace(/\.$/, '').replace(/^./, (c) => c.toUpperCase()),
    ownerId: l.speakerId,
    due: dueFrom(l.text, meeting.endedAt.slice(0, 10)),
  }))
  const agendaLine = lines.find((l) => /agenda/i.test(l.text))
  const agenda = agendaLine ? agendaLine.text.split(/agenda:\s*/i)[1]?.replace(/\.$/, '').split(/,\s*(?:and\s+)?|\s+and\s+/).map((s) => s.trim()).filter(Boolean) || [] : []
  const discussion = [
    ...lines.filter((l) => !DECISION.test(l.text) && !ACTION.test(l.text) && l.text.length > 40 && l !== agendaLine).slice(0, 5).map((l) => `${name(l.speakerId)}: ${l.text}`),
    ...(meeting.notes || []).map((n) => `Note (${name(n.by)}): ${n.text}`),
  ]
  const who = meeting.participantIds.map(name).join(', ')
  return {
    overview: `${minutes(meeting.startedAt, meeting.endedAt)}-minute ${meeting.video ? 'video' : 'voice'} call on ${projectName} with ${who}${who.endsWith('.') ? '' : '.'} ${decisions.length} decision${decisions.length === 1 ? '' : 's'} and ${actionItems.length} action item${actionItems.length === 1 ? '' : 's'}.`,
    agenda, discussion, decisions, actionItems,
  }
}

// ---------------------------------------------------------------------------
// Demo AI summary (prototype)
// ---------------------------------------------------------------------------
// With no AI service connected, the meeting panel still shows what AI minutes look like: each
// script line carries a written-up topic, decision or action, in English and Bahasa Indonesia,
// and the summary is assembled from the lines this call actually had. Labelled as a demo.

const DEMO = {
  1: { topic: ['Run-of-show: the draft is ready; timings for the second half still need work.', 'Run-of-show: draf sudah siap; waktu paruh kedua masih perlu dirapikan.'] },
  3: { topic: ['Venue: the load-in window is still unconfirmed, which holds up the second half.', 'Venue: jadwal load-in belum dikonfirmasi, sehingga paruh kedua tertahan.'] },
  4: { topic: ['Rigging: crew booking depends on the same load-in window.', 'Rigging: pemesanan kru bergantung pada jadwal load-in yang sama.'] },
  5: { decision: ['Lock the load-in window before booking anything else.', 'Mengunci jadwal load-in sebelum memesan hal lain.'] },
  6: { action: ['Confirm the load-in window with the venue manager, in writing', 'Konfirmasi jadwal load-in ke manajer venue secara tertulis'] },
  7: { topic: ['Catering: a final headcount is needed; RSVPs stand at about 70%.', 'Katering: perlu jumlah tamu final; RSVP sekitar 70%.'] },
  8: { decision: ['Send a reminder to every guest who has not answered yet.', 'Mengirim pengingat ke semua tamu yang belum menjawab.'] },
  9: { action: ['Send the RSVP reminder to guests who have not answered', 'Kirim pengingat RSVP ke tamu yang belum menjawab'] },
  10: { topic: ['Budget: on track overall, but the lighting quote came in 10% higher.', 'Anggaran: secara umum sesuai, tetapi penawaran lighting 10% lebih tinggi.'] },
  11: { decision: ['Keep the current lighting vendor and ask for a revised quote.', 'Tetap memakai vendor lighting saat ini dan meminta penawaran revisi.'] },
  13: { action: ['Share the previous lighting quote in the channel for comparison', 'Bagikan penawaran lighting sebelumnya di kanal untuk perbandingan'] },
  14: { topic: ['Client: a walkthrough has been requested for next week.', 'Klien: meminta walkthrough minggu depan.'] },
  15: { decision: ['Hold the client walkthrough on Tuesday afternoon.', 'Mengadakan walkthrough klien pada Selasa sore.'] },
  16: { action: ['Prepare the deck for the client walkthrough', 'Siapkan materi untuk walkthrough klien'] },
}
const lower = (s) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, '')

/**
 * AI-style minutes for a simulated call: a prose overview, topics instead of quotes, crisp
 * decisions and owned, dated action items — in English ('en') or Bahasa Indonesia ('id').
 * A transcript that did not come from the script (an older one) gets the rule-based minutes.
 */
export function demoMinutes(meeting, members, projectName = 'the project', lang = 'en') {
  const lines = meeting.transcript || []
  if (!lines.length || lines.some((l) => !Number.isInteger(l.ref))) return offlineMinutes(meeting, members, projectName)
  const L = lang === 'id' ? 1 : 0
  const name = (id) => members.find((m) => m.id === id)?.name || id
  const pick = (kind) => lines.filter((l) => DEMO[l.ref]?.[kind])
  const decisions = pick('decision').map((l) => DEMO[l.ref].decision[L])
  const actionItems = pick('action').map((l) => ({ text: DEMO[l.ref].action[L], ownerId: l.speakerId, due: dueFrom(l.text, meeting.endedAt.slice(0, 10)) }))
  const discussion = [
    ...pick('topic').map((l) => DEMO[l.ref].topic[L]),
    ...(meeting.notes || []).map((n) => `${L ? 'Dicatat selama panggilan' : 'Noted during the call'} (${name(n.by)}): ${n.text}`),
  ]
  const owners = [...new Set(actionItems.map((a) => name(a.ownerId)))]
  const len = minutes(meeting.startedAt, meeting.endedAt)
  const both = (list, and) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} ${and} ${list.at(-1)}`)
  const agreed = decisions.slice(0, 2).map(lower)
  const overview = L
    ? `Tim rapat selama ${len} menit membahas ${projectName}${discussion.length ? `, termasuk ${both(pick('topic').map((l) => DEMO[l.ref].topic[1].split(':')[0].toLowerCase()), 'dan')}` : ''}. `
      + (agreed.length ? `Disepakati untuk ${both(agreed, 'dan')}. ` : '')
      + (actionItems.length ? `${actionItems.length} tindak lanjut dibagi kepada ${both(owners, 'dan')}.` : '')
    : `The team met for ${len} minutes to review ${projectName}${discussion.length ? `, covering ${both(pick('topic').map((l) => DEMO[l.ref].topic[0].split(':')[0].toLowerCase()), 'and')}` : ''}. `
      + (agreed.length ? `They agreed to ${both(agreed, 'and')}. ` : '')
      + (actionItems.length ? `${actionItems.length} follow-up${actionItems.length === 1 ? ' was' : 's were'} assigned to ${both(owners, 'and')}.` : '')
  const agenda = L ? [`Progres ${projectName}`, 'Isu terbuka', 'Langkah berikutnya'] : [`Progress on ${projectName}`, 'Open issues', 'Next steps']
  // Names end in a full stop ("Rina M."), so a sentence ending on one must not get two.
  return { overview: overview.trim().replace(/\.\./g, '.'), agenda, discussion, decisions, actionItems }
}

/** The minutes as Markdown, for Copy MOM / Download MOM (.md). */
export function momMarkdown(meeting, members, title) {
  const name = (id) => members.find((m) => m.id === id)?.name || id
  const s = meeting.summary || {}
  const list = (items, empty = '_None._') => (items?.length ? items.map((x) => `- ${x}`).join('\n') : empty)
  return [
    `# Minutes of meeting — ${title}`,
    '',
    `**Date:** ${meeting.startedAt.slice(0, 10)} · ${meeting.startedAt.slice(11, 16)}–${meeting.endedAt.slice(11, 16)} (${minutes(meeting.startedAt, meeting.endedAt)} min)`,
    `**Attendees:** ${meeting.participantIds.map(name).join(', ')}`,
    `**Host:** ${name(meeting.hostId)}`,
    '',
    '## Summary', s.overview || '_Not generated yet._', '',
    '## Agenda', list(s.agenda), '',
    '## Discussion', list(s.discussion), '',
    '## Decisions', list(s.decisions), '',
    '## Action items',
    s.actionItems?.length ? s.actionItems.map((a) => `- [ ] ${a.text} — ${a.ownerId ? name(a.ownerId) : 'unassigned'}${a.due ? ` (due ${a.due})` : ''}`).join('\n') : '_None._',
    '',
    s.source === 'ai' ? `_Generated by AI (${s.provider} · ${s.model}) on ${s.at}._`
      : s.source === 'demo' ? '_Demo AI summary — simulated for the prototype; no AI service connected._'
        : s.source === 'offline' ? '_Rule-based summary — written without AI._' : '',
  ].join('\n')
}
