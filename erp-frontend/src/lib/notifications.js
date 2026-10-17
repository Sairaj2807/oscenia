// In-app notifications (BRD §3: "in-app notification"; §2: approvals, blockers).
//
// Worked out from the data rather than stored as a separate list, so a notification can never
// disagree with the task, message or RSVP it points at: approve the task and its "needs your
// approval" item is simply gone. Only what has been *read* is stored (useProto.notifRead).
//
// Workspace and chat items follow the "Viewing as" persona. Event and CRM items follow the ERP
// login's modules (lib/roles.js), because those screens do too.

import { approvalStage, visibleChannels, canManageChannel, channelAccess, OPEN_STATUSES } from './workspaceAccess.js'
import { mentions } from './chat.js'
import { relationshipCalendar } from './crm.js'
import { canSee, canDo } from './roles.js'

const lastOf = (task, pred) => [...task.activity].reverse().find(pred)

/**
 * Everything worth telling this persona, newest first. Each item:
 * { id, kind, at, title, body, to } — `to` is the in-app path that opens the thing itself.
 */
export function notificationsFor({
  persona, members, tasks, messages, channels, projectDivisions,
  events, guests, clients, relations, role, today,
}) {
  if (!persona) return []
  const name = (id) => members.find((m) => m.id === id)?.name || id
  const taskPath = (t) => `/workspace/${t.projectId}?task=${t.id}`
  const items = []

  for (const t of tasks) {
    // Waiting on me to approve — the one that needs action.
    if (approvalStage(persona, t, members)) {
      const sub = lastOf(t, (a) => a.text === 'submitted for approval')
      items.push({
        id: `approve:${t.id}:${sub?.at}`, kind: 'Needs your approval', at: sub?.at || t.assignedAt,
        title: t.title, body: `${t.id} · submitted by ${name(sub?.by)} · ${t.status === 'Submitted' ? 'stage 1' : 'final approval'}`,
        to: taskPath(t),
      })
    }
    if (t.assigneeId === persona.id) {
      // Assigned to me by someone else, and still open.
      const given = t.activity.find((a) => a.kind === 'assign')
      if (given && given.by !== persona.id && OPEN_STATUSES.includes(t.status)) {
        items.push({
          id: `assign:${t.id}`, kind: 'Assigned to you', at: given.at,
          title: t.title, body: `${t.id} · from ${name(given.by)} · due ${t.deadline}`, to: taskPath(t),
        })
      }
      // Sent back to me.
      const last = t.activity.at(-1)
      if (last?.kind === 'reject' && last.by !== persona.id) {
        items.push({
          id: `reject:${t.id}:${last.at}`, kind: 'Sent back', at: last.at,
          title: t.title, body: `${name(last.by)}: ${last.text.replace(/^rejected: /, '')}`, to: taskPath(t),
        })
      }
      // Signed off.
      if (t.approvals.pm) {
        items.push({
          id: `done:${t.id}`, kind: 'Approved', at: t.approvals.pm.at,
          title: t.title, body: `${t.id} · final approval by ${name(t.approvals.pm.by)}`, to: taskPath(t),
        })
      }
    }
    // Blocked, on a task I handed out (or any task, for the PM).
    if (t.status === 'Blocked' && t.assigneeId !== persona.id && (t.assignedById === persona.id || persona.workspaceRole === 'pm')) {
      const b = lastOf(t, (a) => a.kind === 'block')
      items.push({
        id: `block:${t.id}:${b?.at}`, kind: 'Blocked', at: b?.at || t.assignedAt,
        title: t.title, body: `${name(t.assigneeId)}: ${t.blockerReason}`, to: taskPath(t),
      })
    }
  }

  // @mentions in channels the persona can open.
  // Voice channels (CH3) hold no messages and never notify.
  const open = new Set(visibleChannels(persona, channels, projectDivisions).filter((c) => c.kind !== 'voice').map((c) => c.id))
  for (const m of messages) {
    if (!m.deleted && m.authorId !== persona.id && open.has(m.channelId) && mentions(m.text, persona.id)) {
      const ch = channels.find((c) => c.id === m.channelId)
      items.push({
        id: `mention:${m.id}`, kind: 'Mentioned you', at: m.at,
        // A DM has no channel name (CH2).
        title: ch?.dm ? `${name(m.authorId)} in a direct message` : `${name(m.authorId)} in #${ch?.name}`,
        body: m.text.replace(/<@(M-\d+)>/g, (_, id) => `@${name(id)}`).replace(/<#(T-\d+)>/g, '#$1'),
        to: `/chat/${m.channelId}`,
      })
    }
  }

  // Join requests (CH5): pending ones for whoever may decide them, and the answer for the
  // person who asked. Worked out from `channel.requests`, like everything here.
  const where = (c) => (c.kind === 'voice' ? c.name : `#${c.name}`)
  const home = (c) => (c.kind === 'voice' ? c.textChannelId : c.id)
  for (const c of channels) {
    if (c.dm || !c.requests?.length) continue
    const manages = canManageChannel(persona, c, projectDivisions)
    for (const r of c.requests) {
      if (manages && r.status === 'pending' && r.memberId !== persona.id && !channelAccess(c).blockedIds.includes(r.memberId)) {
        items.push({
          id: `join:${c.id}:${r.memberId}:${r.at}`, kind: 'Wants to join', at: r.at,
          title: `${name(r.memberId)} wants to join ${where(c)}`, body: r.note || 'No note',
          to: `/chat/${home(c)}?settings=${c.id}`,
        })
      }
      if (r.memberId === persona.id && r.status !== 'pending') {
        const yes = r.status === 'approved'
        items.push({
          id: `joined:${c.id}:${r.decidedAt}`, kind: yes ? 'Added to channel' : 'Request declined', at: r.decidedAt,
          title: yes ? `You were added to ${where(c)}` : `Your request to join ${where(c)} was declined`,
          body: `by ${name(r.decidedBy)}`, to: `/chat/${home(c)}`,
        })
      }
    }
  }

  // Invitations a client submitted for review (Invitations v2), for whoever may publish them.
  if (canSee(role, 'events') && canDo(role, 'publish_invitation')) {
    for (const e of events) {
      if (e.review?.state !== 'submitted') continue
      items.push({
        id: `review:${e.id}:${e.review.submittedAt}`, kind: 'Invitation to review', at: e.review.submittedAt,
        title: e.name, body: e.published ? 'The client changed the live invitation' : 'Ready to publish for the first time',
        to: `/events/${e.id}?tab=invitation`,
      })
    }
  }

  // New RSVPs on upcoming published events — the latest few, for whoever runs events.
  if (canSee(role, 'events')) {
    const upcoming = new Set(events.filter((e) => e.status === 'Published' && e.date >= today).map((e) => e.id))
    guests
      .filter((g) => upcoming.has(g.eventId) && g.respondedAt)
      .sort((a, b) => b.respondedAt.localeCompare(a.respondedAt))
      .slice(0, 6)
      .forEach((g) => {
        const ev = events.find((e) => e.id === g.eventId)
        items.push({
          id: `rsvp:${g.id}:${g.respondedAt}`, kind: g.rsvp === 'Attending' ? 'New RSVP' : 'RSVP declined', at: g.respondedAt,
          title: `${g.name}${g.rsvp === 'Attending' && g.pax > 1 ? ` (+${g.pax - 1})` : ''}`,
          body: `${ev?.name}${g.onMasterList ? '' : ' · not on the client’s list'}`,
          to: `/events/${g.eventId}?tab=guests`,
        })
      })
  }

  // CRM: nudges, birthdays and anniversaries due within a week (overdue nudges included).
  if (canSee(role, 'crm')) {
    for (const c of relationshipCalendar(clients, relations, today, 7)) {
      items.push({
        id: `crm:${c.kind}:${c.clientId}:${c.title}:${c.date}`, kind: c.kind === 'Event nudge' ? 'Time to reach out' : c.kind,
        // Due items surface as "this morning", so they sort with today's news.
        at: `${today}T08:00`,
        title: `${c.title} · ${c.client}`,
        body: c.inDays < 0 ? `${-c.inDays} days overdue` : c.inDays === 0 ? 'today' : `in ${c.inDays} days`,
        to: `/crm/${c.clientId}`,
      })
    }
  }

  return sortNotifications(items)
}

/** Things only this person can unblock come first; the rest newest first. */
export function sortNotifications(items) {
  const action = (i) => (['Needs your approval', 'Wants to join', 'Invitation to review'].includes(i.kind) ? 0 : 1)
  return [...items].sort((a, b) => action(a) - action(b) || (b.at || '').localeCompare(a.at || ''))
}

/** Unread = newer than the last "mark all read" and not opened since. */
export function isUnread(item, read) {
  return item.at > (read?.seenAt || '') && !(read?.ids || []).includes(item.id)
}
