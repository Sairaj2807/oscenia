// Team chat: message text handling and the edit/delete rules (BRD §3, v0.2).
//
// A stored message keeps mentions and task links as ids — `<@M-05>`, `<#T-102>` — so a
// renamed person or task still resolves, and a mention can notify the right person. People
// type the readable form (`@Rina M.`, `#T-102`, or a pasted task URL); `toTokens` converts on
// save and `toDisplay` converts back for editing.

/** Authors may edit or delete their own message for this long (decision 5). */
export const EDIT_WINDOW_MIN = 15

export const REACTIONS = ['👍', '🙌', '✅', '👀', '❤️']

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Readable text → stored text with id tokens. Only existing people and tasks are converted. */
export function toTokens(text, members, taskIds) {
  let out = text
  // A pasted task link (…/workspace/EVT-…?task=T-102) becomes a task token.
  out = out.replace(/https?:\/\/\S*?[?&]task=(T-\d+)\S*/g, (all, id) => (taskIds.has(id) ? `<#${id}>` : all))
  // `#T-102` typed by hand — but not one already inside a token.
  out = out.replace(/(^|[^<\w])#(T-\d+)\b/g, (all, pre, id) => (taskIds.has(id) ? `${pre}<#${id}>` : all))
  // `@Name`, longest names first so "Agus P." wins over a shorter name it starts with.
  for (const m of [...members].sort((a, b) => b.name.length - a.name.length)) {
    out = out.replace(new RegExp(`(^|[^\\w<])@${escape(m.name)}(?![\\w])`, 'g'), (all, pre) => `${pre}<@${m.id}>`)
  }
  return out
}

/** Stored text → readable text, for the edit box. */
export function toDisplay(text, members) {
  return text
    .replace(/<@(M-\d+)>/g, (all, id) => `@${members.find((m) => m.id === id)?.name || id}`)
    .replace(/<#(T-\d+)>/g, '#$1')
}

/** Stored text → segments to render: text, mention, or task. */
export function parseTokens(text) {
  const parts = []
  const re = /<([@#])((?:M|T)-\d+)>/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ type: 'text', value: text.slice(last, m.index) })
    parts.push({ type: m[1] === '@' ? 'mention' : 'task', value: m[2] })
    last = re.lastIndex
  }
  if (last < text.length) parts.push({ type: 'text', value: text.slice(last) })
  return parts
}

// ---------------------------------------------------------------------------
// Direct messages (CH2): a channel for exactly two people, one per pair.
// ---------------------------------------------------------------------------
export const dmId = (a, b) => `dm-${[a, b].sort().join('-')}`
export const dmOther = (channel, meId) => channel.memberIds.find((id) => id !== meId)
export const dmName = (channel, meId, members) => members.find((m) => m.id === dmOther(channel, meId))?.name || 'Direct message'

/** One line of a message for a quote or a preview: tokens made readable, cut to length. */
export function snippet(text, members, max = 90) {
  const s = toDisplay(text, members).replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/** "12 min", "1 h 5 min", "under a minute" — how long a call lasted. */
export function callLength(minutes) {
  const m = Math.max(0, Math.round(minutes))
  if (m < 1) return 'under a minute'
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ''}`
}

export const taskIdsIn = (text) => [...new Set([...text.matchAll(/<#(T-\d+)>/g)].map((m) => m[1]))]
export const mentions = (text, memberId) => text.includes(`<@${memberId}>`)

/** Minutes from `a` to `b`, both "YYYY-MM-DDTHH:mm". */
export function minutesBetween(a, b) {
  return (new Date(b) - new Date(a)) / 60000
}

// ---------------------------------------------------------------------------
// Discord-style layout (CH3)
// ---------------------------------------------------------------------------

/** Messages by one author this close together read as one block: avatar and name once. */
export const GROUP_WINDOW_MIN = 7

/**
 * Does `msg` start a new block after `prev`? A different author, a longer gap, a new day, a
 * call line or a quote always does.
 */
export function startsGroup(prev, msg) {
  if (!prev || prev.kind || msg.kind || msg.quoteId) return true
  if (prev.authorId !== msg.authorId || prev.at.slice(0, 10) !== msg.at.slice(0, 10)) return true
  const gap = minutesBetween(prev.at, msg.at)
  return gap < 0 || gap > GROUP_WINDOW_MIN
}

/** What the persona can set in the user panel. Offline is what others see when you're away. */
export const USER_STATUSES = ['online', 'idle', 'dnd', 'invisible']
export const STATUS_LABEL = { online: 'Online', idle: 'Idle', dnd: 'Do not disturb', invisible: 'Invisible', offline: 'Offline' }

/**
 * How `member` shows up to `viewerId`. You always see yourself as present (invisible stays
 * invisible); to everyone else, invisible reads as offline.
 */
export function presenceOf(member, presence, viewerId) {
  const s = presence?.[member.id] || 'offline'
  if (member.id === viewerId) return s === 'offline' ? 'online' : s
  return s === 'invisible' ? 'offline' : s
}

/** Voice channels hold calls, not messages: they never count as unread. */
export const isVoice = (channel) => channel?.kind === 'voice'

export function canEditMessage(member, msg, now) {
  const age = minutesBetween(msg.at, now)
  // A call log (kind: 'call') is a record, not something to reword.
  return Boolean(member && !msg.deleted && !msg.kind && msg.authorId === member.id && age >= 0 && age <= EDIT_WINDOW_MIN)
}

export function canDeleteMessage(member, msg, now) {
  if (!member || msg.deleted) return false
  return member.workspaceRole === 'pm' || canEditMessage(member, msg, now)
}
