// Invariants for the prototype modules' seed and access rules (BRD §2.2, v0.2).
//
// The seed is hand-built and the demo leans on it: a task assigned to someone who is not on
// the project, a chat link to a task that does not exist, or two identical guests would each
// surface in front of the client. And the access matrix is the feature — so its rules are
// asserted per persona here rather than trusted.
//
// Run: npm run verify:proto

import { DEMO_TODAY } from '../src/lib/format.js'
import { TEMPLATES, SECTIONS, templateById, sectionOn } from '../src/lib/templates.js'
import { blankContent, hasContent, visibleSections, fromLegacyDesign, videoEmbed, countdownTo, longDate, inviteChanges, hasUnpublishedChanges } from '../src/lib/invites.js'
import {
  seedMembers, seedProjectDivisions, seedTasks, seedChannels, seedMessages, seedEvents, seedGuests,
  seedRelations,
} from '../src/store/protoSeed.js'
import {
  memberProjectIds, visibleTasks, assignableMembers, approvalStage, visibleChannels, TASK_STATUSES,
} from '../src/lib/workspaceAccess.js'

let failures = 0
let passes = 0
const check = (ok, label, detail = '') => {
  if (ok) passes++
  else {
    failures++
    console.log(`FAIL  ${label}${detail ? `  — ${detail}` : ''}`)
  }
}

const member = (id) => seedMembers.find((m) => m.id === id)
const PD = seedProjectDivisions
const todayEnd = `${DEMO_TODAY}T23:59`

// --- tasks -----------------------------------------------------------------
for (const t of seedTasks) {
  const assignee = member(t.assigneeId)
  const assigner = member(t.assignedById)
  check(assignee && assigner, `${t.id} people exist`)
  check(TASK_STATUSES.includes(t.status), `${t.id} status is known`, t.status)
  check(PD[t.projectId]?.includes(t.division), `${t.id} division works on the project`, `${t.division} on ${t.projectId}`)
  check(memberProjectIds(assignee, PD).includes(t.projectId), `${t.id} assignee is on the project`, t.assigneeId)
  check(assignableMembers(assigner, t.projectId, seedMembers, PD).some((m) => m.id === t.assigneeId),
    `${t.id} assigner was allowed to assign this person`, `${t.assignedById} → ${t.assigneeId}`)
  check(t.status !== 'Blocked' || t.blockerReason, `${t.id} blocked task has a reason`)
  check(t.assignedAt.slice(0, 10) <= t.deadline, `${t.id} assigned before its deadline`)
  check(t.activity.every((a) => a.at <= todayEnd), `${t.id} activity is not in the future`)
  check(t.activity.every((a, i, all) => i === 0 || all[i - 1].at <= a.at), `${t.id} activity is in order`)
  check((t.status === 'PM approved') === Boolean(t.completedAt), `${t.id} completed iff PM approved`)
}
check(new Set(seedTasks.map((t) => t.id)).size === seedTasks.length, 'task ids are unique')

// --- access matrix, per persona ----------------------------------------------
const intern = member('M-09')
check(visibleTasks(intern, seedTasks, PD).every((t) => t.assigneeId === intern.id), 'intern sees only own tasks')
check(memberProjectIds(intern, PD).length === 2, 'intern can be on several projects (decision 3)')
check(assignableMembers(intern, 'EVT-2026-WED-02', seedMembers, PD).length === 0, 'intern cannot assign')

const staff = member('M-08')
check(assignableMembers(staff, 'EVT-2026-WED-02', seedMembers, PD).length > 0, 'staff can assign on own project (decision 1)')
check(assignableMembers(staff, 'EVT-2026-GALA-01', seedMembers, PD).length === 0, 'staff cannot assign on a project they are not on')
check(assignableMembers(staff, 'EVT-2026-WED-02', seedMembers, PD).every((m) => ['staff', 'intern'].includes(m.workspaceRole)),
  'staff assign to peers and interns only')

const leader = member('M-04') // Production
check(visibleTasks(leader, seedTasks, PD).every((t) => t.division === 'Production' || t.assignedById === leader.id),
  'leader sees own division or own assignments')
check(assignableMembers(leader, 'EVT-2026-CONF-03', seedMembers, PD).every((m) => m.division === 'Production'),
  'leader assigns within division')

const pm = member('M-01')
check(visibleTasks(pm, seedTasks, PD).length === seedTasks.length, 'PM sees every task')

// Two-stage approval (decision 2).
const submitted = seedTasks.find((t) => t.id === 'T-301') // Design, Submitted
check(approvalStage(member('M-03'), submitted, seedMembers) === 'leader', 'stage 1 = the division leader')
check(approvalStage(pm, submitted, seedMembers) === null, 'PM waits for stage 1')
check(approvalStage(member('M-04'), submitted, seedMembers) === null, 'another division’s leader cannot approve')
const leaderOk = seedTasks.find((t) => t.id === 'T-104') // Leader approved
check(approvalStage(pm, leaderOk, seedMembers) === 'pm', 'stage 2 = the PM')
check(approvalStage(member(submitted.assigneeId), submitted, seedMembers) === null, 'nobody approves their own task')
const leaderOwn = { ...seedTasks.find((t) => t.id === 'T-203'), status: 'Submitted' } // assignee is the Field leader
check(approvalStage(member('M-02'), leaderOwn, seedMembers) === null, 'leader cannot approve own task')
check(approvalStage(pm, leaderOwn, seedMembers) === 'pm', 'leader’s own task goes straight to the PM')

// --- chat ------------------------------------------------------------------
const channelIds = new Set(seedChannels.map((c) => c.id))
const taskIds = new Set(seedTasks.map((t) => t.id))
for (const m of seedMessages) {
  check(channelIds.has(m.channelId), `${m.id} channel exists`, m.channelId)
  check(member(m.authorId), `${m.id} author exists`)
  for (const [, id] of m.text.matchAll(/<@(M-\d+)>/g)) check(member(id), `${m.id} mention resolves`, id)
  for (const [, id] of m.text.matchAll(/<#(T-\d+)>/g)) check(taskIds.has(id), `${m.id} task link resolves`, id)
  const ch = seedChannels.find((c) => c.id === m.channelId)
  check(visibleChannels(member(m.authorId), seedChannels, PD).includes(ch), `${m.id} author can see the channel`, `${m.authorId} in ${m.channelId}`)
  // Threads were removed in round 3: the seed holds no thread reply, and a quote stays in its channel.
  check(!m.parentId, `${m.id} is not a thread reply`)
  check(!m.quoteId || seedMessages.some((p) => p.id === m.quoteId && p.channelId === m.channelId), `${m.id} quotes a message in the same channel`)
}
const internChannels = visibleChannels(member('M-10'), seedChannels, PD)
check(internChannels.every((c) => !c.projectId || c.projectId === 'EVT-2026-GALA-01'), 'intern sees only own project’s channels')
check(!internChannels.some((c) => c.id === 'ch-leaders'), 'private leaders channel is hidden from an intern')
check(visibleChannels(pm, seedChannels, PD).length === seedChannels.filter((c) => !c.dm || c.memberIds.includes(pm.id)).length,
  'PM sees every channel except other people’s direct messages')

// --- events and guests -------------------------------------------------------
for (const ev of seedEvents) {
  const guests = seedGuests.filter((g) => g.eventId === ev.id)
  check(ev.invite.templateId === null ? ev.status === 'Draft' && !ev.published : Boolean(templateById(ev.invite.templateId)), `${ev.id} invitation uses a known template (or is a draft with none yet)`)
  check(ev.status !== 'Published' || ev.published?.templateId === ev.invite.templateId, `${ev.id} is published with its template`)
  check((ev.wishes || []).every((w) => !w.guestId || guests.find((g) => g.id === w.guestId)?.name === w.name), `${ev.id} wishes name their guests`)
  check(new Set(guests.map((g) => g.email)).size === guests.length, `${ev.id} guest emails are unique`)
  check(new Set(guests.map((g) => g.phone)).size === guests.length, `${ev.id} guest phones are unique`)
  check(guests.every((g) => !g.table || ev.tables.includes(g.table)), `${ev.id} tables exist`)
  check(guests.every((g) => g.consent === Boolean(g.consentAt)), `${ev.id} consent carries a date`)
  check(guests.every((g) => !g.walkIn || (g.checkedInAt && !g.onMasterList)), `${ev.id} walk-ins are checked in and off-list`)
}

// --- invitation templates (Invitations v2) ---------------------------------------
check(TEMPLATES.length === 6 && new Set(TEMPLATES.map((t) => t.id)).size === 6, 'six templates with unique ids')
check(['corporate', 'private'].every((f) => TEMPLATES.filter((t) => t.family === f).length === 3), 'three templates per family')
for (const t of TEMPLATES) {
  check(t.sections[0] === 'cover' && new Set(t.sections).size === t.sections.length, `${t.id}: cover first, no repeats`)
  check(t.sections.every((s) => SECTIONS[s] && (SECTIONS[s].family === 'both' || SECTIONS[s].family === t.family)), `${t.id}: sections exist and suit the family`)
  check(Object.keys(SECTIONS).filter((s) => SECTIONS[s].required).every((s) => t.sections.includes(s)), `${t.id}: has cover, details and RSVP`)
  check(t.off.every((s) => t.sections.includes(s) && !SECTIONS[s].required), `${t.id}: only optional sections start off`)
  check(Object.isFrozen(t.sample.cover), `${t.id}: sample content is read-only`)
}
{
  const inv = { templateId: 'gala', on: { speakers: true, rsvp: false, couple: true }, content: blankContent({ name: 'X', date: '2026-09-01' }) }
  check(sectionOn(inv, 'speakers') && !sectionOn(inv, 'hosts'), 'sections: a toggle wins, otherwise the template default')
  check(sectionOn(inv, 'rsvp'), 'sections: a required section cannot be switched off')
  check(!sectionOn(inv, 'couple'), 'sections: a section outside the template never shows, whatever its toggle')
  check(!hasContent('gallery', inv.content) && !visibleSections(inv).includes('agenda'), 'sections: empty ones are skipped on the page')
  inv.content.agenda.rows = [{ time: '19:00', label: 'Dinner' }]
  check(visibleSections(inv).includes('agenda'), 'sections: filling one in shows it')
  const moved = { ...inv, templateId: 'royal' }
  check(!visibleSections(moved).includes('agenda') && moved.content.agenda.rows.length === 1, 'change template: a section the new one lacks is hidden, its content kept')
  const legacy = fromLegacyDesign({ name: 'Old', date: '2026-09-01', time: '19:00', venue: 'Hall' },
    { headline: 'Hello', eyebrow: 'Hi', subheadline: 'Sub', body: 'Body', schedule: [{ time: '19:00', label: 'Dinner' }], dressCode: 'Smart', mapUrl: 'https://maps.google.com/?q=x', heroImage: null }, 'gala')
  check(legacy.content.cover.title === 'Hello' && legacy.content.agenda.rows[0].label === 'Dinner' && legacy.content.dresscode.text === 'Smart' && legacy.content.details.venue === 'Hall',
    'legacy design: words, programme, dress code and venue carry over')
}
check(videoEmbed('https://www.youtube.com/watch?v=dQw4w9WgXcQ') === 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ', 'video: YouTube watch link → embed')
check(videoEmbed('https://youtu.be/dQw4w9WgXcQ').endsWith('/dQw4w9WgXcQ') && videoEmbed('https://vimeo.com/123456789') === 'https://player.vimeo.com/video/123456789', 'video: youtu.be and Vimeo links → embed')
check(videoEmbed('javascript:alert(1)') === '' && videoEmbed('https://evil.example/watch?v=dQw4w9WgXcQ') === '', 'video: other links are refused')
check(JSON.stringify(countdownTo('2026-07-27', '19:00', '2026-07-26T18:30')) === JSON.stringify({ days: 1, hours: 0, minutes: 30 }), 'countdown: days, hours, minutes')
check(countdownTo('2026-07-26', '18:00', '2026-07-26T18:30') === null, 'countdown: nothing once the event has begun')
check(longDate('2026-08-14') === 'Friday, 14 August 2026' && longDate('nope') === '', 'longDate formats, and ignores a bad date')
check(new Set(seedGuests.map((g) => g.id)).size === seedGuests.length, 'guest ids are unique')

// The past event fills every cell of the reconciliation grid (BRD §4.5).
const past = seedGuests.filter((g) => g.eventId === 'EV-02')
const cell = (rsvpYes, came) => past.filter((g) => (g.rsvp === 'Attending') === rsvpYes && Boolean(g.checkedInAt) === came).length
check(cell(true, true) === 16, 'RSVP’d and came = 16', cell(true, true))
check(cell(true, false) === 4, 'RSVP’d, no-show = 4', cell(true, false))
check(cell(false, true) === 5, 'no RSVP, came = 5 (2 on list + 3 walk-ins)', cell(false, true))
check(cell(false, false) === 6, 'no RSVP, did not come = 6 (2 declined + 4 silent)', cell(false, false))

// --- CRM relations -----------------------------------------------------------
for (const [clientId, r] of Object.entries(seedRelations)) {
  check(r.pics.length > 0, `${clientId} has a PIC`)
  check(r.pics.every((p) => /^\d{2}-\d{2}$/.test(p.birthday)), `${clientId} PIC birthdays are MM-DD`)
  check(r.cycles.every((c) => c.history.every((h) => /^\d{4}-\d{2}$/.test(h))), `${clientId} cycle history is YYYY-MM`)
}

// --- store actions: the task flow, driven as each persona --------------------
// The store re-checks every rule, so the screens are not the only thing standing between an
// intern and an approval. Run against an in-memory localStorage.
{
  const mem = new Map()
  globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const task = (id) => S().tasks.find((t) => t.id === id)

  as('M-09') // intern
  check(S().createTask({ projectId: 'EVT-2026-WED-02', title: 'x', assigneeId: 'M-09', deadline: '2026-08-01' }) === null, 'action: intern cannot create a task')
  check(S().startTask('T-205') && task('T-205').status === 'In progress', 'action: assignee starts own task')
  check(!S().blockTask('T-205', '  '), 'action: blocking needs a reason')
  check(S().submitTask('T-205') && task('T-205').status === 'Submitted', 'action: assignee submits')
  check(!S().approveTask('T-205'), 'action: intern cannot approve own task')

  as('M-04') // Production leader
  check(!S().approveTask('T-205'), 'action: another division’s leader cannot approve')
  as('M-01')
  check(!S().approveTask('T-205'), 'action: PM cannot skip stage 1')
  as('M-03') // Design leader
  check(S().approveTask('T-205') && task('T-205').status === 'Leader approved' && task('T-205').approvals.leader.by === 'M-03', 'action: stage 1 approval recorded')
  check(!S().approveTask('T-205'), 'action: stage 1 cannot be given twice')
  as('M-01')
  check(S().approveTask('T-205') && task('T-205').status === 'PM approved' && task('T-205').completedAt, 'action: stage 2 completes the task')

  as('M-03')
  check(!S().rejectTask('T-201', ''), 'action: rejecting needs a comment')
  check(S().rejectTask('T-201', 'needs the family crest') && task('T-201').status === 'In progress', 'action: rejection returns the task to In progress')
  check(task('T-201').activity.at(-1).text === 'rejected: needs the family crest' && task('T-201').activity.at(-1).by === 'M-03', 'action: rejection is on the activity trail')

  as('M-08') // staff
  const newId = S().createTask({ projectId: 'EVT-2026-WED-02', title: 'Place cards', assigneeId: 'M-09', deadline: '2026-08-03' })
  check(newId && task(newId).assignedById === 'M-08' && task(newId).division === 'Design', 'action: staff assigns an intern on own project')
  check(S().createTask({ projectId: 'EVT-2026-WED-02', title: 'x', assigneeId: 'M-03', deadline: '2026-08-03' }) === null, 'action: staff cannot assign upward')
  check(!S().toggleMemberProject('M-09', 'EVT-2026-GALA-01'), 'action: only the PM changes project membership')

  as('M-02') // Field leader, doing T-203 herself
  check(S().unblockTask('T-203') && S().submitTask('T-203'), 'action: leader works own task')
  check(!S().approveTask('T-203'), 'action: leader cannot approve own task')
  as('M-01')
  check(S().approveTask('T-203') && task('T-203').status === 'PM approved', 'action: PM approves a leader’s own task directly')

  check(S().toggleMemberProject('M-09', 'EVT-2026-GALA-01') && S().members.find((m) => m.id === 'M-09').projectIds.includes('EVT-2026-GALA-01'), 'action: PM adds an intern to a project')
  S().resetDemo()

  // W3 (client round 1): only the assignee submits, so the PM can always give the final approval.
  as('M-01')
  check(!S().submitTask('T-101') && task('T-101').status === 'In progress', 'W3: the PM cannot submit on the assignee’s behalf')
  as('M-02')
  check(!S().submitTask('T-101'), 'W3: nor can the leader who assigned it')
  as('M-05')
  check(S().submitTask('T-101'), 'W3: the assignee submits')
  as('M-02')
  check(S().approveTask('T-101'), 'W3: the leader gives stage 1')
  as('M-01')
  check(S().approveTask('T-101') && task('T-101').status === 'PM approved', 'W3: the PM gives the final approval')

  // W1 (client round 1): a leader assigns anyone in their division; assigning adds them to the project.
  const rina = () => S().members.find((m) => m.id === 'M-05')
  check(!rina().projectIds.includes('EVT-2026-WED-02'), 'W1 setup: Rina is not on the Wedding')
  as('M-02')
  const fieldOnWedding = assignableMembers(S().members.find((m) => m.id === 'M-02'), 'EVT-2026-WED-02', S().members, S().projectDivisions)
  check(['M-02', 'M-05', 'M-10'].every((id) => fieldOnWedding.some((m) => m.id === id)) && fieldOnWedding.every((m) => m.division === 'Field'),
    'W1: the Field leader can pick every Field member on the Wedding, and only Field')
  const w1 = S().createTask({ projectId: 'EVT-2026-WED-02', title: 'Usher briefing', assigneeId: 'M-05', deadline: '2026-08-05' })
  check(w1 && rina().projectIds.includes('EVT-2026-WED-02'), 'W1: assigning Rina adds the Wedding to her projects')
  check(S().createTask({ projectId: 'EVT-2026-WED-02', title: 'x', assigneeId: 'M-08', deadline: '2026-08-05' }) === null, 'W1: still no assigning outside the division')
  S().resetDemo()

  // E1 (client round 1): a client added offline (e.g. from the New event pop-up) survives a refresh.
  const { useStore } = await import('../src/store/useStore.js')
  const added = useStore.getState().addClient({ name: 'Nimbus Retail', contact: 'Ibu Sari', phone: '' })
  const saved = JSON.parse(localStorage.getItem('oscenia-demo-clients') || '[]')
  check(added?.id && saved.length === 1 && saved[0].id === added.id, 'E1: only the added client is saved, not the whole seed')
  const seedIds = useStore.getState().clients.filter((c) => c.id !== added.id).map((c) => c.id)
  check(!seedIds.includes(added.id), 'E1: a new client id never reuses an existing one')
  useStore.getState().updateClient('CL-01', { contact: 'Ibu Ratna W.' })
  const saved2 = JSON.parse(localStorage.getItem('oscenia-demo-clients') || '[]')
  check(saved2.length === 2 && saved2.some((c) => c.id === 'CL-01' && c.contact === 'Ibu Ratna W.'), 'E1: an edited seed client is saved alongside')
  S().resetDemo()
  check(localStorage.getItem('oscenia-demo-clients') === null && !useStore.getState().clients.some((c) => c.name === 'Nimbus Retail'), 'E1: Reset demo drops it again')
  check(task('T-205').status === 'To do' && S().tasks.length === seedTasks.length, 'action: reset restores the seed')
}

// --- chat: text tokens and the edit/delete rules -----------------------------
{
  const { toTokens, toDisplay, parseTokens, canEditMessage, canDeleteMessage } = await import('../src/lib/chat.js')
  const ids = new Set(seedTasks.map((t) => t.id))
  const typed = 'Hi @Agus P. and @Rina M., see #T-102 and https://oscenia.co/erp/workspace/EVT-2026-GALA-01?task=T-108 — not #T-999 or @Nobody.'
  const stored = toTokens(typed, seedMembers, ids)
  check(stored === 'Hi <@M-01> and <@M-05>, see <#T-102> and <#T-108> — not #T-999 or @Nobody.', 'chat: mentions, #ids and pasted task URLs become tokens', stored)
  check(toTokens(stored, seedMembers, ids) === stored, 'chat: converting twice changes nothing')
  check(toDisplay(stored, seedMembers) === 'Hi @Agus P. and @Rina M., see #T-102 and #T-108 — not #T-999 or @Nobody.', 'chat: tokens read back for editing')
  check(parseTokens('a <@M-01> b <#T-102>').map((p) => p.type).join() === 'text,mention,text,task', 'chat: tokens parse into segments')
  check(toTokens('mail me at rina@x.com', seedMembers, ids) === 'mail me at rina@x.com', 'chat: an email address is not a mention')

  const rina = member('M-05')
  const fresh = { authorId: 'M-05', at: '2026-07-26T10:00', deleted: false }
  check(canEditMessage(rina, fresh, '2026-07-26T10:15'), 'chat: author edits within 15 min')
  check(!canEditMessage(rina, fresh, '2026-07-26T10:16'), 'chat: not after 15 min (decision 5)')
  check(!canEditMessage(member('M-01'), fresh, '2026-07-26T10:01'), 'chat: nobody edits someone else’s message')
  check(canDeleteMessage(member('M-01'), fresh, '2026-07-26T18:00'), 'chat: PM deletes any message, any time')
  check(!canDeleteMessage(member('M-06'), fresh, '2026-07-26T10:01'), 'chat: staff cannot delete others’ messages')
}

// --- chat actions -------------------------------------------------------------
{
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  S().setPersona('M-10') // Field intern on the Gala only
  check(S().postMessage('ch-leaders', 'hello') === null, 'chat action: intern cannot post in the private leaders channel')
  check(S().postMessage('ch-devconf-general', 'hello') === null, 'chat action: intern cannot post on a project they are not on')
  const id = S().postMessage('ch-gala-general', 'Badges ready for @Rina M. — #T-106')
  const m = S().messages.find((x) => x.id === id)
  check(m && m.text === 'Badges ready for <@M-05> — <#T-106>' && m.authorId === 'M-10', 'chat action: intern posts in own project channel, with tokens')
  check(S().lastRead['M-10']['ch-gala-general'] === m.at, 'chat action: own message counts as read')
  check(S().editMessage(id, 'Badges printed') && S().messages.find((x) => x.id === id).editedAt, 'chat action: author edits a fresh message')
  // The chat no longer creates thread replies (round 3), but the store still takes one, so older saves stay valid.
  check(S().postMessage('ch-gala-general', 'reply', id) !== null, 'chat action: a legacy thread reply is still accepted')
  check(S().postMessage('ch-gala-general', 'bad reply', 'MSG-001') === null, 'chat action: a reply must be in the parent’s channel')
  check(S().toggleReaction(id, '👍') && S().messages.find((x) => x.id === id).reactions['👍'].includes('M-10'), 'chat action: react')
  check(S().toggleReaction(id, '👍') && !S().messages.find((x) => x.id === id).reactions['👍'], 'chat action: react again removes it')
  S().setPersona('M-05')
  check(S().messages.find((x) => x.id === 'MSG-006').authorId === 'M-05', 'chat action: MSG-006 is Rina’s own (test premise)')
  check(!S().editMessage('MSG-006', 'rewrite history'), 'chat action: even the author cannot edit an old message')
  check(!S().deleteMessage(id), 'chat action: staff cannot delete an intern’s message')
  S().setPersona('M-01')
  check(S().deleteMessage(id) && S().messages.find((x) => x.id === id).deleted, 'chat action: PM deletes, leaving a placeholder')
  S().markRead('ch-gala-general')
  const newest = S().messages.filter((x) => x.channelId === 'ch-gala-general').reduce((a, x) => (x.at > a ? x.at : a), '')
  check(S().lastRead['M-01']['ch-gala-general'] === newest, 'chat action: opening a channel marks it read')
  S().resetDemo()
}

// --- events: RSVP matching, QR codes, and what a guest may put on a public page -------------
{
  const { normPhone, matchGuest, qrPayload, parseQr, fillTemplate, safeLink, safeImage, rsvpOpen } = await import('../src/lib/events.js')
  check(normPhone('0812-1100 2200') === normPhone('+62 812 1100 2200'), 'events: 08… and +62 8… are the same phone')
  const g = seedGuests.find((x) => x.eventId === 'EV-01' && x.onMasterList)
  check(matchGuest(seedGuests, 'EV-01', { phone: g.phone.replace(/\s|-/g, ''), email: '' })?.id === g.id, 'events: RSVP matched to the list by phone')
  const quiet = seedGuests.find((x) => x.eventId === 'EV-01' && !x.rsvp && x.onMasterList)
  check(matchGuest(seedGuests, 'EV-01', { phone: '', email: quiet.email.toUpperCase() })?.id === quiet.id, 'events: RSVP matched by email, any case')
  const galaOnly = seedGuests.find((x) => x.eventId === 'EV-01' && !seedGuests.some((y) => y.eventId === 'EV-02' && y.phone === x.phone))
  check(galaOnly && !matchGuest(seedGuests, 'EV-02', { phone: galaOnly.phone, email: galaOnly.email }), 'events: matching stays within the event')
  const replied = seedGuests.find((x) => x.eventId === 'EV-01' && x.rsvp && x.onMasterList)
  check(!matchGuest(seedGuests, 'EV-01', { phone: '0899 0000 1111', email: replied.email }), 'events: a shared email cannot overwrite someone who already replied')
  const silent = seedGuests.find((x) => x.eventId === 'EV-01' && !x.rsvp && x.onMasterList)
  check(matchGuest(seedGuests, 'EV-01', { phone: '0899 0000 1111', email: silent.email })?.id === silent.id, 'events: email claims a listed guest who has not replied (new phone)')
  check(parseQr(qrPayload(g))?.guestId === g.id, 'events: QR payload round-trips')
  check(parseQr('https://evil.example') === null, 'events: a foreign QR is rejected')
  check(fillTemplate('Hi {name}, {event} on {date}', { guest: g, event: seedEvents[0] }) === `Hi ${g.name.split(' ')[0]}, ${seedEvents[0].name} on ${seedEvents[0].date}`, 'events: reminder template fills')
  check(safeLink('javascript:alert(1)') === '' && safeLink('https://maps.google.com/?q=x') !== '', 'events: only http(s) map links reach the public page')
  check(safeImage('data:image/jpeg;base64,/9j/AAAA') !== '' && safeImage('x");background:url(javascript:1') === '', 'events: only uploaded image data reaches the public page')
  check(rsvpOpen(seedEvents[0]) && !rsvpOpen(seedEvents[1]), 'events: Gala RSVP open, past Meridian closed')
}

// --- events actions -------------------------------------------------------------------------
{
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const listed = S().guests.find((x) => x.eventId === 'EV-01' && !x.rsvp && x.onMasterList)
  const before = S().guests.length
  const id1 = S().submitRsvp('EV-01', { name: 'Someone Else', phone: listed.phone, email: '', attending: true, answers: { 'Q-1': 'Fish' }, pax: 9, allergies: 'Peanuts', consent: true })
  const after1 = S().guests.find((x) => x.id === id1)
  check(id1 === listed.id && S().guests.length === before, 'events action: listed guest’s RSVP updates their row, no duplicate')
  check(after1.name === listed.name && after1.email === listed.email, 'events action: keeps the client’s name and the listed email when left blank')
  check(after1.rsvp === 'Attending' && after1.pax === 2 && after1.consent && after1.consentAt, 'events action: pax capped at the event maximum; consent dated')
  const id2 = S().submitRsvp('EV-01', { name: 'Forwarded Friend', phone: '0811 2222 3333', attending: false, consent: false })
  const g2 = S().guests.find((x) => x.id === id2)
  check(g2 && !g2.onMasterList && g2.rsvp === 'Declined' && g2.pax === 0 && !g2.consent, 'events action: unknown guest becomes an off-list decline, no consent')
  check(S().submitRsvp('EV-02', { name: 'Late', phone: '0811 9999 0000', attending: true }) === null, 'events action: a closed event refuses RSVPs')
  check(S().submitRsvp('EV-01', { name: '', phone: '0811 9999 0000', attending: true }) === null, 'events action: name is required')

  // Round 4: the table number is free text, trimmed and capped.
  const gt = S().guests.find((x) => x.eventId === 'EV-01').id
  const tableOf = () => S().guests.find((x) => x.id === gt).table
  S().setGuestTable(gt, '  VIP-1  ')
  check(tableOf() === 'VIP-1', 'R4 table: free text saves trimmed', tableOf())
  S().setGuestTable(gt, `Garden ${'x'.repeat(60)}`)
  check(tableOf().length === 30 && tableOf().startsWith('Garden x'), 'R4 table: capped at 30 characters', tableOf())
  S().setGuestTable(gt, '   ')
  check(tableOf() === '', 'R4 table: blank clears it')
  const { tableSuggestions, cleanTable } = await import('../src/lib/events.js')
  check(JSON.stringify(tableSuggestions({ tables: ['T1', 'T2'] }, [{ table: ' VIP-1 ' }, { table: 'T1' }, { table: '' }])) === '["T1","T2","VIP-1"]'
    && cleanTable(undefined) === '', 'R4 table: suggestions = event tables, then typed ones, no blanks or repeats')
  const csvAdded = S().addGuests('EV-01', [{ name: 'Long Table', phone: '0811 7777 1212', table: `  ${'T'.repeat(40)}` }])
  check(csvAdded === 1 && S().guests.find((x) => x.name === 'Long Table').table.length === 30, 'R4 table: a CSV/added guest’s table is capped too')

  const soon = S().createEvent({ name: 'Pop-up', date: '2026-07-29' })
  check(S().events.find((e) => e.id === soon).rsvpDeadline === '2026-07-29', 'events action: an event under a week away is not born with RSVPs closed')
  const later = S().createEvent({ name: 'Year-end', date: '2026-12-10' })
  const ev = S().events.find((e) => e.id === later)
  check(ev.rsvpDeadline === '2026-12-03' && ev.status === 'Draft' && ev.editToken.length >= 6, 'events action: new event is a draft, RSVP a week before, with an edit key')
  check(ev.invite.templateId === null && ev.published === null && ev.invite.content.details.date === '2026-12-10' && ev.invite.content.cover.title === 'Year-end', 'events action: new event starts in the gallery, unpublished, with its details')
  check(!S().publishInvite(ev.id) && S().events.find((e) => e.id === ev.id).status === 'Draft', 'events action: an event with no template cannot be published')
  S().updateEvent(ev.id, { status: 'Published' })
  check(S().events.find((e) => e.id === ev.id).status === 'Draft', 'events action: a field edit cannot publish')
  // The editor's actions (Invitations v2, phase 2), on an event of their own.
  const edId = S().createEvent({ name: 'Editor test', date: '2026-12-10' })
  const E = () => S().events.find((e) => e.id === edId)
  check(!S().chooseTemplate(edId, 'nope') && S().chooseTemplate(edId, 'royal'), 'editor: only a real template can be chosen')
  check(!S().setSection(edId, 'rsvp', false) && !S().setSection(edId, 'bogus', true) && S().setSection(edId, 'gift', false), 'editor: required and unknown sections cannot be toggled')
  check(!sectionOn(E().invite, 'gift') && sectionOn(E().invite, 'story'), 'editor: a toggle sticks, the rest follow the template')
  S().updateContent(edId, 'details', { ...E().invite.content.details, date: '2026-12-12', time: '18:00', venue: 'New Hall' })
  check(E().date === '2026-12-12' && E().venue === 'New Hall', 'editor: before the first publish, date and venue go straight onto the event')
  S().updateContent(edId, 'details', { ...E().invite.content.details, date: 'not-a-date' })
  check(E().date === '2026-12-12', 'editor: an invalid date never reaches the event')
  S().updateContent(edId, 'cover', { ...E().invite.content.cover, title: 'T'.repeat(900) })
  check(E().invite.content.cover.title.length === 300, 'editor: long text is capped')
  S().updateContent(edId, 'agenda', { rows: [{ time: '19:00', label: 'Dinner' }] })
  S().chooseTemplate(edId, 'gala')
  check(E().invite.content.agenda.rows[0].label === 'Dinner' && !sectionOn(E().invite, 'gift'), 'editor: changing template keeps content and toggles')
  check(!S().setAccent(edId, 'red') && S().setAccent(edId, '#112233') && E().invite.accent === '#112233' && S().setAccent(edId, null), 'editor: accent takes a hex colour, or null for the template’s')
  S().publishInvite(edId)
  check(E().status === 'Published' && E().published.templateId === 'gala', 'editor: with a template, publishing gives guests a copy')
  S().updateContent(edId, 'details', { ...E().invite.content.details, date: '2026-12-20', venue: 'Later Hall' })
  check(E().date === '2026-12-12' && E().invite.content.details.date === '2026-12-20', 'editor: once published, a new date waits in the draft')
  S().updateContent(edId, 'cover', { ...E().invite.content.cover, title: 'Draft title' })
  check(E().published.content.cover.title !== 'Draft title', 'editor: guests do not see draft edits')
  S().unpublish(edId)
  S().publishInvite(edId)
  check(E().published.content.cover.title === 'Draft title' && E().date === '2026-12-20' && E().venue === 'Later Hall', 'editor: publishing again sends the latest draft, with its date and venue')
  // Review and publish (Invitations v2, phase 3) on the live Gala.
  const G = () => S().events.find((e) => e.id === 'EV-01')
  check(!hasUnpublishedChanges(G()) && inviteChanges(G()).changes.length === 0, 'review: the seed Gala has no unpublished changes')
  const liveTitle = G().published.content.cover.title
  S().updateContent('EV-01', 'cover', { ...G().invite.content.cover, title: 'A Brand New Evening' })
  S().updateContent('EV-01', 'details', { ...G().invite.content.details, date: '2026-08-21' })
  check(G().date === '2026-08-14' && G().published.content.cover.title === liveTitle, 'review: a client edit to a live invitation stays in the draft')
  check(S().submitForReview('EV-01') && G().review.state === 'submitted', 'review: the client submits for review')
  check(!S().returnToClient('EV-01', '   ') && S().returnToClient('EV-01', 'Please keep the old title.') && G().review.state === 'returned' && G().review.note === 'Please keep the old title.', 'review: sending back needs a note')
  const ch = inviteChanges(G())
  check(ch.changes.includes('Cover: edited') && ch.changes.includes('Date & venue: edited'), 'review: the change list names the edited sections')
  check(ch.dateShift?.from === '2026-08-14' && ch.dateShift?.to === '2026-08-21', 'review: a date change is called out')
  check(ch.reminders.length === G().reminders.filter((r) => r.active).length && ch.reminders.every((r) => r.to > r.from), 'review: every active reminder is shown moving with the date')
  S().updateContent('EV-01', 'details', { ...G().invite.content.details, date: '2026-07-30' })
  check(inviteChanges(G()).deadlineAfterDate, 'review: an RSVP deadline after the new date is flagged')
  check(S().publishInvite('EV-01', { clampDeadline: true }) && G().date === '2026-07-30' && G().rsvpDeadline === '2026-07-30', 'review: publish moves the date and pulls the RSVP deadline back')
  check(G().published.content.cover.title === 'A Brand New Evening' && G().review.state === 'editing' && !hasUnpublishedChanges(G()), 'review: guests now see the draft; the review closes')
  {
    const { notificationsFor } = await import('../src/lib/notifications.js')
    check(!S().submitForReview('EV-03'), 'review: nothing to submit before a template is chosen')
    S().chooseTemplate('EV-03', 'royal')
    S().submitForReview('EV-03')
    const bell = (role) => notificationsFor({ persona: seedMembers[0], members: seedMembers, tasks: [], messages: [], channels: [], projectDivisions: PD, events: S().events, guests: [], clients: [], relations: [], role, today: DEMO_TODAY })
    check(bell('pm').some((n) => n.kind === 'Invitation to review' && n.to === '/events/EV-03?tab=invitation'), 'review: a submitted invitation reaches the PM’s bell')
    check(!bell('sales').some((n) => n.kind === 'Invitation to review'), 'review: sales see events but cannot publish, so get no review item')
    check(bell('pm')[0].kind === 'Invitation to review' || bell('pm')[0].kind === 'Needs your approval', 'review: review items are pinned to the top')
  }
  const oldKey = G().editToken
  check(S().regenerateEditToken('EV-01') !== oldKey && G().editToken !== oldKey, 'review: revoking the client link issues a new key')
  check(S().submitRsvp(later, { name: 'Early', phone: '0811 1234 5678', attending: true }) === null, 'events action: a draft invitation takes no RSVPs')
  S().resetDemo()
}

// --- guest experience (Invitations v2, phase 4): wishes, Add to calendar, music --------------
{
  const { useProto } = await import('../src/store/useProto.js')
  const { visibleWishes, wishState, icsFile, icsName, WISH_LIMITS, MUSIC_TRACKS } = await import('../src/lib/invites.js')
  const { trackPlan, TRACK_IDS, midiToHz } = await import('../src/lib/music.js')
  const { musicOn } = await import('../src/lib/templates.js')
  const S = () => useProto.getState()
  const G = () => S().events.find((e) => e.id === 'EV-01')
  const shown = (id) => visibleWishes(G()).some((w) => w.id === id)
  S().resetDemo()

  // Wishes (D13)
  check(visibleWishes(G()).length === 3 && !G().holdWishes, 'wishes: the seed Gala shows its three wishes, hold off')
  check(S().addWish('EV-03', { name: 'Early bird', text: 'Hello!' }) === null, 'wishes: an unpublished invitation takes no wishes')
  const w1 = S().addWish('EV-01', { name: '  Tamu  ', text: '  Selamat!  ' })
  const wish1 = G().wishes.find((w) => w.id === w1)
  check(w1 && wish1.name === 'Tamu' && wish1.text === 'Selamat!' && wish1.approved && shown(w1), 'wishes: with the hold off a wish shows at once, trimmed')
  check(wish1.at > '2026-07-24T13:40', 'wishes: stamped on the demo clock, after the seed')
  const w2 = S().addWish('EV-01', { guestId: 'G-001', name: 'Impostor', text: 'Second note from Dewi' })
  check(G().wishes.find((w) => w.id === w2)?.name === 'Dewi Wijaya', 'wishes: a personal-link guest signs with their listed name')
  const otherGuest = S().guests.find((g) => g.eventId === 'EV-02')
  check(S().addWish('EV-01', { guestId: otherGuest.id, text: 'Wrong event' }) === null, 'wishes: a guest of another event is refused')
  check(S().addWish('EV-01', { guestId: 'G-001', text: 'Second note from Dewi' }) === null, 'wishes: the same words twice are refused')
  check(S().addWish('EV-01', { guestId: 'G-001', text: 'Third note' }) && S().addWish('EV-01', { guestId: 'G-001', text: 'Fourth note' }) === null, `wishes: one guest may leave ${WISH_LIMITS.perGuest}`)
  check(S().addWish('EV-01', { name: 'TAMU', text: 'Another' }) && S().addWish('EV-01', { name: 'tamu', text: 'And another' }) && S().addWish('EV-01', { name: 'Tamu', text: 'One more' }) === null, 'wishes: off the list, the cap goes by name, any case')
  check(S().addWish('EV-01', { name: 'Blank', text: '   ' }) === null && S().addWish('EV-01', { name: '  ', text: 'No name' }) === null, 'wishes: a name and some words are needed')
  const long = S().addWish('EV-01', { name: 'Long', text: 'x'.repeat(900) })
  check(G().wishes.find((w) => w.id === long)?.text.length === WISH_LIMITS.text, 'wishes: long wishes are cut to the limit')
  S().setHoldWishes('EV-01', true)
  check(shown(w1), 'wishes: switching the hold on leaves shown wishes up')
  const held = S().addWish('EV-01', { name: 'Held', text: 'Please approve me' })
  check(held && !shown(held) && wishState(G(), G().wishes.find((w) => w.id === held)) === 'waiting', 'wishes: with the hold on a new wish waits')
  check(S().approveWish('EV-01', held) && shown(held), 'wishes: approving shows it')
  const held2 = S().addWish('EV-01', { name: 'Held two', text: 'Waiting too' })
  S().setHoldWishes('EV-01', false)
  check(shown(held2), 'wishes: switching the hold off shows the waiting ones')
  check(S().setWishHidden('EV-01', w1, true) && !shown(w1) && G().wishes.some((w) => w.id === w1) && wishState(G(), G().wishes.find((w) => w.id === w1)) === 'hidden', 'wishes: hiding takes it down but keeps it on record')
  check(S().setWishHidden('EV-01', w1, false) && shown(w1), 'wishes: a hidden wish can be shown again')
  check(!S().setWishHidden('EV-01', 'W-999', true) && !S().approveWish('EV-01', 'W-999'), 'wishes: an unknown wish is refused')
  S().setSection('EV-01', 'wishes', false)
  check(S().addWish('EV-01', { name: 'Draft only', text: 'Still open' }), 'wishes: switching the section off in the draft does not close it for guests yet')
  S().publishInvite('EV-01')
  check(S().addWish('EV-01', { name: 'After', text: 'Section is off now' }) === null, 'wishes: once the section is off for guests, no new wishes')
  S().resetDemo()
  S().unpublish('EV-01')
  check(S().addWish('EV-01', { name: 'Late', text: 'Unpublished' }) === null, 'wishes: an unpublished invitation takes no wishes')
  S().resetDemo()

  // Add to calendar
  const gala = G()
  const ics = icsFile(gala, gala.published, { link: 'https://oscenia.com/erp/invite/EV-01?g=7wdrqp', now: '2026-07-26T10:30' })
  const physical = ics.split('\r\n')
  check(ics.startsWith('BEGIN:VCALENDAR\r\n') && ics.endsWith('END:VCALENDAR\r\n') && !/[^\r]\n/.test(ics), 'ics: a calendar with CRLF line endings')
  check(physical.every((l) => new TextEncoder().encode(l).length <= 75), 'ics: no line longer than 75 octets')
  const unfolded = ics.replace(/\r\n /g, '')
  check(unfolded.includes('DTSTART;TZID=Asia/Jakarta:20260814T190000') && unfolded.includes('DTEND;TZID=Asia/Jakarta:20260814T220000'), 'ics: the Gala at 19:00 Jakarta time, three hours long')
  check(unfolded.includes('DTSTAMP:20260726T033000Z'), 'ics: stamped on the demo clock, in UTC')
  check(unfolded.includes('LOCATION:The Ritz-Carlton Jakarta\\, Mega Kuningan — Grand Ballroom'), 'ics: commas in the venue are escaped')
  check(unfolded.includes('URL:https://oscenia.com/erp/invite/EV-01?g=7wdrqp') && unfolded.includes('DESCRIPTION:Your invitation: https://oscenia.com/erp/invite/EV-01?g=7wdrqp'), 'ics: carries the guest’s own link')
  check(!icsFile(gala, gala.published, { link: 'javascript:alert(1)' }).includes('URL:'), 'ics: only an http(s) link goes in')
  const late = structuredClone(gala.published)
  late.content.details = { ...late.content.details, time: '22:30', sessions: [{ id: 'S-1', name: 'After-party', date: '2026-08-15', time: '', venue: 'Rooftop; Level 30', mapUrl: '' }, { id: 'S-2', name: 'No date', date: '', time: '10:00', venue: '' }] }
  const lateIcs = icsFile(gala, late, {}).replace(/\r\n /g, '')
  check(lateIcs.includes('DTEND;TZID=Asia/Jakarta:20260815T013000'), 'ics: an evening event ends after midnight on the next day')
  check((lateIcs.match(/BEGIN:VEVENT/g) || []).length === 2 && lateIcs.includes('DTSTART;VALUE=DATE:20260815') && lateIcs.includes('DTEND;VALUE=DATE:20260816'), 'ics: a dated session is its own entry; with no time it is all-day; undated ones are left out')
  check(lateIcs.includes('LOCATION:Rooftop\\; Level 30') && lateIcs.includes(`SUMMARY:${gala.published.content.cover.title} — After-party`), 'ics: sessions are named after the invitation, semicolons escaped')
  check(icsName('Rama & Sinta') === 'rama-sinta.ics' && icsName('') === 'invitation.ics' && icsName('Wibowo–Sari Wedding') === 'wibowosari-wedding.ics', 'ics: a safe file name')

  // Music
  check(JSON.stringify(TRACK_IDS) === JSON.stringify(MUSIC_TRACKS.map((t) => t.id)), 'music: every listed track has a sound, and no more')
  for (const id of TRACK_IDS) {
    const p = trackPlan(id)
    check(p.notes.length > 0 && p.loopBeats > 0 && p.bpm > 0, `music: ${id} has notes`)
    check(p.notes.every((n, i) => n.beat >= 0 && n.beat < p.loopBeats && n.len > 0 && n.vel > 0 && n.vel <= 1 && (i === 0 || p.notes[i - 1].beat <= n.beat)), `music: ${id} notes fit the loop, in order`)
    check(p.notes.every((n) => Number.isFinite(midiToHz(n.midi)) && midiToHz(n.midi) > 40 && midiToHz(n.midi) < 3000), `music: ${id} stays in a listenable range`)
  }
  check(JSON.stringify(trackPlan('nope')) === JSON.stringify(trackPlan(TRACK_IDS[0])), 'music: an unknown track plays the first one')
  check(Math.round(midiToHz(69)) === 440 && Math.round(midiToHz(81)) === 880, 'music: A4 is 440 Hz')
  check(musicOn(gala.published) && TRACK_IDS.includes(gala.published.content.music.trackId), 'music: the seed Gala opens to a built-in track')
}

// --- sending invitations (Invitations v2, phase 5): platform send and the client's own -------
{
  const { useProto } = await import('../src/store/useProto.js')
  const bc = await import('../src/lib/broadcasts.js')
  const { personalLink } = await import('../src/lib/events.js')
  const S = () => useProto.getState()
  const G = () => S().events.find((e) => e.id === 'EV-01')
  const guest = (id) => S().guests.find((g) => g.id === id)
  const mine = () => S().guests.filter((g) => g.eventId === 'EV-01')
  const batch = (id) => G().broadcasts.find((b) => b.id === id)
  const form = { channel: 'both', subject: 'You are invited: {event}', message: 'Hi {name}, {link}', audience: 'all' }
  S().resetDemo()

  // The seed: the Gala went out to its whole list on 20 Jul.
  const seed = G().broadcasts[0]
  const listed = mine().filter((g) => g.onMasterList)
  check(G().broadcasts.length === 1 && seed.status === 'sent' && seed.recipients.length === listed.length * 2, 'send: the seed Gala has one sent batch, a WhatsApp and an email row per listed guest')
  const noEmail = seed.recipients.filter((r) => r.status === 'failed')
  check(noEmail.length === 1 && noEmail[0].channel === 'email' && noEmail[0].reason === 'No email address' && !guest(noEmail[0].guestId).email, 'send: the seed guest with no email failed on email only')
  check(listed.every((g) => g.invitedAt && g.invitedVia === 'platform') && mine().filter((g) => !g.onMasterList).every((g) => !g.invitedAt), 'send: everyone on the list is marked invited; the forwarded-link guest is not')
  check(seed.recipients.every((r) => bc.DELIVERY_STATUSES.includes(r.status)), 'send: seed statuses are known')
  check(JSON.stringify(bc.recipientRows(listed, 'both', 'x')) === JSON.stringify(bc.recipientRows(listed, 'both', 'x')), 'send: the simulated outcome is the same every time')
  check(S().guests.filter((g) => g.eventId === 'EV-02').every((g) => g.invitedAt === null && g.invitedVia === null), 'send: guests carry invitedAt / invitedVia, empty by default')

  // Outcomes
  const fake = { token: 'abc123', phone: '+62 812-3456-7890', email: 'a@b.co' }
  check(bc.deliveryOf({ ...fake, phone: '' }, 'whatsapp').status === 'failed' && bc.deliveryOf({ ...fake, phone: '' }, 'email').status !== 'failed', 'send: no phone fails on WhatsApp only')
  check(bc.deliveryOf({ ...fake, email: 'not-an-email' }, 'email').reason === 'Email address is not valid' && bc.deliveryOf({ ...fake, email: 'not-an-email' }, 'whatsapp').status !== 'failed', 'send: a broken email fails on email only, with the reason')
  check(['read', 'delivered', 'sent'].includes(bc.deliveryOf(fake, 'whatsapp').status), 'send: with good details a message is read, delivered or sent')

  // Refusals
  check(S().sendBroadcast('EV-03', form) === null, 'send: a Draft event refuses to send')
  check(bc.broadcastProblem(S().events.find((e) => e.id === 'EV-03'), [], form).startsWith('Publish the invitation first'), 'send: the screen says why a draft cannot send')
  check(S().sendBroadcast('EV-02', form) === null, 'send: an event that is over refuses to send')
  check(S().sendBroadcast('EV-01', { ...form, message: 'Hi {name}, see you there' }) === null, 'send: a message without {link} is refused')
  check(S().sendBroadcast('EV-01', { ...form, message: `{link} ${'x'.repeat(bc.BROADCAST_LIMITS.message)}` }) === null, 'send: an over-long message is refused')
  check(S().sendBroadcast('EV-01', { ...form, subject: '  ' }) === null && S().sendBroadcast('EV-01', { ...form, subject: 'x'.repeat(bc.BROADCAST_LIMITS.subject + 1) }) === null, 'send: email needs a subject, within the limit')
  check(S().sendBroadcast('EV-01', { ...form, channel: 'fax' }) === null && S().sendBroadcast('EV-01', { ...form, audience: 'friends' }) === null, 'send: unknown channels and audiences are refused')
  check(S().sendBroadcast('EV-01', { ...form, audience: 'not_invited' }) === null, 'send: nobody left to invite means nothing to send')
  check(G().broadcasts.length === 1 && G().sendLog.length === 1, 'send: a refused batch leaves no trace')

  // Not invited yet: two new guests from the client's second file, one with no email.
  S().addGuests('EV-01', [{ name: 'Nadia Late', phone: '0812 7777 1111', email: 'nadia@late.id' }, { name: 'Omar Noemail', phone: '0812 7777 2222', email: '' }])
  const fresh = mine().filter((g) => !g.invitedAt && g.onMasterList)
  check(fresh.length === 2 && JSON.stringify(bc.broadcastAudience(mine(), 'not_invited').map((g) => g.id)) === JSON.stringify(fresh.map((g) => g.id)), '"not invited yet" is exactly the guests not invited before')
  const before = Object.fromEntries(listed.map((g) => [g.id, guest(g.id).invitedAt]))
  const b2 = S().sendBroadcast('EV-01', { ...form, audience: 'not_invited', by: 'Agus P.' })
  check(b2 && batch(b2).status === 'sent' && batch(b2).recipients.length === 4 && batch(b2).by === 'Agus P.', 'send: the batch goes to those two, on both channels')
  check(listed.every((g) => guest(g.id).invitedAt === before[g.id]), '"not invited yet" leaves the already-invited alone')
  const omar = fresh.find((g) => g.name === 'Omar Noemail')
  const omarRows = batch(b2).recipients.filter((r) => r.guestId === omar.id)
  check(omarRows.find((r) => r.channel === 'email').status === 'failed' && omarRows.find((r) => r.channel === 'whatsapp').status !== 'failed', 'send: a guest with no email fails on email only')
  check(fresh.every((g) => guest(g.id).invitedVia === 'platform' && guest(g.id).invitedAt > '2026-07-24'), 'send: both are now invited by the platform, on the demo clock')
  const log = G().sendLog.at(-1)
  check(log.label === 'Invitation' && log.channel === 'both' && log.audience === 'not invited yet' && log.count === 2, 'send: the send log records the batch, like a reminder', JSON.stringify(log))

  // Retry
  check(S().retryFailed('EV-01', b2) === 0 && batch(b2).recipients.find((r) => r.guestId === omar.id && r.channel === 'email').status === 'failed', 'retry: nothing fixed, the row stays failed')
  check(!S().setGuestEmail(omar.id, 'omar at home') && S().setGuestEmail(omar.id, ' omar@home.id ') && guest(omar.id).email === 'omar@home.id', 'retry: an email can be added, if it looks like one')
  const logs = G().sendLog.length
  check(S().retryFailed('EV-01', b2) === 1 && batch(b2).recipients.find((r) => r.guestId === omar.id && r.channel === 'email').status !== 'failed', 'retry: once the email is added, the retry gets through')
  check(G().sendLog.length === logs + 1 && G().sendLog.at(-1).label === 'Invitation (retry)' && G().sendLog.at(-1).count === 1, 'retry: logged as a retry')
  check(S().retryFailed('EV-01', 'BC-99') === 0 && S().retryFailed('EV-01', 'BC-1') === 0, 'retry: an unknown batch, or one whose failures are not fixed, sends nothing')

  // By category
  const vip = mine().filter((g) => g.onMasterList && g.category === 'VIP')
  const b3 = S().sendBroadcast('EV-01', { ...form, channel: 'whatsapp', subject: '', audience: 'VIP' })
  check(b3 && vip.length > 0 && batch(b3).recipients.length === vip.length && batch(b3).recipients.every((r) => r.channel === 'whatsapp' && guest(r.guestId).category === 'VIP'), 'send: by category, WhatsApp only — one row per VIP')
  check(batch(b3).subject === '', 'send: a WhatsApp-only batch keeps no subject')

  // Scheduled
  check(S().sendBroadcast('EV-01', { ...form, scheduledAt: '2026-07-01T09:00' }) === null, 'schedule: a time in the past is refused')
  check(S().sendBroadcast('EV-01', { ...form, scheduledAt: '2026-08-20T09:00' }) === null, 'schedule: after the event is refused')
  check(S().sendBroadcast('EV-01', { ...form, scheduledAt: '27 Jul' }) === null, 'schedule: it needs a date and time')
  const logs2 = G().sendLog.length
  const s1 = S().sendBroadcast('EV-01', { ...form, audience: 'not_invited', scheduledAt: '2026-07-27T09:00' })
  check(s1 && batch(s1).status === 'scheduled' && batch(s1).recipients.length === 0 && G().sendLog.length === logs2, 'schedule: saved as Scheduled, nothing sent, nothing logged — even for a group empty today')
  check(S().sendScheduledNow('EV-01', s1) === 0 && batch(s1).status === 'scheduled', 'schedule: Send now with nobody in the group sends nothing and keeps it')
  S().addGuests('EV-01', [{ name: 'Putri Scheduled', phone: '0812 7777 3333', email: 'putri@x.id' }])
  check(S().sendScheduledNow('EV-01', s1) === 1 && batch(s1).status === 'sent' && batch(s1).recipients.length === 2 && G().sendLog.length === logs2 + 1, 'schedule: Send now sends it to the group as it is now')
  check(!S().cancelBroadcast('EV-01', s1), 'schedule: a sent batch cannot be cancelled')
  const s2 = S().sendBroadcast('EV-01', { ...form, scheduledAt: '2026-07-30T18:00' })
  check(S().cancelBroadcast('EV-01', s2) && batch(s2).status === 'cancelled' && S().sendScheduledNow('EV-01', s2) === 0, 'schedule: Cancel calls it off for good')

  // The client sends their own (D9a)
  const g = mine().find((x) => x.onMasterList && x.rsvp === null)
  check(S().markSentByClient('EV-01', g.id) && guest(g.id).invitedVia === 'client' && guest(g.id).invitedAt, 'client: a guest is marked "sent by client"')
  check(!S().markSentByClient('EV-01', S().guests.find((x) => x.eventId === 'EV-02').id) && !S().markSentByClient('EV-03', g.id), 'client: only a guest of this event, and only once it is published')
  const link = 'https://oscenia.com/erp/invite/EV-01'
  const other = mine().find((x) => x.id !== g.id)
  const text = bc.inviteMessage(bc.DEFAULT_INVITE_MESSAGE, G(), g, personalLink(link, g))
  const wa = bc.waLink(g.phone, text)
  const decoded = decodeURIComponent(wa.split('?text=')[1])
  check(wa.startsWith(`https://wa.me/${g.phone.replace(/\D/g, '')}?text=`), 'client: the WhatsApp link opens a chat with the guest’s number, digits only')
  check(decoded.includes(`${link}?g=${g.token}`) && !decoded.includes(`?g=${other.token}`), 'client: the wa.me text carries the guest’s own personal link')
  check(decoded.includes(g.name.split(' ')[0]) && decoded.includes('Friday, 14 August 2026'), 'client: the message names the guest and writes the date out')
  check(bc.waLink('0812-345', 'x').startsWith('https://wa.me/62812345?'), 'client: a local 0… number becomes 62…')
  S().resetDemo()
}

// --- step 5: guest list, reminders, check-in, walk-ins, report --------------------------------
{
  const { parseGuestCsv, reminderAudience, reminderDate, reconcile } = await import('../src/lib/events.js')
  const rows = parseGuestCsv('Phone,Name,Table\r\n0811 1111 2222,"Wijaya, Budi",VIP 1\n\n0811 3333 4444,Sari Dewi,\nno-phone-row,,')
  check(rows.length === 2 && rows[0].name === 'Wijaya, Budi' && rows[0].phone === '0811 1111 2222' && rows[0].table === 'VIP 1', 'csv: header in any order, quoted comma kept')
  const bare = parseGuestCsv('Budi,0811 5555 6666,budi@x.com,T2')
  check(bare.length === 1 && bare[0].email === 'budi@x.com' && bare[0].table === 'T2', 'csv: no header means name, phone, email, table')

  const ev1 = seedGuests.filter((g) => g.eventId === 'EV-01')
  check(reminderAudience({ audience: 'attending' }, ev1).length === 19, 'reminders: attending audience = 19 (18 listed + 1 forwarded)')
  check(reminderAudience({ audience: 'pending' }, ev1).length === 8, 'reminders: not-replied audience = the 8 listed guests yet to reply')
  check(reminderDate(seedEvents[0], 7) === '2026-08-07', 'reminders: D-7 of 14 Aug is 7 Aug')

  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const n = S().addGuests('EV-01', [...rows, { name: 'Dupe', phone: ev1[0].phone }, { name: 'Short', phone: '123' }])
  check(n === 2, 'import: adds new phones, skips one already listed and one invalid', n)
  check(S().addGuests('EV-01', rows) === 0, 'import: the same file twice adds nobody')

  const sent = S().sendReminderNow('EV-01', 'R-2')
  const log = S().events.find((e) => e.id === 'EV-01').sendLog
  check(sent === 19 && log.at(-1).count === 19 && log.at(-1).label === 'D-7 reminder', 'reminders: simulated send logs its audience count')
  S().addReminder('EV-01')
  const rule = S().events.find((e) => e.id === 'EV-01').reminders.at(-1)
  S().updateReminder('EV-01', rule.id, { daysBefore: 2, audience: 'pending' })
  check(S().events.find((e) => e.id === 'EV-01').reminders.at(-1).daysBefore === 2, 'reminders: staff configure any D-n rule (decision 8)')

  const guest = S().guests.find((g) => g.eventId === 'EV-01' && g.rsvp === 'Attending')
  check(S().checkIn(guest.id) && S().guests.find((g) => g.id === guest.id).checkedInAt, 'check-in: marks arrival with a time')
  check(!S().checkIn(guest.id), 'check-in: a second scan does not overwrite the first arrival time')
  check(S().undoCheckIn(guest.id) && !S().guests.find((g) => g.id === guest.id).checkedInAt, 'check-in: a mistaken check-in can be undone')

  const silent = S().guests.find((g) => g.eventId === 'EV-01' && g.onMasterList && !g.rsvp)
  const before = S().guests.length
  const r1 = S().registerWalkIn('EV-01', { name: 'Typed Differently', phone: silent.phone, consent: false })
  check(r1 && !r1.walkIn && r1.id === silent.id && S().guests.length === before, 'walk-in: someone on the list is checked in, not duplicated')
  const consented = S().guests.find((g) => g.eventId === 'EV-01' && g.consent && g.rsvp === 'Attending')
  S().registerWalkIn('EV-01', { name: consented.name, phone: consented.phone, consent: false })
  check(S().guests.find((g) => g.id === consented.id).consent, 'walk-in: an unticked box never withdraws earlier consent')
  const r2 = S().registerWalkIn('EV-01', { name: 'New Face', phone: '0819 8888 7777', consent: true })
  const w = S().guests.find((g) => g.id === r2.id)
  check(r2.walkIn && w.walkIn && !w.onMasterList && w.checkedInAt && w.consent && w.consentAt, 'walk-in: newcomer is checked in as a walk-in with consent recorded')
  check(!S().undoCheckIn(w.id), 'walk-in: a walk-in’s check-in cannot be undone (it is their record)')
  check(S().registerWalkIn('EV-01', { name: 'x', phone: '12' }) === null, 'walk-in: a phone number is required')

  const grid = reconcile(S().guests.filter((g) => g.eventId === 'EV-01'))
  check(grid.noRsvpCame.some((g) => g.id === silent.id) && grid.noRsvpCame.some((g) => g.id === w.id), 'report: listed no-reply guest and walk-in land in "came without an RSVP"')
  S().resetDemo()
}

// --- step 6: CRM contacts and the relationship calendar -----------------------------------------
{
  const { guestContacts, nextNudge, relationshipCalendar, usualMonth, nextOccurrence } = await import('../src/lib/crm.js')
  const { seedClients } = await import('../src/store/seed.js')
  const contacts = guestContacts(seedGuests, seedEvents)
  check(contacts.length === 40 && contacts.filter((c) => c.events.length === 2).length === 22, 'crm: 62 guest records pool into 40 contacts; 22 came to both events')
  const couple = guestContacts([
    { eventId: 'EV-01', name: 'Ana', phone: '0811 0000 0001', email: 'home@x.com', consent: false },
    { eventId: 'EV-01', name: 'Budi', phone: '0811 0000 0002', email: 'home@x.com', consent: false },
  ], seedEvents)
  check(couple.length === 2, 'crm: two people sharing one inbox stay two contacts')
  const kept = guestContacts([
    { eventId: 'EV-02', name: 'Sari', phone: '0811 0000 0003', consent: true, consentAt: '2026-06-18T09:00', respondedAt: '2026-06-18T09:00' },
    { eventId: 'EV-01', name: 'Sari', phone: '+62 811 0000 0003', consent: false, respondedAt: '2026-07-22T10:00' },
  ], seedEvents)
  check(kept.length === 1 && kept[0].consent, 'crm: an unticked box at a later event does not withdraw consent')
  check(guestContacts([{ eventId: 'EV-01', name: 'Nobody', phone: '', email: '' }], seedEvents).length === 0, 'crm: a record with no phone or email is not a contact')

  check(usualMonth(['2024-11', '2025-11', '2023-06']) === 11, 'crm: usual month is the most frequent')
  const townHall = nextNudge({ history: ['2024-11', '2025-11'] }, 3, '2026-07-26')
  check(townHall.edition === '2026-11' && townHall.nudgeOn === '2026-08-01', 'crm: gathers every November → nudge 1 Aug (3 months ahead)')
  check(nextNudge({ history: ['2024-08', '2025-08', '2026-08'] }, 3, '2026-07-26').edition === '2027-08', 'crm: an edition already booked this year moves the nudge to next year')
  check(nextOccurrence('07-20', '2026-07-26') === '2027-07-20', 'crm: a birthday already past this year comes round next year')

  const cal = relationshipCalendar(seedClients, seedRelations, '2026-07-26', 90)
  const has = (kind, title) => cal.find((i) => i.kind === kind && i.title.startsWith(title))
  check(has('Birthday', 'Ibu Ratna')?.inDays === 2, 'calendar: Ibu Ratna’s birthday in 2 days')
  check(has('Event nudge', 'Year-end Town Hall')?.inDays === 6, 'calendar: Aurora Town Hall nudge in 6 days')
  check(has('Event nudge', 'Product Launch 2026')?.inDays < 0, 'calendar: TechNusa Product Launch nudge is overdue')
  check(cal[0].inDays < 0, 'calendar: overdue items come first')
  check(!has('Company anniversary', ''), 'calendar: no anniversary falls in the next 90 days (Nov/Mar/May)')
  check(relationshipCalendar([...seedClients, { id: 'CL-09', name: 'New Co' }], { ...seedRelations, 'CL-09': { anniversary: null } }, '2026-07-26').length === cal.length,
    'calendar: a new client with a half-filled record does not break it')

  const { useProto } = await import('../src/store/useProto.js')
  const { useStore } = await import('../src/store/useStore.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const nudge = relationshipCalendar(seedClients, S().relations, '2026-07-26').find((i) => i.kind === 'Event nudge')
  const before = (useStore.getState().interactions[nudge.clientId] || []).length
  S().handleNudge(nudge.clientId, nudge.key, 'Asked about the next edition')
  check(!relationshipCalendar(seedClients, S().relations, '2026-07-26').some((i) => i.key === nudge.key), 'calendar: a handled nudge leaves the calendar')
  check((useStore.getState().interactions[nudge.clientId] || []).length === before + 1, 'calendar: the outreach lands in the client’s interaction history')
  check(!S().savePic('CL-01', { name: 'Bad date', birthday: '28-07' }), 'crm: a PIC birthday must be MM-DD')
  check(S().savePic('CL-01', { name: 'Pak Budi', birthday: '09-01', channel: 'email' }) && S().relations['CL-01'].pics.some((p) => p.name === 'Pak Budi'), 'crm: add a PIC')
  S().updateRelation('CL-09', { nudgeLeadMonths: 2 })
  check(Array.isArray(S().relations['CL-09'].pics) && Array.isArray(S().relations['CL-09'].cycles), 'crm: editing a client with no record creates a complete one')
  // A campaign is built from ticked keys; the store rebuilds the audience itself (C1).
  const pool = guestContacts(S().guests, S().events)
  const mixed = [...pool.filter((c) => c.consent).slice(0, 2), pool.find((c) => !c.consent)].map((c) => c.key)
  check(S().createCampaign({ name: 'Test', channel: 'email', keys: mixed }).count === 2, 'crm: a campaign counts only consented contacts, whatever it is given')
  S().sendGreeting({ clientId: 'CL-01', kind: 'Birthday', to: 'Ibu Ratna', channel: 'both' })
  check(S().greetingLog.at(-1).to === 'Ibu Ratna', 'crm: greeting recorded in the log')
  S().resetDemo()
}

// --- regressions from the independent review ---------------------------------------------------
{
  const { matchGuest, reminderDate, parseGuestCsv, isIsoDate } = await import('../src/lib/events.js')
  const { nextNudge, nextOccurrence, isMonthDay } = await import('../src/lib/crm.js')
  const { canEditMessage } = await import('../src/lib/chat.js')
  const { approvalStage } = await import('../src/lib/workspaceAccess.js')

  const home = [
    { id: 'A', eventId: 'E', name: 'Anna', phone: '0811 5555 0001', email: 'home@x.com', rsvp: null },
    { id: 'B', eventId: 'E', name: 'Ben', phone: '0811 5555 0002', email: 'home@x.com', rsvp: null },
  ]
  check(!matchGuest(home, 'E', { phone: '0899 1', email: 'home@x.com' }), 'review: an email two unreplied guests share claims neither')
  check(reminderDate({ date: '' }, 7) === '' && !isIsoDate('2026-02-30'), 'review: a missing or impossible event date does not crash reminders')
  check(nextNudge({ history: ['2024-08', '2025-08', '2026-09'] }, 3, '2026-07-26').edition === '2027-08', 'review: an edition moved to another month still counts as this year’s')
  check(!isMonthDay('04-31') && !isMonthDay('02-30') && isMonthDay('02-29'), 'review: only real birthdays are accepted')
  check(nextOccurrence('02-29', '2026-07-26') === '2027-02-28', 'review: 29 Feb falls on 28 Feb in a non-leap year')
  check(parseGuestCsv('Name;Phone\nBudi;0811 2222 3333').length === 1, 'review: semicolon CSVs import')
  check(!canEditMessage({ id: 'M-05' }, { authorId: 'M-05', at: '2026-07-26T18:00', deleted: false }, '2026-07-26T10:00'), 'review: a message stamped after "now" is not editable')
  // Superseded by W3: a task stuck in a saved demo (someone else submitted it) is approvable again.
  const t = { id: 'T', assigneeId: 'M-05', division: 'Field', status: 'Submitted', activity: [{ text: 'submitted for approval', by: 'M-02' }] }
  check(approvalStage(member('M-02'), t, seedMembers) === 'leader', 'review: an old on-behalf submission no longer blocks the leader')

  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const g = S().guests.find((x) => x.eventId === 'EV-01' && x.consent && x.rsvp === 'Attending')
  S().submitRsvp('EV-01', { name: g.name, phone: g.phone, attending: false, consent: false })
  const after = S().guests.find((x) => x.id === g.id)
  check(after.rsvp === 'Declined' && after.consent && after.consentAt === g.consentAt, 'review: changing a reply keeps the consent given before')

  const date = S().events.find((e) => e.id === 'EV-01').date
  S().updateEvent('EV-01', { date: '', venue: 'Elsewhere' })
  const ev = S().events.find((e) => e.id === 'EV-01')
  check(ev.date === date && ev.venue === 'Elsewhere', 'review: a cleared date is ignored, other edits still apply')

  const clock = S().clock
  check(clock >= '2026-07-26T17:00', 'review: the demo clock starts after everything in the seed', clock)
  useProto.setState({ clock: '2026-07-26T23:30' })
  S().setPersona('M-05')
  const mid = S().postMessage('ch-gala-general', 'late one')
  check(S().messages.find((m) => m.id === mid).at > '2026-07-26T23:30', 'review: new stamps never go back in time')
  check(S().editMessage(mid, 'late one, edited'), 'review: the author can still edit a just-posted message')

  const saved = JSON.parse(localStorage.getItem('oscenia.proto'))
  check(!('personaId' in saved.state), 'review: the persona is per tab, not saved for every tab')

  const nudgeKey = 'Year-end Town Hall:2026-11'
  S().handleNudge('CL-01', nudgeKey, 'Called Pak Surya')
  check(S().relations['CL-01'].outreach.some((o) => o.key === nudgeKey && o.note === 'Called Pak Surya'), 'review: logged outreach is kept in saved data')

  const real = globalThis.localStorage.setItem
  globalThis.localStorage.setItem = () => { throw new Error('QuotaExceededError') }
  let id = null
  let threw = false
  try { id = S().submitRsvp('EV-01', { name: 'Full Storage', phone: '0819 1111 2222', attending: true, answers: { 'Q-1': 'Fish' } }) } catch { threw = true }
  globalThis.localStorage.setItem = real
  check(!threw && id, 'review: a full browser storage does not abort an RSVP mid-way')
  S().resetDemo()
}

// --- notifications -----------------------------------------------------------------------------
{
  const { notificationsFor, isUnread } = await import('../src/lib/notifications.js')
  const { seedClients } = await import('../src/store/seed.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const bell = (personaId, role = 'ceo') => notificationsFor({
    persona: S().members.find((m) => m.id === personaId), members: S().members, tasks: S().tasks, messages: S().messages,
    channels: S().channels, projectDivisions: S().projectDivisions, events: S().events, guests: S().guests,
    clients: seedClients, relations: S().relations, role, today: '2026-07-26',
  })
  const kinds = (list, kind) => list.filter((n) => n.kind === kind)

  const maya = bell('M-03')
  check(kinds(maya, 'Needs your approval').map((n) => n.title).sort().join('|') === ['Keynote stage design concept', 'Moodboard revision 2 (warmer palette)'].sort().join('|'), 'bell: Design leader is asked to approve the two submitted Design tasks')
  check(kinds(maya, 'Mentioned you').length === 1, 'bell: Maya sees Kevin’s @mention')
  check(kinds(bell('M-01'), 'Blocked').length === 4, 'bell: the PM hears about every blocked task (4)')
  check(kinds(bell('M-09'), 'Assigned to you').length === 3, 'bell: Kevin has 3 open tasks assigned to him')
  check(kinds(bell('M-09'), 'Needs your approval').length === 0, 'bell: an intern is never asked to approve')

  check(kinds(bell('M-01', 'ceo'), 'New RSVP').length > 0 && kinds(bell('M-01', 'warehouse'), 'New RSVP').length === 0, 'bell: RSVPs go to logins that run events, not to warehouse')
  const crm = bell('M-01', 'ceo').filter((n) => n.id.startsWith('crm:'))
  check(crm.length === 5 && crm.some((n) => n.kind === 'Time to reach out' && n.body.includes('overdue')), 'bell: CRM items due within a week, overdue nudge included (5)')
  check(bell('M-01', 'finance').filter((n) => n.id.startsWith('crm:')).length === 5 && bell('M-01', 'pm').filter((n) => n.id.startsWith('crm:')).length === 0, 'bell: CRM items follow who can open the CRM')

  S().setPersona('M-01')
  S().postMessage('ch-leaders', 'Private note about @Nadia R.')
  check(!kinds(bell('M-10'), 'Mentioned you').some((n) => n.body.includes('Private note')), 'bell: a mention in a channel you cannot open never reaches you')
  check(kinds(bell('M-10'), 'Mentioned you').some((n) => n.title.includes('#general')), 'bell: …while her visible #general mention does')
  S().setPersona('M-10')
  S().postMessage('ch-gala-general', 'Badges ready @Rina M.')
  const rina = bell('M-05')
  const ping = rina.find((n) => n.kind === 'Mentioned you' && n.body.includes('Badges ready'))
  check(ping && isUnread(ping, S().notifRead['M-05']), 'bell: a new @mention arrives unread')

  S().setPersona('M-03')
  S().approveTask('T-201')
  check(!bell('M-03').some((n) => n.kind === 'Needs your approval' && n.title.startsWith('Moodboard')), 'bell: approving a task clears its approval notification')
  check(bell('M-01').some((n) => n.kind === 'Needs your approval' && n.title.startsWith('Moodboard')), 'bell: …and it moves to the PM for the final approval')

  S().setPersona('M-05')
  S().markNotificationRead(ping.id)
  check(!isUnread(ping, S().notifRead['M-05']), 'bell: opening a notification marks it read')
  S().markAllNotificationsRead()
  check(bell('M-05').every((n) => !isUnread(n, S().notifRead['M-05'])), 'bell: mark all read clears the badge')
  check(bell('M-03').some((n) => isUnread(n, S().notifRead['M-03'])), 'bell: read state is per person')
  S().resetDemo()
}

// --- client round 1, batch B: RSVP & events (R1–R6) ------------------------------------------
{
  const ev = await import('../src/lib/events.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const G = (id) => S().guests.find((g) => g.id === id)
  S().resetDemo()

  // R2 — guest category
  const gala = () => S().guests.filter((g) => g.eventId === 'EV-01')
  check(gala().filter((g) => g.category === 'VIP').every((g) => g.table.startsWith('VIP')) && gala().some((g) => g.category === 'Media'), 'R2: seed has VIP (VIP tables) and Media guests')
  check(ev.guestCategory({}) === 'Regular' && ev.guestCategory({ category: 'nonsense' }) === 'Regular', 'R2: no or unknown category reads as Regular')
  const csv = ev.parseGuestCsv('name,phone,category\nAyu,0811 7000 1000,vip\nBima,0811 7000 2000,Press')
  check(csv[0].category === 'VIP' && csv[1].category === 'Regular', 'R2: CSV category is matched case-insensitively; unknown becomes Regular')
  S().addGuests('EV-01', csv)
  check(S().guests.find((g) => g.name === 'Ayu').category === 'VIP', 'R2: imported guests keep their category')
  const reg = gala().find((g) => g.category === 'Regular')
  check(S().setGuestCategory(reg.id, 'Media') && G(reg.id).category === 'Media' && !S().setGuestCategory(reg.id, 'Boss'), 'R2: staff change a category; only the four are accepted')

  // R6 — more than 10 per invitation
  S().updateEvent('EV-01', { maxPax: 99 })
  check(S().events.find((e) => e.id === 'EV-01').maxPax === ev.MAX_PAX_LIMIT, 'R6: the per-invitation cap stops at the limit (50)')
  S().updateEvent('EV-01', { maxPax: 20 })
  const big = S().submitRsvp('EV-01', { name: 'Keluarga Besar', phone: '0812 9999 0001', attending: true, answers: { 'Q-1': 'Fish' }, pax: 12 })
  check(G(big).pax === 12, 'R6: a party of 12 is accepted when the event allows 20')
  S().submitRsvp('EV-01', { name: 'Keluarga Besar', phone: '0812 9999 0001', attending: true, answers: { 'Q-1': 'Fish' }, pax: 40 })
  check(G(big).pax === 20, 'R6: a reply above the event cap is clamped to it')

  // R3 — personal links
  check(new Set(S().guests.map((g) => g.token)).size === S().guests.length && S().guests.every((g) => g.token), 'R3: every guest, seeded or new, has a unique personal-link token')
  check(G(big).token && S().guests.find((g) => g.name === 'Ayu').token, 'R3: new guests (RSVP, import) get a token')
  const listed = gala().find((g) => g.onMasterList && !g.rsvp)
  const viaLink = S().submitRsvp('EV-01', { token: listed.token, name: 'Typed Name', phone: '0899 0000 0001', attending: true, answers: { 'Q-1': 'Fish' }, pax: 1 })
  check(viaLink === listed.id && G(listed.id).rsvp === 'Attending', 'R3: a reply through a personal link lands on that guest, even with a different phone')
  check(ev.personalLink('https://x/invite/EV-01', listed) === `https://x/invite/EV-01?g=${listed.token}`, 'R3: personal link = event link + ?g=token')

  // R5 — internal notes
  const noShow = S().guests.find((g) => g.eventId === 'EV-02' && g.rsvp === 'Attending' && !g.checkedInAt && !g.note)
  check(S().setGuestNote(noShow.id, '  Called — stuck in traffic  ', 'R. Hartono') && G(noShow.id).note === 'Called — stuck in traffic' && G(noShow.id).noteBy === 'R. Hartono' && G(noShow.id).noteAt, 'R5: a note is saved, trimmed, with who and when')
  check(!S().setGuestNote(noShow.id, 'Called — stuck in traffic', 'X'), 'R5: saving the same text again changes nothing')
  check(S().setGuestNote(noShow.id, '', 'X') && !G(noShow.id).note && !G(noShow.id).noteBy, 'R5: clearing the text removes the note')
  check(S().guests.filter((g) => g.eventId === 'EV-02' && g.note).every((g) => g.rsvp === 'Attending' && !g.checkedInAt), 'R5: seeded notes sit on RSVP-yes no-shows')

  // R4 — post-event follow-ups
  check(ev.reminderDate({ date: '2026-06-30' }, 1, 'after') === '2026-07-01' && ev.reminderDate({ date: '2026-06-30' }, 3) === '2026-06-27', 'R4: D+1 is the day after, D-3 three days before')
  check(ev.ruleLabel({ when: 'after', daysBefore: 1 }) === 'D+1' && ev.ruleLabel({ daysBefore: 7 }) === 'D-7', 'R4: rules read D+n / D-n (old rules default to before)')
  const mer = S().guests.filter((g) => g.eventId === 'EV-02')
  check(ev.reminderAudience({ audience: 'attended' }, mer).length === mer.filter((g) => g.checkedInAt).length
    && ev.reminderAudience({ audience: 'noshow' }, mer).length === 4, 'R4: after-event audiences = who came / RSVP-yes no-shows (4)')
  const meridian = S().events.find((e) => e.id === 'EV-02')
  check(ev.fillTemplate('Tell us: {feedback}', { event: meridian }) === `Tell us: ${meridian.feedbackUrl}`, 'R4: {feedback} fills from the event’s feedback link')
  check(ev.fillTemplate('{feedback}', { event: { ...meridian, feedbackUrl: 'javascript:alert(1)' } }) === '', 'R4: an unsafe feedback link is dropped')
  S().addReminder('EV-02', 'after')
  const fu = S().events.find((e) => e.id === 'EV-02').reminders.at(-1)
  check(fu.when === 'after' && fu.audience === 'attended' && fu.template.includes('{feedback}'), 'R4: "Add follow-up" makes a D+1 thank-you to attendees')
  const came = mer.filter((g) => g.checkedInAt).length
  check(S().sendReminderNow('EV-02', fu.id) === came && S().events.find((e) => e.id === 'EV-02').sendLog.at(-1).label === 'D+1 follow-up', 'R4: sending a follow-up logs it as D+1 follow-up')
  S().addReminder('EV-01', 'after')
  const early = S().events.find((e) => e.id === 'EV-01').reminders.at(-1)
  check(S().sendReminderNow('EV-01', early.id) === 0, 'R4: a follow-up cannot go out before the event')
  S().updateReminder('EV-01', early.id, { when: 'before' })
  check(S().events.find((e) => e.id === 'EV-01').reminders.at(-1).audience === 'attending', 'R4: switching a rule to before moves its audience to one that fits')

  // R1 — checkpoints and the scan log
  const scansOf = (id) => S().scans.filter((x) => x.guestId === id)
  check(mer.filter((g) => g.checkedInAt).every((g) => scansOf(g.id).some((x) => x.checkpointId === 'CP-1' && x.at === g.checkedInAt)), 'R1: seeded arrivals each have their entrance scan')
  const vipLounge = S().events.find((e) => e.id === 'EV-01').checkpoints.find((c) => c.name === 'VIP Lounge')
  const regular = gala().find((g) => g.rsvp === 'Attending' && g.category === 'Regular' && !g.checkedInAt)
  const vip = gala().find((g) => g.rsvp === 'Attending' && g.category === 'VIP' && !g.checkedInAt)
  check(!ev.checkpointAdmits(vipLounge, regular) && ev.checkpointAdmits(vipLounge, vip) && ev.checkpointAdmits({ categories: [] }, regular), 'R1: a VIP-only checkpoint admits VIPs; an open one admits all')
  const s1 = S().scanGuest(regular.id, vipLounge.id)
  check(s1 && G(regular.id).checkedInAt === S().scans.find((x) => x.id === s1).at, 'R1: the first scan anywhere is the arrival (and is logged even when not admitted)')
  const arrivedAt = G(regular.id).checkedInAt
  S().scanGuest(regular.id, 'CP-3'); S().scanGuest(regular.id, 'CP-3')
  check(scansOf(regular.id).filter((x) => x.checkpointId === 'CP-3').length === 2 && G(regular.id).checkedInAt === arrivedAt, 'R1: repeat scans are logged; the arrival time stays')
  check(S().scanGuest(regular.id, 'CP-99') === null, 'R1: an unknown checkpoint is refused')
  check(S().undoCheckIn(regular.id) && scansOf(regular.id).length === 2 && G(regular.id).checkedInAt, 'R1: undo removes only the latest scan')
  S().undoCheckIn(regular.id); S().undoCheckIn(regular.id)
  check(scansOf(regular.id).length === 0 && !G(regular.id).checkedInAt, 'R1: undoing the last scan un-arrives the guest')
  check(!S().removeCheckpoint('EV-02', 'CP-2'), 'R1: a checkpoint with scans cannot be removed')
  check(S().addCheckpoint('EV-01', 'Photo Booth') && !S().addCheckpoint('EV-01', 'photo booth'), 'R1: add a checkpoint; names are unique')
  const booth = S().events.find((e) => e.id === 'EV-01').checkpoints.at(-1)
  S().updateCheckpoint('EV-01', booth.id, { name: 'Photo Wall', categories: ['Media', 'Nope'] })
  const booth2 = S().events.find((e) => e.id === 'EV-01').checkpoints.at(-1)
  check(booth2.name === 'Photo Wall' && booth2.categories.join() === 'Media', 'R1: rename a checkpoint and restrict it to real categories')
  check(S().removeCheckpoint('EV-01', booth.id), 'R1: an unused checkpoint can be removed')
  const one = S().createEvent({ name: 'One Door', date: '2026-09-01' })
  check(!S().removeCheckpoint(one, 'CP-1'), 'R1: an event keeps at least one checkpoint')
  const wi = S().registerWalkIn('EV-01', { name: 'Door Walker', phone: '0819 1234 5678' })
  check(scansOf(wi.id).length === 1 && scansOf(wi.id)[0].checkpointId === 'CP-1', 'R1: a walk-in is logged at the entrance')
  check(S().checkIn(vip.id) && scansOf(vip.id)[0].checkpointId === 'CP-1', 'R1: plain check-in scans at the first checkpoint')
  S().resetDemo()
}

// --- client round 1, batch C: custom RSVP questions (R7) --------------------------------------
{
  const ev = await import('../src/lib/events.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const G = (id) => S().guests.find((g) => g.id === id)
  const E = (id) => S().events.find((e) => e.id === id)
  S().resetDemo()

  const qs = [
    { id: 'Q-1', label: 'Meal', type: 'dropdown', options: ['Beef', 'Fish'], required: true, attendingOnly: true },
    { id: 'Q-2', label: 'Topics', type: 'choice', options: ['A', 'B', 'C'], multi: true, required: false, attendingOnly: true },
    { id: 'Q-3', label: 'Heard of us', type: 'text', options: [], required: false, attendingOnly: false },
    { id: 'Q-4', label: 'Not ready', type: 'choice', options: ['Only one'], required: true, attendingOnly: false },
    { id: 'Q-5', label: '  ', type: 'text', options: [], required: true, attendingOnly: false },
  ]
  const e = { customFields: qs }
  check(ev.questionsFor(e, true).map((q) => q.id).join() === 'Q-1,Q-2,Q-3', 'R7: guests who accept see ready questions only (not a one-option or blank one)')
  check(ev.questionsFor(e, false).map((q) => q.id).join() === 'Q-3', 'R7: a decline sees only the ask-everyone questions')
  const c1 = ev.cleanAnswers(e, true, { 'Q-1': 'Pork', 'Q-2': ['A', 'Z', 'A', 'C'], 'Q-3': `  ${'x'.repeat(600)}  `, 'Q-9': 'stray' })
  check(c1.missing.join() === 'Meal' && !('Q-1' in c1.answers), 'R7: an option that does not exist is dropped, and a required question is reported missing')
  check(c1.answers['Q-2'].join() === 'A,C' && c1.answers['Q-3'].length === ev.MAX_ANSWER_LENGTH && !('Q-9' in c1.answers), 'R7: multi answers are de-duplicated; text is capped; unknown ids are dropped')
  const c2 = ev.cleanAnswers({ customFields: [{ ...qs[1], multi: false }] }, true, { 'Q-2': ['B', 'C'] })
  check(c2.answers['Q-2'] === 'B', 'R7: a single-answer choice keeps one value')
  check(ev.answerText(['A', 'C']) === 'A; C' && ev.answerText(undefined) === '', 'R7: answers read as text for tables and CSV')
  const counts = ev.answerCounts(qs[0], [
    { rsvp: 'Attending', answers: { 'Q-1': 'Beef' } }, { rsvp: 'Attending', answers: { 'Q-1': 'Beef' } },
    { rsvp: 'Attending', answers: {} }, { rsvp: 'Declined', answers: { 'Q-1': 'Fish' } },
  ])
  check(counts.counts.Beef === 2 && counts.counts.Fish === 0 && counts.none === 1, 'R7: answer counts cover guests attending only, with "no answer"')
  check(ev.answerCounts({ id: 'Q', options: ['x'] }, [{ rsvp: 'Attending', answers: { Q: 'constructor' } }]).none === 1, 'R7: counts ignore an answer that is not an option (even a prototype name)')

  // Seed and submitRsvp
  const gala = E('EV-01')
  check(gala.customFields.length === 3 && S().guests.filter((g) => g.eventId === 'EV-01' && g.rsvp === 'Attending').every((g) => g.answers['Q-1']), 'R7: the Gala asks 3 questions; every seeded yes has a meal')
  check(S().submitRsvp('EV-01', { name: 'No Meal', phone: '0813 1000 2000', attending: true }) === null, 'R7: a reply without a required answer is refused')
  const id = S().submitRsvp('EV-01', { name: 'Has Meal', phone: '0813 1000 2000', attending: true, answers: { 'Q-1': 'Fish', 'Q-2': 'Yes', 'Q-3': 'Tulus' } })
  check(G(id).answers['Q-1'] === 'Fish' && G(id).answers['Q-3'] === 'Tulus', 'R7: answers are saved with the reply')
  S().submitRsvp('EV-01', { name: 'Has Meal', phone: '0813 1000 2000', attending: true, answers: { 'Q-1': 'Beef' } })
  check(G(id).answers['Q-1'] === 'Beef' && !('Q-3' in G(id).answers), 'R7: a changed reply replaces the answers')
  S().submitRsvp('EV-01', { name: 'Has Meal', phone: '0813 1000 2000', attending: false })
  check(Object.keys(G(id).answers).length === 0, 'R7: declining clears answers to accept-only questions')

  // Builder actions
  const q1 = S().addQuestion('EV-02', 'dropdown')
  check(q1 === 'Q-2' && E('EV-02').customFields.at(-1).options.length === 2, 'R7: a new dropdown starts with two placeholder options')
  S().updateQuestion('EV-02', q1, { label: 'Parking?', options: ['  Yes ', 'Yes', '', 'No'], multi: true })
  const got = E('EV-02').customFields.find((q) => q.id === q1)
  check(got.options.join() === 'Yes,No' && got.multi === false, 'R7: options are trimmed, de-duplicated, never blank; "several answers" is for choices only')
  S().updateQuestion('EV-02', q1, { type: 'text' })
  check(E('EV-02').customFields.find((q) => q.id === q1).options.length === 0, 'R7: a text question has no options')
  check(S().addQuestion('EV-02', 'toString') === null && S().addQuestion('EV-02', 'nope') === null, 'R7: only the three question types can be added')
  check(S().moveQuestion('EV-02', q1, -1) && E('EV-02').customFields[0].id === q1 && !S().moveQuestion('EV-02', q1, -1), 'R7: questions move up and down within the list')
  const meridianGuest = S().guests.find((g) => g.eventId === 'EV-02' && g.answers?.['Q-1'])
  check(S().removeQuestion('EV-02', 'Q-1') && meridianGuest && G(meridianGuest.id).answers['Q-1'], 'R7: removing a question keeps the guests’ old answers in their record')
  const q3 = S().addQuestion('EV-02', 'text')
  check(q3 !== 'Q-1' && q3 === 'Q-3', 'R7: question ids are never reused, so old answers cannot reappear under a new question')
  for (let i = 0; i < 12; i++) S().addQuestion('EV-02', 'text')
  check(E('EV-02').customFields.length === ev.MAX_QUESTIONS, 'R7: at most 10 questions per event')
  S().resetDemo()
}

// --- client round 1, batch D: CRM (C1 ticked campaigns, C2 Google Calendar) ------------------
{
  const crm = await import('../src/lib/crm.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()

  // C1
  const pool = crm.guestContacts(S().guests, S().events)
  const yes = pool.filter((c) => c.consent)
  const no = pool.filter((c) => !c.consent)
  const ticked = [yes[0].key, yes[1].key, no[0].key]
  const aud = crm.campaignAudience(pool, new Set(ticked))
  check(aud.recipients.length === 2 && aud.skipped.length === 1 && aud.skipped[0].key === no[0].key, 'C1: ticked contacts split into recipients (consented) and skipped')
  check(crm.campaignAudience(pool, ticked).recipients.length === 2, 'C1: the audience accepts an array of keys too')
  const c1 = S().createCampaign({ name: 'Year-end offer', channel: 'email', keys: ticked })
  check(c1 && c1.count === 2 && c1.skipped === 1 && c1.keys.length === 2 && !c1.keys.includes(no[0].key), 'C1: a campaign goes only to the ticked contacts who consented, and counts the skipped')
  check(S().createCampaign({ name: 'Nobody', channel: 'email', keys: [no[0].key, no[1].key] }) === null, 'C1: a campaign with no consented contact ticked is refused')
  check(S().createCampaign({ name: 'Nobody', channel: 'email', keys: ['not-a-contact'] }) === null, 'C1: unknown keys reach nobody')
  check(S().createCampaign({ name: '  ', channel: 'email', keys: ticked }) === null, 'C1: a campaign needs a name')
  const c2 = S().createCampaign({ name: 'Second', channel: 'both', keys: [yes[2].key] })
  check(c2.id !== c1.id && S().campaigns.length === 2, 'C1: campaign ids are unique')

  // C2
  check(crm.isEmail('rina@oscenia.co.id') && !crm.isEmail('rina@') && !crm.isEmail('no at sign'), 'C2: the simulated sign-in needs an email address')
  check(!S().connectGoogle('nope') && !S().googleCalendar.connected, 'C2: a bad account does not connect')
  S().setGoogleOption({ addCrmDates: true })
  check(!S().googleCalendar.addCrmDates, 'C2: "add CRM dates" needs a connection first')
  check(S().connectGoogle(' sales@oscenia.co.id ') && S().googleCalendar.connected && S().googleCalendar.account === 'sales@oscenia.co.id' && S().googleCalendar.connectedAt, 'C2: connecting records the account and when')
  S().setGoogleOption({ addCrmDates: true, showGoogle: false })
  check(S().googleCalendar.addCrmDates && !S().googleCalendar.showGoogle, 'C2: options change once connected')
  S().disconnectGoogle()
  check(!S().googleCalendar.connected && !S().googleCalendar.account && !S().googleCalendar.addCrmDates, 'C2: disconnecting clears the account and the sync option')
  // Round 3: the Google Calendar page under CRM & Clients is for exactly the roles that see the CRM.
  {
    const { ROLES, canSee } = await import('../src/lib/roles.js')
    check(Object.keys(ROLES).every((r) => canSee(r, 'gcal') === canSee(r, 'crm')), 'R3 Google Calendar: the page is seen by exactly the CRM roles')
    check(['ceo', 'finance', 'sales'].every((r) => canSee(r, 'gcal')) && !canSee('pm', 'gcal') && !canSee('warehouse', 'gcal'), 'R3 Google Calendar: CEO, finance and sales; not PM or warehouse')
  }
  check(S().googleEvents.length >= 10 && S().googleEvents.every((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date)), 'C2: the simulated Google calendar has dated events')

  const jul = crm.calendarMonth(2026, 7, [{ date: '2026-07-28', t: 'x' }, { date: '2026-08-01', t: 'next month' }])
  const cells = jul.flat()
  check(cells[0].date === '2026-06-29' && !cells[0].inMonth && cells[2].date === '2026-07-01' && cells[2].inMonth, 'C2: July 2026 starts on a Wednesday, after two days of June (Monday first)')
  check(jul.every((w) => w.length === 7) && cells.filter((c) => c.inMonth).length === 31, 'C2: whole weeks, 31 days in July')
  check(cells.find((c) => c.date === '2026-07-28').items.length === 1 && cells.filter((c) => c.items.length).length === 1, 'C2: items land on their day; days outside the month carry none')
  check(crm.calendarMonth(2026, 2, []).flat().filter((c) => c.inMonth).length === 28 && crm.calendarMonth(2028, 2, []).flat().filter((c) => c.inMonth).length === 29, 'C2: February has 28 days, 29 in a leap year')
  const aug2027 = crm.relationshipCalendar((await import('../src/store/seed.js')).seedClients, S().relations, '2027-08-01', 31)
  check(aug2027.some((i) => i.kind === 'Birthday' && i.date.startsWith('2027-08')), 'C2: a month a year ahead still shows its birthdays')
  S().resetDemo()
}

// --- client round 1, batch E: chat (CH1 quoted replies, CH2 DMs + calls) ----------------------
{
  const chat = await import('../src/lib/chat.js')
  const { visibleChannels } = await import('../src/lib/workspaceAccess.js')
  const { notificationsFor } = await import('../src/lib/notifications.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const M = (id) => S().messages.find((m) => m.id === id)
  S().resetDemo()

  // CH1 — quoted replies
  as('M-05')
  const original = S().messages.find((m) => m.channelId === 'ch-gala-general' && !m.parentId && !m.kind)
  const q = S().postMessage('ch-gala-general', 'Agreed, on it.', null, original.id)
  check(q && M(q).quoteId === original.id && !M(q).parentId, 'CH1: a reply in the main chat can quote a message')
  const other = S().messages.find((m) => m.channelId === 'ch-gala-field')
  check(S().postMessage('ch-gala-general', 'x', null, other.id) === null, 'CH1: a quote must come from the same channel')
  check(S().messages.some((m) => m.quoteId && m.channelId === 'ch-gala-field'), 'CH1: the seed shows a quoted reply')
  // Round 3: one Reply, posting in the main chat with a quote; no threads.
  {
    const kevin = S().messages.find((m) => m.channelId === 'ch-devconf-design' && m.authorId === 'M-09' && !m.kind)
    const former = S().messages.find((m) => m.channelId === 'ch-devconf-design' && m.text.startsWith('Yes — take until 30 Jul'))
    check(former && former.quoteId === kevin.id && !former.parentId, 'R3 chat: the former seeded thread reply is a quoted reply to Kevin’s question')
    check(S().messages.every((m) => !m.parentId), 'R3 chat: no seeded message is a thread reply')
    as('M-01')
    const before = S().messages.filter((m) => m.channelId === 'ch-devconf-design')
    const r = S().postMessage('ch-devconf-design', 'Noted — thanks.', null, kevin.id)
    const inCh = S().messages.filter((m) => m.channelId === 'ch-devconf-design').sort((a, b) => a.at.localeCompare(b.at))
    check(r && !M(r).parentId && M(r).quoteId === kevin.id && inCh.length === before.length + 1 && inCh.at(-1).id === r, 'R3 chat: a reply posts top-level, at the bottom of the stream, quoting the original')
    const { readFileSync } = await import('node:fs')
    const chatSrc = readFileSync(new URL('../src/pages/Chat.jsx', import.meta.url), 'utf8')
    const composerSrc = readFileSync(new URL('../src/components/chat/Composer.jsx', import.meta.url), 'utf8')
    check(!/ThreadPanel|Reply in thread|setThreadOf/.test(chatSrc) && (chatSrc.match(/label="Reply"/g) || []).length === 1, 'R3 chat: the toolbar has one Reply and no thread panel')
    check(chatSrc.includes('m.quoteId || m.parentId'), 'R3 chat: an older saved thread reply shows as a quote of its parent')
    check(composerSrc.includes('postMessage(channelId, text, null, ') && /postMessage\(current\.id, [^\n]*, null, taskFrom\.id\)/.test(chatSrc), 'R3 chat: the UI never creates a thread reply (composer, create-task trail)')
  }
  check(chat.snippet('Hi <@M-05>, see <#T-101>  now', S().members) === 'Hi @Rina M., see #T-101 now' && chat.snippet('x'.repeat(200), S().members).length === 90, 'CH1: quote snippets read as text and are cut to one line')

  // Direct messages
  check(chat.dmId('M-05', 'M-01') === 'dm-M-01-M-05' && chat.dmId('M-01', 'M-05') === chat.dmId('M-05', 'M-01'), 'CH2: one DM id per pair, whichever way round')
  as('M-06')
  const dm = S().openDm('M-07')
  check(dm === 'dm-M-06-M-07' && S().openDm('M-07') === dm && S().channels.filter((c) => c.id === dm).length === 1, 'CH2: opening a DM twice gives the same conversation')
  check(S().openDm('M-06') === null && S().openDm('M-99') === null, 'CH2: no DM with yourself or with nobody')
  check(S().postMessage(dm, 'Hi <@M-07> — rigging check at 3?') , 'CH2: a member posts in their DM')
  const pmSees = visibleChannels(S().members.find((m) => m.id === 'M-01'), S().channels, S().projectDivisions).some((c) => c.id === dm)
  check(!pmSees, 'CH2: the PM cannot see other people’s DMs')
  as('M-01')
  check(S().postMessage(dm, 'peek') === null, 'CH2: the PM cannot post in them either')
  const dmMsg = S().messages.find((m) => m.channelId === dm)
  check(!S().deleteMessage(dmMsg.id) && !M(dmMsg.id).deleted, 'CH2: nor delete a message in them')
  check(!S().toggleReaction(dmMsg.id, '👍'), 'CH2: nor react to one')
  check(chat.dmName(S().channels.find((c) => c.id === dm), 'M-06', S().members) === S().members.find((m) => m.id === 'M-07').name, 'CH2: a DM is named after the other person')
  const bellFor = (id) => notificationsFor({
    persona: S().members.find((m) => m.id === id), members: S().members, tasks: S().tasks, messages: S().messages, channels: S().channels,
    projectDivisions: S().projectDivisions, events: [], guests: [], clients: [], relations: {}, role: 'ceo', today: '2026-07-26',
  })
  check(bellFor('M-07').some((n) => n.title === `${S().members.find((m) => m.id === 'M-06').name} in a direct message`), 'CH2: a mention in a DM notifies the other person, named as a direct message')
  check(!bellFor('M-01').some((n) => n.to === `/chat/${dm}`), 'CH2: the PM is never notified about someone else’s DM')
  as('M-02')
  check(visibleChannels(S().members.find((m) => m.id === 'M-02'), S().channels, S().projectDivisions).some((c) => c.id === 'dm-M-02-M-05'), 'CH2: the seeded DM is visible to its members')

  // Calls
  as('M-05')
  check(!S().startCall('ch-leaders', true), 'CH2: no call in a channel you cannot see')
  check(S().startCall('ch-gala-general', true) && S().activeCall.hostId === 'M-05', 'CH2: start a video call in your channel')
  check(!S().startCall('ch-gala-field', false), 'CH2: one call at a time')
  check(S().joinCall('M-02') && !S().joinCall('M-02'), 'CH2: a teammate joins once')
  check(!S().joinCall('M-09'), 'CH2: someone who cannot see the channel cannot join')
  check(S().toggleShare() && S().activeCall.sharingId === 'M-05' && S().toggleShare() && S().activeCall.sharingId === null, 'CH2: share and stop sharing the screen')
  as('M-02')
  check(S().leaveCall() && S().activeCall && !S().activeCall.participantIds.includes('M-02'), 'CH2: a guest leaving keeps the call going')
  as('M-05')
  const before = S().messages.length
  check(S().leaveCall() && S().activeCall === null, 'CH2: the host leaving ends the call')
  const log = S().messages.at(-1)
  check(S().messages.length === before + 1 && log.kind === 'call' && log.channelId === 'ch-gala-general' && /^Video call · .+ · Rina M\., Dinda A\.$/.test(log.text), 'CH2: the call is logged in the channel with its length and who was on it', log.text)
  check(!chat.canEditMessage(S().members.find((m) => m.id === 'M-05'), log, log.at), 'CH2: a call log cannot be edited')
  check(chat.callLength(0.2) === 'under a minute' && chat.callLength(12) === '12 min' && chat.callLength(65) === '1 h 5 min' && chat.callLength(120) === '2 h', 'CH2: call lengths read naturally')
  as('M-06')
  check(S().startCall(dm, false) && S().joinCall('M-07') && !S().joinCall('M-01'), 'CH2: a one-to-one call in a DM; the PM cannot join it')
  S().leaveCall()
  S().resetDemo()
}

// --- client round 1, batch F: task attachments (W2) -------------------------------------------
{
  const att = await import('../src/lib/attachments.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const T = (id) => S().tasks.find((t) => t.id === id)
  S().resetDemo()

  const PDF = 'application/pdf'
  check(att.checkFile({ name: 'brief.pdf', type: PDF, size: 1000 }) === null && att.checkFile({ name: 'Photo.JPG', type: 'image/jpeg', size: 5 }) === null, 'W2: PDF and JPG (any case) are accepted')
  check(att.checkFile({ name: 'notes.docx', type: '', size: 10 }) === null, 'W2: a browser that reports no type is judged by the extension')
  check(/Only PDF/.test(att.checkFile({ name: 'setup.exe', type: 'application/x-msdownload', size: 10 })) && /Only PDF/.test(att.checkFile({ name: 'old.doc', type: 'application/msword', size: 10 })), 'W2: other types (.exe, old .doc) are refused')
  check(/not really/.test(att.checkFile({ name: 'invoice.pdf', type: 'application/x-msdownload', size: 10 })), 'W2: a program renamed to .pdf is refused')
  check(/limit is 10\.0 MB/.test(att.checkFile({ name: 'big.pdf', type: PDF, size: 11 * 1024 * 1024 })) && /empty/.test(att.checkFile({ name: 'e.pdf', type: PDF, size: 0 })), 'W2: over 10 MB, or empty, is refused')
  check(att.humanSize(512) === '512 B' && att.humanSize(184_320) === '180 KB' && att.humanSize(2_516_582) === '2.4 MB', 'W2: sizes read naturally')

  as('M-05') // Rina, assignee of T-101
  check(T('T-101').attachments.length === 1 && T('T-309').attachments.length === 1, 'W2: the seed has files on two tasks')
  const r1 = S().addAttachment('T-101', { name: 'timings.pdf', type: PDF, size: 2000, data: 'data:application/pdf;base64,AAAA' })
  check(r1.id === 'A-2' && T('T-101').attachments.at(-1).data && T('T-101').activity.at(-1).text === 'attached timings.pdf', 'W2: attaching keeps a small file whole and logs it')
  const r2 = S().addAttachment('T-101', { name: 'plan.pdf', type: PDF, size: att.KEEP_WHOLE_BYTES + 1, data: 'data:application/pdf;base64,AAAA' })
  check(r2.id && !T('T-101').attachments.at(-1).data, 'W2: a file over the keep-whole size keeps its details only')
  check(S().addAttachment('T-101', { name: 'x.exe', type: 'application/x-msdownload', size: 5 }).error, 'W2: the store refuses a disallowed file too')
  as('M-09') // an intern who cannot see T-101
  check(/cannot open/.test(S().addAttachment('T-101', { name: 'a.pdf', type: PDF, size: 5 }).error), 'W2: someone who cannot see the task cannot attach')
  as('M-01') // PM
  const pmFile = S().addAttachment('T-101', { name: 'pm-notes.pdf', type: PDF, size: 5 })
  as('M-05')
  check(!S().removeAttachment('T-101', pmFile.id), 'W2: staff cannot remove the PM’s file')
  check(S().removeAttachment('T-101', r1.id) && !T('T-101').attachments.some((a) => a.id === r1.id), 'W2: the uploader removes their own file')
  as('M-01')
  check(S().removeAttachment('T-101', 'A-1') && T('T-101').activity.at(-1).text === 'removed run-of-show-v3-draft.docx', 'W2: the PM can remove anyone’s file; the removal is logged')
  const done = S().tasks.find((t) => t.status === 'PM approved')
  check(/done/.test(S().addAttachment(done.id, { name: 'late.pdf', type: PDF, size: 5 }).error), 'W2: a done task takes no more files')
  for (let i = 0; i < 12; i++) S().addAttachment('T-102', { name: `f${i}.pdf`, type: PDF, size: 5 })
  check(T('T-102').attachments.length === att.MAX_PER_TASK, 'W2: at most 10 files per task')
  // The storage budget: once the demo holds 1.5 MB of files, new ones keep details only.
  const big = 'x'.repeat(200_000)
  for (let i = 0; i < 9; i++) S().addAttachment('T-104', { name: `p${i}.png`, type: 'image/png', size: 300_000, preview: `data:image/jpeg;base64,${big}` })
  check(att.keptBytes(S().tasks) <= att.STORE_BUDGET && T('T-104').attachments.some((a) => !a.preview), 'W2: the prototype never keeps more than its storage budget')
  S().resetDemo()
}

// --- client round 1, batch G: PO pipeline board (V1) ------------------------------------------
{
  const v = await import('../src/lib/vendors.js')
  const { seedPurchaseOrders } = await import('../src/store/seed.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()

  const po = (status) => ({ id: 'PO-X', status })
  check(v.pipelineStage(po('Draft')) === null && v.pipelineStage(po('Cancelled'), 'Delivered') === null, 'V1: drafts and cancelled orders are off the board')
  check(v.pipelineStage(po('Approved')) === 'PO Issued' && v.pipelineStage(po('DP Paid')) === 'DP Paid', 'V1: an approved order is "PO Issued"; a paid DP is "DP Paid"')
  check(['Approved', 'DP Paid'].every((s) => v.pipelineStage(po(s), 'In progress') === 'In Progress' && v.pipelineStage(po(s), 'Delivered') === 'Delivered / Completed'), 'V1: delivery progress moves a live order along, paid or not')
  check(v.DELIVERY_STATUSES.every((d) => v.pipelineStage(po('Settled'), d) === 'Fully Paid'), 'V1: a settled order is Fully Paid whatever its delivery')
  check(v.pipelineStage(po('Approved'), 'nonsense') === 'PO Issued', 'V1: an unknown delivery status counts as not started')

  // Round 3: the board card's five-step strip.
  const withDp = (status) => ({ id: 'PO-X', status, lines: [{ qty: 1, unitPrice: 1000 }], terms: { dpPercent: 50 } })
  const noDp = (status) => ({ ...withDp(status), terms: { dpPercent: 0 } })
  const states = (p, d) => v.pipelineSteps(p, d).map((s) => s.state).join(',')
  const currentOf = (p, d) => v.pipelineSteps(p, d).find((s) => s.current)?.stage
  check(v.pipelineSteps(withDp('Draft')).length === 0 && v.pipelineSteps(withDp('Cancelled')).length === 0, 'R3 PO strip: no strip for an order off the board')
  check(v.pipelineSteps(withDp('Approved')).map((s) => s.stage).join() === v.PIPELINE.join(), 'R3 PO strip: five steps, in board order')
  for (const [status, delivery] of [['Approved', 'Not started'], ['DP Paid', 'Not started'], ['Approved', 'In progress'], ['DP Paid', 'Delivered'], ['Settled', 'Not started']]) {
    check(currentOf(withDp(status), delivery) === v.pipelineStage(withDp(status), delivery), `R3 PO strip: the current step is the board column (${status}, ${delivery})`)
  }
  check(states(withDp('Approved')) === 'done,todo,todo,todo,todo', 'R3 PO strip: a new order has only PO Issued done')
  check(states(withDp('DP Paid'), 'In progress') === 'done,done,done,todo,todo', 'R3 PO strip: DP paid and in progress')
  check(states(withDp('Approved'), 'Delivered') === 'done,todo,done,done,todo', 'R3 PO strip: delivered with the DP still unpaid shows the gap')
  check(states(withDp('Settled')) === 'done,done,done,done,done', 'R3 PO strip: a settled order reads complete')
  check(states(noDp('Approved')) === 'done,skipped,todo,todo,todo' && states(noDp('Settled')) === 'done,skipped,done,done,done', 'R3 PO strip: an order with no DP shows DP Paid as skipped')

  const byId = (id) => seedPurchaseOrders.find((p) => p.id === id)
  check(S().poDelivery['PO-3003'].status === 'In progress' && v.pipelineStage(byId('PO-3003'), S().poDelivery['PO-3003'].status) === 'In Progress', 'V1: the seeded PO-3003 is in progress on the board')
  check(S().setPoDelivery(byId('PO-3004'), 'Delivered', 'Hendra T.') && S().poDelivery['PO-3004'].by === 'Hendra T.' && S().poDelivery['PO-3004'].at, 'V1: delivery is recorded with who and when')
  check(!S().setPoDelivery(byId('PO-3004'), 'Shipped', 'x'), 'V1: only the three delivery statuses are accepted')
  check(!S().setPoDelivery({ id: 'PO-9', status: 'Draft' }, 'In progress', 'x') && !S().setPoDelivery({ id: 'PO-9', status: 'Cancelled' }, 'Delivered', 'x') && !S().poDelivery['PO-9'], 'V1: no delivery on a draft or a cancelled order')
  check(byId('PO-3004').status === 'Approved', 'V1: setting delivery never touches the accounting status')
  S().resetDemo()
}

// --- client round 2: vendor lifecycle board (V2) ------------------------------------------------
{
  const v = await import('../src/lib/vendors.js')
  const { seedVendors } = await import('../src/store/seed.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()
  const vendor = (id) => seedVendors.find((x) => x.id === id)
  const stage = (id) => v.vendorStageOf(S().vendorStages, id)
  const go = (id, to, opts) => S().setVendorStage(vendor(id), to, { by: 'Tester', ...opts })

  // Seed and defaults.
  check(['V-01', 'V-02', 'V-03', 'V-04'].every((id) => stage(id) === 'Active') && stage('V-05') === 'Onboarding', 'V2: four seeded vendors trade, BrightRig is still onboarding')
  check(v.vendorStageOf({}, 'V-99') === 'Approved', 'V2: a vendor never recorded (older data, or the backend) counts as Approved, so orders keep working')
  check(v.canOrderFrom('Approved') && v.canOrderFrom('Active') && !['Prospect', 'Onboarding', 'On hold', 'Blacklisted'].some(v.canOrderFrom), 'V2: only Approved and Active vendors can be given a new PO')

  // Checklist.
  const bright = v.vendorChecklist(vendor('V-05'), S().vendorStages['V-05'].checks)
  check(bright.done === 3 && bright.total === 5 && !bright.complete, 'V2: BrightRig has 3 of 5 — record-based items done, agreement and reference outstanding', `${bright.done}/${bright.total}`)
  check(v.vendorChecklist(vendor('V-01'), {}).items.find((i) => i.key === 'agreement').auto, 'V2: an attached MoU ticks the agreement by itself')
  check(!v.vendorChecklist({ name: 'X', bank: { account: '1' }, pic: { name: 'A' } }, {}).items.find((i) => i.key === 'bank').done, 'V2: a bank account needs the holder too')
  check(!v.vendorChecklist({ pic: { name: 'A' } }, {}).items.find((i) => i.key === 'pic').done, 'V2: a PIC needs a phone or an email')

  // Approval gate.
  check(go('V-05', 'Approved', { role: 'finance' }) === 'Finish the onboarding checklist first.', 'V2: cannot approve until the checklist is complete')
  check(!S().toggleVendorCheck('V-05', 'npwp', 'finance'), 'V2: record-based items cannot be ticked by hand')
  check(!S().toggleVendorCheck('V-05', 'reference', 'warehouse'), 'V2: a login without vendor access cannot tick the checklist')
  check(S().toggleVendorCheck('V-05', 'agreement', 'pm') && S().toggleVendorCheck('V-05', 'reference', 'pm'), 'V2: a PM can tick the hand-checked items while onboarding')
  check(v.vendorChecklist(vendor('V-05'), S().vendorStages['V-05'].checks).complete, 'V2: …which completes the checklist')
  check(go('V-05', 'Approved', { role: 'pm' }) === 'Only finance or the CEO can approve a vendor.' && stage('V-05') === 'Onboarding', 'V2: a PM cannot approve a vendor (same rule as approving a PO)')
  check(go('V-05', 'Active', { role: 'finance' }) === 'Move a vendor one stage at a time.', 'V2: stages cannot be skipped')
  check(go('V-05', 'Approved', { role: 'finance' }) === null && stage('V-05') === 'Approved', 'V2: finance approves once the checklist is complete')
  check(!S().toggleVendorCheck('V-05', 'reference', 'finance'), 'V2: once approved, the checklist is settled')
  check(go('V-05', 'Active', { role: 'finance', hasLivePo: false }) === 'A vendor becomes active with its first approved purchase order.', 'V2: Active needs a live PO')
  check(go('V-05', 'Active', { role: 'ceo', hasLivePo: true }) === null && stage('V-05') === 'Active', 'V2: …and with one the vendor is active')
  const hist = S().vendorStages['V-05'].history
  check(hist.map((h) => h.stage).join('>') === 'Prospect>Onboarding>Approved>Active' && hist.at(-1).by === 'Tester' && hist.at(-1).at, 'V2: every change is in the history with who and when', hist.map((h) => h.stage).join('>'))

  // Hold, blacklist, reactivate.
  check(go('V-02', 'On hold', { role: 'finance', reason: '  ' }) === 'Give a reason — it stays on the vendor’s record.', 'V2: hold needs a reason')
  check(go('V-02', 'On hold', { role: 'pm', reason: 'late' }) === 'Only finance or the CEO can put a vendor on hold or blacklist one.', 'V2: a PM cannot hold a vendor')
  check(go('V-02', 'On hold', { role: 'finance', reason: 'Late on two events' }) === null && S().vendorStages['V-02'].reason === 'Late on two events', 'V2: finance puts a vendor on hold, reason kept')
  check(!v.canOrderFrom(stage('V-02')), 'V2: a vendor on hold gets no new PO')
  check(go('V-02', 'Onboarding', { role: 'finance' }) === 'A vendor on hold goes back to Active.', 'V2: on hold returns to where it was, not anywhere')
  check(go('V-02', 'Active', { role: 'finance' }) === null && stage('V-02') === 'Active' && !S().vendorStages['V-02'].reason, 'V2: reactivated back to Active, and the hold reason is cleared')
  check(go('V-03', 'Blacklisted', { role: 'ceo', reason: 'Safety breach' }) === null && stage('V-03') === 'Blacklisted', 'V2: the CEO blacklists a vendor')
  check(go('V-03', 'On hold', { role: 'ceo', reason: 'x' }) !== null && go('V-03', 'Active', { role: 'ceo' }) !== null, 'V2: a blacklisted vendor is not softened to on hold, nor reactivated straight to Active')
  check(go('V-03', 'Onboarding', { role: 'ceo' }) === null && stage('V-03') === 'Onboarding', 'V2: lifting a blacklisting means vetting again (Onboarding)')
  check(go('V-03', 'Onboarding', { role: 'ceo' }) === 'The vendor is already there.', 'V2: no no-op changes')
  check(go('V-01', 'Somewhere', { role: 'ceo' }) === 'Unknown stage.', 'V2: unknown stages are refused')
  check(go('V-01', 'Blacklisted', { role: 'warehouse', reason: 'x' }) !== null && stage('V-01') === 'Active', 'V2: a login without vendor rights changes nothing')

  // New vendors.
  check(S().addVendorProspect('V-77', 'Agus P.') && stage('V-77') === 'Prospect' && !S().addVendorProspect('V-77', 'x'), 'V2: a new vendor enters as a Prospect, once')
  const fresh = { id: 'V-77', name: 'Nusa Rigging' }
  check(S().setVendorStage(fresh, 'Onboarding', { role: 'pm', by: 'Agus P.' }) === null, 'V2: a PM can start onboarding')
  check(!v.vendorChecklist(fresh, {}).complete && S().setVendorStage(fresh, 'Approved', { role: 'ceo' }) !== null, 'V2: a vendor with an empty record cannot be approved')

  // Keys and numbering (review fixes).
  check(v.vendorKey({ id: 'V-06', uuid: 'u-1' }) === 'u-1' && v.vendorKey({ id: 'V-06' }) === 'V-06', 'V2: a backend vendor is keyed by its uuid, a demo vendor by its number — they never share a record')
  const { useStore } = await import('../src/store/useStore.js')
  const before = useStore.getState().vendors
  useStore.setState({ vendors: [...before.filter((x) => x.id !== 'V-03')] })
  const added = useStore.getState().addVendor({ name: 'Gap Test', category: 'X' })
  check(added.id === 'V-06', 'V2: a new vendor takes one past the highest number, even with a gap in the list', added.id)
  useStore.setState({ vendors: before })

  S().resetDemo()
  check(stage('V-05') === 'Onboarding' && !S().vendorStages['V-77'] && stage('V-03') === 'Active', 'V2: Reset demo restores the vendor board')
}

// --- client round 2: Discord-style chat (CH3) ---------------------------------------------------
{
  const { homeChannel } = await import('../src/lib/workspaceAccess.js')
  const wa_home = (channels) => homeChannel(channels, null)?.id
  const chat = await import('../src/lib/chat.js')
  const { visibleChannels } = await import('../src/lib/workspaceAccess.js')
  const { notificationsFor } = await import('../src/lib/notifications.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const who = (id) => S().members.find((m) => m.id === id)
  S().resetDemo()

  // Grouping
  const base = { authorId: 'M-01', at: '2026-07-26T10:00' }
  check(chat.startsGroup(null, base), 'CH3: the first message starts a block')
  check(!chat.startsGroup(base, { authorId: 'M-01', at: '2026-07-26T10:07' }), 'CH3: same author within 7 min reads as one block')
  check(chat.startsGroup(base, { authorId: 'M-01', at: '2026-07-26T10:08' }), 'CH3: a gap over 7 min starts a new block')
  check(chat.startsGroup(base, { authorId: 'M-02', at: '2026-07-26T10:01' }), 'CH3: another author starts a new block')
  check(chat.startsGroup(base, { authorId: 'M-01', at: '2026-07-26T10:01', quoteId: 'MSG-001' }), 'CH3: a quote starts a new block')
  check(chat.startsGroup({ ...base, kind: 'call' }, { authorId: 'M-01', at: '2026-07-26T10:01' }) && chat.startsGroup(base, { ...base, kind: 'call' }), 'CH3: a call line is never grouped')
  check(chat.startsGroup({ authorId: 'M-01', at: '2026-07-25T23:58' }, { authorId: 'M-01', at: '2026-07-26T00:01' }), 'CH3: a new day starts a new block')

  // Voice channels: one per project plus the Lounge, linked to a text channel they can see.
  const voice = S().channels.filter(chat.isVoice)
  check(voice.length === 5 && voice.some((c) => c.id === 'vc-lounge' && !c.projectId), 'CH3: a Meeting room per project plus the Lounge')
  check(voice.every((c) => { const tc = S().channels.find((x) => x.id === c.textChannelId); return tc && !chat.isVoice(tc) && tc.projectId === c.projectId }), 'CH3: every voice channel links to a text channel of the same server')
  check(!visibleChannels(who('M-10'), S().channels, S().projectDivisions).some((c) => c.id === 'vc-devconf'), 'CH3: a voice channel follows project access (intern not on DevConf)')
  as('M-10')
  check(S().postMessage('vc-gala', 'hello') === null, 'CH3: a voice channel takes no messages')
  check(S().startCall('vc-gala', false) && S().joinCall('M-05') && !S().joinCall('M-07'), 'CH3: start a call in a voice channel; only people with access join')
  check(!S().startCall('vc-lounge', false), 'CH3: still one call at a time')
  const n = S().messages.length
  S().leaveCall()
  const log = S().messages.at(-1)
  check(S().messages.length === n + 1 && log.channelId === 'ch-gala-general' && log.voiceChannelId === 'vc-gala' && /^Voice call in Meeting room · .+ · Nadia R\., Rina M\.$/.test(log.text),
    'CH3: a voice-channel call is logged in its linked text channel', log.text)
  check(!S().messages.some((m) => chat.isVoice(S().channels.find((c) => c.id === m.channelId))), 'CH3: no message ever lands in a voice channel')
  const bell = notificationsFor({
    persona: who('M-01'), members: S().members, tasks: S().tasks, messages: [...S().messages, { id: 'MSG-X', channelId: 'vc-gala', authorId: 'M-02', at: '2026-07-26T12:00', text: 'hi <@M-01>', reactions: {}, deleted: false }],
    channels: S().channels, projectDivisions: S().projectDivisions, events: [], guests: [], clients: [], relations: {}, role: 'staff', today: DEMO_TODAY,
  })
  check(!bell.some((i) => i.id === 'mention:MSG-X'), 'CH3: a voice channel never notifies')

  // Status and presence
  as('M-06')
  check(chat.presenceOf(who('M-06'), S().presence, 'M-06') === 'online', 'CH3: you always see yourself as online, even when seeded offline')
  check(chat.presenceOf(who('M-06'), S().presence, 'M-01') === 'offline', 'CH3: others see a seeded-offline person as offline')
  check(S().setStatus('invisible') && chat.presenceOf(who('M-06'), S().presence, 'M-01') === 'offline' && chat.presenceOf(who('M-06'), S().presence, 'M-06') === 'invisible', 'CH3: invisible shows as offline to others, invisible to yourself')
  check(S().setStatus('dnd') && chat.presenceOf(who('M-06'), S().presence, 'M-01') === 'dnd', 'CH3: do not disturb is shown to others')
  check(!S().setStatus('offline') && !S().setStatus('away'), 'CH3: only online / idle / dnd / invisible can be set')
  S().resetDemo()
  check(S().presence['M-06'] === 'offline', 'CH3: Reset demo restores presence')
  const { merge } = useProto.persist.getOptions()
  const oldSave = { channels: S().channels.filter((c) => !chat.isVoice(c)) }
  const merged = merge(oldSave, S())
  check(merged.channels.filter(chat.isVoice).length === 5 && merged.channels.length === S().channels.length, 'CH3: a demo saved before the voice channels gets them on load')
  check(merge({ channels: S().channels }, S()).channels.length === S().channels.length, 'CH3: a save that has them is not doubled')
  check(S().channels.find((c) => c.id === 'vc-lounge').textChannelId === 'ch-general' && wa_home(S().channels) === 'ch-general', 'CH3: the Lounge logs in company #general, the company’s main channel')
  const noGeneral = merge({ channels: S().channels.filter((c) => c.id !== 'ch-general').map((c) => (c.id === 'vc-lounge' ? { ...c, textChannelId: 'ch-announcements' } : c)) }, S())
  check(noGeneral.channels.some((c) => c.id === 'ch-general') && noGeneral.channels.find((c) => c.id === 'vc-lounge').textChannelId === 'ch-general', 'CH3: an older save gets #general and the Lounge moves its log there')
  as('M-10'); S().startCall('vc-lounge', false); S().leaveCall()
  check(S().messages.at(-1).channelId === 'ch-general', 'CH3: a Lounge call is logged in #general, not #announcements')
}

// --- client round 2: channel access + join requests (CH5) ---------------------------------------
{
  const wa = await import('../src/lib/workspaceAccess.js')
  const { notificationsFor } = await import('../src/lib/notifications.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const who = (id) => S().members.find((m) => m.id === id)
  const C = (id) => S().channels.find((c) => c.id === id)
  const opens = (mid, cid) => wa.canOpenChannel(who(mid), C(cid), S().projectDivisions)
  const finds = (mid, cid) => wa.discoverableChannels(who(mid), S().channels, S().projectDivisions).some((c) => c.id === cid)
  const bell = (id) => notificationsFor({
    persona: who(id), members: S().members, tasks: S().tasks, messages: S().messages, channels: S().channels,
    projectDivisions: S().projectDivisions, events: [], guests: [], clients: [], relations: {}, role: 'staff', today: DEMO_TODAY,
  })
  S().resetDemo()

  // Older shapes read the same as the new ones.
  check(wa.channelAccess({ division: 'Field' }).access === 'divisions' && wa.channelAccess({ division: 'Field' }).divisions[0] === 'Field', 'CH5: an old division channel reads as divisions')
  check(wa.channelAccess({ memberIds: ['M-01'], projectId: null }).access === 'invite' && !wa.channelAccess({ memberIds: ['M-01'], projectId: null }).listed, 'CH5: an old private company channel reads as invite-only and unlisted')

  // The matrix on the seed.
  check(opens('M-05', 'ch-gala-general') && !opens('M-05', 'ch-gala-production') && finds('M-05', 'ch-gala-production'), 'CH5: Rina (Field) sees Gala #production locked, not open')
  check(!finds('M-05', 'ch-devconf-general') && !finds('M-05', 'ch-leaders'), 'CH5: nothing from a project you are not on, and no unlisted channel, shows locked')
  check(!finds('M-05', 'dm-M-01-M-02') && wa.discoverableChannels(who('M-01'), S().channels, S().projectDivisions).length === 0, 'CH5: a DM is never discoverable; the PM has nothing locked')
  check(wa.canManageChannel(who('M-04'), C('ch-gala-production'), S().projectDivisions) && wa.canManageChannel(who('M-02'), C('ch-gala-production'), S().projectDivisions), 'CH5: leaders whose division is on the project manage its channels')
  check(!wa.canManageChannel(who('M-03'), C('ch-gala-production'), S().projectDivisions) && !wa.canManageChannel(who('M-05'), C('ch-gala-general'), S().projectDivisions), 'CH5: a leader off the project, or staff, cannot')
  check(!wa.canManageChannel(who('M-02'), C('ch-announcements'), S().projectDivisions) && wa.canManageChannel(who('M-01'), C('ch-announcements'), S().projectDivisions), 'CH5: company channels are the PM’s')

  // Seeded request → notifications for managers only.
  check(bell('M-04').some((n) => n.kind === 'Wants to join' && n.to === '/chat/ch-gala-production?settings=ch-gala-production'), 'CH5: Hendra is told Rina wants to join #production')
  check(!bell('M-03').some((n) => n.kind === 'Wants to join') && !bell('M-05').some((n) => n.kind === 'Wants to join'), 'CH5: someone who can’t decide is not told')

  // Requests
  as('M-05')
  check(!S().requestToJoin('ch-gala-production', 'again'), 'CH5: one open request at a time')
  check(!S().decideJoinRequest('ch-gala-production', 'M-05', true), 'CH5: you cannot approve your own request')
  as('M-10')
  check(!S().requestToJoin('ch-leaders', 'pls'), 'CH5: no request into an unlisted channel')
  check(S().requestToJoin('ch-gala-production', 'x'.repeat(300)) && C('ch-gala-production').requests.find((r) => r.memberId === 'M-10').note.length === 200, 'CH5: Nadia asks; the note is capped')
  as('M-03')
  check(!S().decideJoinRequest('ch-gala-production', 'M-10', true), 'CH5: a leader off the project cannot decide')
  as('M-04')
  check(S().decideJoinRequest('ch-gala-production', 'M-05', true) && opens('M-05', 'ch-gala-production'), 'CH5: Hendra approves Rina and she can open #production')
  check(!S().decideJoinRequest('ch-gala-production', 'M-05', true), 'CH5: a decided request cannot be decided again')
  check(S().decideJoinRequest('ch-gala-production', 'M-10', false) && !opens('M-10', 'ch-gala-production'), 'CH5: Hendra declines Nadia')
  check(bell('M-05').some((n) => n.kind === 'Added to channel') && bell('M-10').some((n) => n.kind === 'Request declined'), 'CH5: each requester is told the answer')
  check(!bell('M-04').some((n) => n.kind === 'Wants to join'), 'CH5: decided requests leave the managers’ bell')
  as('M-10')
  check(S().requestToJoin('ch-gala-production', 'please, once more') && C('ch-gala-production').requests.filter((r) => r.memberId === 'M-10').length === 1, 'CH5: asking again after a decline replaces the old answer')

  // Settings
  as('M-05')
  check(!S().updateChannel('ch-gala-general', { access: 'invite' }), 'CH5: staff cannot change a channel')
  as('M-04')
  check(!S().updateChannel('ch-gala-general', { access: 'divisions', divisions: [] }), 'CH5: a divisions rule needs a division')
  check(!S().updateChannel('ch-gala-general', { access: 'divisions', divisions: ['Design'] }), 'CH5: only divisions on the project count')
  check(S().updateChannel('ch-gala-general', { blockedIds: ['M-10', 'M-01', 'M-04'] }) && !opens('M-10', 'ch-gala-general') && !finds('M-10', 'ch-gala-general'), 'CH5: a blocked person neither opens nor sees the channel')
  check(!C('ch-gala-general').blockedIds.includes('M-01') && !C('ch-gala-general').blockedIds.includes('M-04') && opens('M-01', 'ch-gala-general'), 'CH5: the PM (and yourself) can’t be blocked')
  as('M-10')
  check(S().postMessage('ch-gala-general', 'hi') === null && !S().startCall('ch-gala-general', false), 'CH5: blocked means no posting and no calls')
  check(!S().requestToJoin('ch-gala-general', ''), 'CH5: a blocked person cannot ask to join')
  as('M-04')
  check(S().updateChannel('ch-gala-general', { blockedIds: [], access: 'invite', memberIds: ['M-05'] }) && opens('M-05', 'ch-gala-general') && opens('M-04', 'ch-gala-general') && !opens('M-06', 'ch-gala-general'), 'CH5: invite only lets in the named people (and whoever set it)')
  check(S().updateChannel('ch-gala-general', { name: 'Gala Main!', access: 'project', memberIds: [] }) && C('ch-gala-general').name === 'gala-main' && opens('M-06', 'ch-gala-general'), 'CH5: names are cleaned; back to everyone on the project')

  // Removing access drops people from a live call there.
  as('M-05')
  check(S().startCall('ch-gala-general', false) && S().joinCall('M-06') && S().joinCall('M-10'), 'CH5: a call with three people')
  as('M-04')
  check(S().updateChannel('ch-gala-general', { blockedIds: ['M-06'] }) && S().activeCall && !S().activeCall.participantIds.includes('M-06') && S().activeCall.participantIds.length === 2, 'CH5: blocking someone drops them from the call')
  const n = S().messages.length
  check(S().updateChannel('ch-gala-general', { access: 'invite', memberIds: [], blockedIds: [] }) && S().activeCall === null && S().messages.length === n + 1 && S().messages.at(-1).kind === 'call', 'CH5: when nobody may stay, the call ends and is logged')

  // Creating
  as('M-05')
  check(S().createChannel({ projectId: 'EVT-2026-GALA-01', name: 'x' }) === null, 'CH5: staff cannot create channels')
  as('M-02')
  check(S().createChannel({ projectId: null, name: 'social' }) === null, 'CH5: a leader cannot create a company channel')
  const vid = S().createChannel({ projectId: 'EVT-2026-GALA-01', kind: 'voice', name: 'Client call', access: 'divisions', divisions: ['Field'] })
  check(vid && C(vid).kind === 'voice' && C(vid).textChannelId === 'ch-gala-general' && C(vid).name === 'Client call' && opens('M-05', vid) && !opens('M-06', vid) && finds('M-06', vid),
    'CH5: a leader adds a Field-only voice channel; Yoga (Production) sees it locked')
  const tid = S().createChannel({ projectId: 'EVT-2026-GALA-01', name: 'Run of show', access: 'invite', memberIds: ['M-05'] })
  check(tid && C(tid).name === 'run-of-show' && opens('M-02', tid) && opens('M-05', tid) && !opens('M-10', tid) && finds('M-10', tid), 'CH5: an invite-only project channel is listed locked to the rest of the project')
  check(S().createChannel({ projectId: 'EVT-2026-GALA-01', name: 'run of show' }) === null, 'CH5: no two channels with one name on a server')
  as('M-01')
  const co = S().createChannel({ projectId: null, name: 'finance-desk', access: 'invite', memberIds: ['M-02'] })
  check(co && !finds('M-05', co) && opens('M-02', co), 'CH5: a private company channel stays out of sight by default')
  S().resetDemo()
  check(C('ch-gala-production').requests.length === 1 && !S().channels.some((c) => c.id === tid), 'CH5: Reset demo restores channels and requests')

  // Review fixes.
  as('M-01')
  check(S().updateChannel('ch-gala-production', { blockedIds: ['M-02'] }), 'CH5 review: the PM blocks Dinda from #production')
  check(!wa.canManageChannel(who('M-02'), C('ch-gala-production'), S().projectDivisions), 'CH5 review: a blocked leader no longer manages the channel')
  as('M-02')
  check(!S().updateChannel('ch-gala-production', {}) && C('ch-gala-production').blockedIds.includes('M-02'), 'CH5 review: saving settings cannot lift a block on yourself')
  check(!bell('M-02').some((n) => n.kind === 'Wants to join'), 'CH5 review: a blocked leader is not asked to decide')
  S().resetDemo()
  as('M-02')
  check(finds('M-02', 'ch-gala-production') && S().requestToJoin('ch-gala-production', 'me too'), 'CH5 review: Dinda (Field lead) can ask into #production')
  check(!S().decideJoinRequest('ch-gala-production', 'M-02', true) && !opens('M-02', 'ch-gala-production'), 'CH5 review: a leader cannot approve their own request')
  // An old-shape channel (only `division`) keeps its rule when a request is approved.
  useProto.setState({ channels: S().channels.map((c) => (c.id === 'ch-gala-production' ? { id: c.id, name: c.name, projectId: c.projectId, division: 'Production', topic: c.topic, requests: c.requests } : c)) })
  as('M-04')
  check(S().decideJoinRequest('ch-gala-production', 'M-05', true) && opens('M-05', 'ch-gala-production') && opens('M-06', 'ch-gala-production') && C('ch-gala-production').access === 'divisions',
    'CH5 review: approving on an old-shape channel lets the requester in without locking the division out')
  // A restricted voice room never logs who met in a channel outsiders read.
  as('M-02')
  const room = S().createChannel({ projectId: 'EVT-2026-GALA-01', kind: 'voice', name: 'Field huddle', access: 'divisions', divisions: ['Field'] })
  const before = S().messages.length
  check(S().startCall(room, false) && S().joinCall('M-05') && S().leaveCall() && S().activeCall === null && S().messages.length === before, 'CH5 review: a Field-only room’s call is not logged in #general')
  // Moving someone off the project takes their channel access with it.
  as('M-01')
  S().updateChannel('ch-gala-general', { memberIds: ['M-10'] })
  useProto.setState({ members: S().members.map((m) => (m.id === 'M-10' ? { ...m, projectIds: [] } : m)) })
  check(!opens('M-10', 'ch-gala-general'), 'CH5 review: someone moved off the project loses even channels they were let into')
  S().updateChannel('ch-gala-general', { name: 'gala-main' })
  check(wa.homeChannel(S().channels, 'EVT-2026-GALA-01')?.id === 'ch-gala-general', 'CH5 review: the project chat link follows a renamed #general')
  S().resetDemo()
}

// --- client round 2: meeting records + minutes access (CH4) -------------------------------------
{
  const mt = await import('../src/lib/meetings.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  const as = (id) => S().setPersona(id)
  const who = (id) => S().members.find((m) => m.id === id)
  const MT = (id) => S().meetings.find((m) => m.id === id)
  const sees = (mid, id) => mt.canSeeMeeting(who(mid), MT(id), S().channels, S().projectDivisions)
  S().resetDemo()

  // Seed
  check(MT('MTG-1') && S().messages.some((m) => m.meetingId === 'MTG-1' && m.channelId === 'ch-gala-general'), 'CH4: the Gala call is meeting MTG-1, linked from its call line')
  check(sees('M-02', 'MTG-1') && sees('M-05', 'MTG-1') && sees('M-01', 'MTG-1') && !sees('M-06', 'MTG-1'), 'CH4: MTG-1 — participants and the PM read it; Yoga (on the project, not the call) does not')
  check(sees('M-09', 'MTG-2') && sees('M-08', 'MTG-2') && !sees('M-10', 'MTG-2'), 'CH4: MTG-2 is open to the channel, never beyond it')
  check(MT('MTG-1').summary?.source === 'seeded' && MT('MTG-1').summary.actionItems.length > 0 && !MT('MTG-2').summary, 'CH4: MTG-1 has seeded minutes; MTG-2 none yet')

  // Transcript and offline minutes
  const call = { participantIds: ['M-02', 'M-05'], hostId: 'M-02', startedAt: '2026-07-26T10:00', endedAt: '2026-07-26T10:12' }
  const t1 = mt.simulateTranscript(call, 'Gala')
  check(JSON.stringify(t1) === JSON.stringify(mt.simulateTranscript(call, 'Gala')), 'CH4: the simulated transcript is deterministic')
  check(t1.every((l) => call.participantIds.includes(l.speakerId)) && t1[0].speakerId === 'M-02' && t1.at(-1).at <= call.endedAt, 'CH4: only people on the call speak, the host opens, all within the call')
  check(mt.simulateTranscript({ ...call, endedAt: '2026-07-26T10:01' }).length === 4, 'CH4: a one-minute call gets a short transcript')
  const off = mt.offlineMinutes({ ...call, transcript: t1, notes: [{ by: 'M-05', text: 'Bring the badges' }], video: false }, S().members, 'Gala')
  check(off.decisions.length >= 1 && off.actionItems.every((a) => call.participantIds.includes(a.ownerId) && /^\d{4}-\d{2}-\d{2}$/.test(a.due)) && off.discussion.some((d) => d.includes('Bring the badges')),
    'CH4: offline minutes pick decisions, owned and dated action items, and include the notes')
  check(mt.offlineMinutes({ ...call, transcript: [{ at: call.startedAt, speakerId: 'M-02', text: 'I’ll send the RSVP reminder by Friday.' }], notes: [] }, S().members).actionItems[0].due === '2026-07-31', 'CH4: "by Friday" is the next Friday')

  // A call with notes and a file becomes a meeting
  as('M-05')
  check(!S().addCallNote('no call yet'), 'CH4: no notes without a call')
  S().startCall('ch-gala-general', false)
  S().joinCall('M-10')
  check(S().addCallNote('  Seats for VIPs  ') && S().activeCall.notes[0].text === 'Seats for VIPs', 'CH4: a note typed during the call')
  check(S().addCallFile({ name: 'seating.pdf', type: 'application/pdf', size: 1000, data: 'data:application/pdf;base64,AAAA' }).id === 'F-1', 'CH4: a file shared during the call')
  check(S().addCallFile({ name: 'run.exe', type: '', size: 10 }).error, 'CH4: shared files follow the attachment rules')
  as('M-06')
  check(!S().addCallNote('not on it'), 'CH4: someone not on the call cannot add notes')
  as('M-05')
  S().leaveCall()
  const fresh = S().meetings.at(-1)
  const log = S().messages.at(-1)
  check(fresh.id === 'MTG-3' && log.meetingId === 'MTG-3' && fresh.notes.length === 1 && fresh.files.length === 1 && fresh.transcript.length >= 4 && fresh.access.mode === 'participants',
    'CH4: ending the call creates the meeting with its notes, file and transcript, private to participants')
  check(sees('M-10', 'MTG-3') && !sees('M-06', 'MTG-3') && sees('M-01', 'MTG-3'), 'CH4: Nadia (on it) reads it, Yoga does not, the PM does')

  // Access: host decides
  as('M-06')
  check(!S().setMeetingAccess('MTG-3', { mode: 'channel' }), 'CH4: only the host or PM changes access')
  as('M-05')
  check(!S().postMeetingSummary('MTG-3'), 'CH4: nothing to post before a summary')
  check(S().saveMeetingSummary('MTG-3', { ...mt.offlineMinutes(fresh, S().members), source: 'offline' }), 'CH4: a participant saves the summary')
  check(S().postMeetingSummary('MTG-3') === null, 'CH4: the summary cannot be posted while access is participants-only (no leak)')
  check(S().setMeetingAccess('MTG-3', { mode: 'people', extraIds: ['M-06', 'M-09'] }) && sees('M-06', 'MTG-3') && !MT('MTG-3').access.extraIds.includes('M-09'), 'CH4: named people read it; someone outside the channel cannot be named')
  check(S().setMeetingAccess('MTG-3', { mode: 'channel', filesViewOnly: true }) && sees('M-06', 'MTG-3')
    && !mt.canOpenMeetingFiles(who('M-06'), MT('MTG-3'), S().channels, S().projectDivisions) && mt.canOpenMeetingFiles(who('M-05'), MT('MTG-3'), S().channels, S().projectDivisions),
    'CH4: view-only files — others see the list but cannot open; the host can')
  const posted = S().postMeetingSummary('MTG-3')
  check(posted && S().messages.find((m) => m.id === posted).text.startsWith('Meeting summary (MTG-3)') && S().postMeetingSummary('MTG-3') === null, 'CH4: with channel access the summary posts once')

  // Action items → tasks, under the persona's assignment rules
  as('M-10')
  const asIntern = S().createTasksFromMeeting('MTG-3')
  check(asIntern.created.length === 0 && asIntern.skipped.length > 0, 'CH4: an intern (who assigns nothing) creates no tasks; items are skipped')
  as('M-01')
  const n = S().tasks.length
  const r = S().createTasksFromMeeting('MTG-3')
  check(r.created.length > 0 && S().tasks.length === n + r.created.length && MT('MTG-3').summary.actionItems.filter((a) => a.taskId).length === r.created.length, 'CH4: the PM turns action items into tasks, marked on the item')
  check(S().createTasksFromMeeting('MTG-3').created.length === 0, 'CH4: running it again creates no duplicates')

  // DM calls: the PM never sees them
  as('M-06')
  const dm = S().openDm('M-07')
  S().startCall(dm, true); S().joinCall('M-07'); S().leaveCall()
  const dmMeet = S().meetings.at(-1)
  check(dmMeet.dm && sees('M-07', dmMeet.id) && !sees('M-01', dmMeet.id), 'CH4: a DM call’s minutes are for its two people, never the PM')
  as('M-01')
  check(!S().setMeetingAccess(dmMeet.id, { mode: 'channel' }) && !S().saveMeetingSummary(dmMeet.id, { overview: 'x' }), 'CH4: the PM can neither open up nor write a DM call’s minutes')

  // Restricted voice room: meeting kept, no call line in #general
  as('M-02')
  const room = S().createChannel({ projectId: 'EVT-2026-GALA-01', kind: 'voice', name: 'Field huddle', access: 'divisions', divisions: ['Field'] })
  const msgsBefore = S().messages.length
  S().startCall(room, false); S().joinCall('M-05'); S().leaveCall()
  const roomMeet = S().meetings.at(-1)
  check(roomMeet.channelId === room && roomMeet.logChannelId === null && !sees('M-06', roomMeet.id) && S().messages.length === msgsBefore && !S().messages.some((x) => x.meetingId === roomMeet.id),
    'CH4: a restricted room’s meeting is kept for its people, with no call line anywhere')

  // Storage budget counts meeting files
  const { STORE_BUDGET } = await import('../src/lib/attachments.js')
  const full = 'x'.repeat(STORE_BUDGET - 10)
  useProto.setState({ tasks: S().tasks.map((t, i) => (i === 0 ? { ...t, attachments: [{ id: 'A-9', preview: full }] } : t)) })
  as('M-05'); S().startCall('ch-gala-general', false)
  const shared = S().addCallFile({ name: 'big.pdf', type: 'application/pdf', size: 2000, data: 'data:application/pdf;base64,' + 'A'.repeat(100) })
  check(shared.id && S().activeCall.files[0].data === undefined, 'CH4: a call file keeps only its details once task files have used the storage budget')
  S().leaveCall()
  useProto.setState({ tasks: S().tasks.map((t, i) => (i === 0 ? { ...t, attachments: [] } : t)) })
  S().resetDemo()
  check(S().meetings.length === 2, 'CH4: Reset demo restores the two seeded meetings')

  // Review fixes.
  check(S().messages.filter((x) => x.quoteId).every((r) => !S().messages.find((x) => x.id === r.quoteId).kind), 'CH4 review: no seeded reply quotes a call line')
  as('M-06')
  const dm2 = S().openDm('M-07')
  S().startCall(dm2, false); S().leaveCall()
  const dmOnlyHost = S().meetings.at(-1)
  check(!S().setMeetingAccess(dmOnlyHost.id, { mode: 'channel' }) && !S().setMeetingAccess(dmOnlyHost.id, { mode: 'people', extraIds: ['M-07'] }), 'CH4 review: a DM call’s host cannot open its minutes beyond the call')
  S().saveMeetingSummary(dmOnlyHost.id, { overview: 'x', actionItems: [] })
  check(S().postMeetingSummary(dmOnlyHost.id) === null && !mt.canSeeMeeting(who('M-07'), MT(dmOnlyHost.id), S().channels, S().projectDivisions), 'CH4 review: …nor post them into the DM for someone who missed the call')
  as('M-01')
  const first = S().createTasksFromMeeting('MTG-1').created
  check(first.length > 0 && S().saveMeetingSummary('MTG-1', { ...MT('MTG-1').summary, source: 'offline' }) && S().createTasksFromMeeting('MTG-1').created.length === 0, 'CH4 review: regenerating keeps the task links, so no task is made twice')
  as('M-05')
  check(!S().saveMeetingSummary('MTG-1', { overview: 'rewritten' }) && MT('MTG-1').summary.overview !== 'rewritten', 'CH4 review: a participant cannot replace minutes that exist (host or PM only)')
  as('M-01')
  S().saveMeetingSummary('MTG-2', { overview: 'o', source: 'ai', provider: 'evil', model: 'm', actionItems: [{ text: 'a', ownerId: 'M-06', due: '2026-08-01' }, { text: 'b', ownerId: 'M-08', due: 'soon' }] })
  check(MT('MTG-2').summary.source === 'offline' && MT('MTG-2').summary.provider === null, 'CH4 review: "AI" provenance needs a known provider')
  check(MT('MTG-2').summary.actionItems[0].ownerId === null && MT('MTG-2').summary.actionItems[1].ownerId === 'M-08' && MT('MTG-2').summary.actionItems[1].due === null, 'CH4 review: owners must have been on the call; bad dates are dropped')
  check(S().saveMeetingSummary('MTG-2', { overview: 'o', source: 'demo' }) && MT('MTG-2').summary.source === 'demo', 'CH4 demo: a demo AI summary keeps its demo label')
  {
    const m1 = MT('MTG-1')
    const en = mt.demoMinutes(m1, S().members, 'Gala')
    const id = mt.demoMinutes(m1, S().members, 'Gala', 'id')
    check(JSON.stringify(en) === JSON.stringify(mt.demoMinutes(m1, S().members, 'Gala')), 'CH4 demo: the demo minutes are deterministic')
    check(en.decisions.length === 4 && en.actionItems.length === 4 && en.actionItems.every((a) => m1.participantIds.includes(a.ownerId) && a.due) && !/\.\./.test(en.overview), 'CH4 demo: decisions, owned and dated actions, a clean overview')
    check(!en.discussion.some((d) => m1.transcript.some((l) => d.includes(l.text))), 'CH4 demo: discussion is written up, not quoted from the transcript')
    check(/^Tim rapat/.test(id.overview) && id.decisions[0].startsWith('Mengunci') && id.agenda[0].startsWith('Progres'), 'CH4 demo: Bahasa Indonesia when the app is in Bahasa')
    check(mt.demoMinutes({ ...m1, transcript: m1.transcript.map(({ ref, ...l }) => l) }, S().members).decisions.length > 0, 'CH4 demo: an older transcript without script refs still gets minutes')
  }
  S().saveMeetingSummary('MTG-2', { overview: 'o', source: 'ai', provider: 'deepseek', model: 'deepseek-chat' })
  check(MT('MTG-2').summary.source === 'ai' && MT('MTG-2').summary.model === 'deepseek-chat', 'CH4 review: a real AI result keeps its label')
  // A voice room tightened after its call: its channel-wide minutes can no longer be posted.
  as('M-02')
  const vr = S().createChannel({ projectId: 'EVT-2026-GALA-01', kind: 'voice', name: 'Ops room' })
  S().startCall(vr, false); S().joinCall('M-05'); S().leaveCall()
  const vm = S().meetings.at(-1)
  check(vm.logChannelId === 'ch-gala-general', 'CH4 review: an open room logs in #general')
  S().setMeetingAccess(vm.id, { mode: 'channel' }); S().saveMeetingSummary(vm.id, { overview: 'room minutes' })
  S().updateChannel(vr, { access: 'divisions', divisions: ['Field'] })
  check(S().postMeetingSummary(vm.id) === null, 'CH4 review: after the room is tightened, its minutes are not posted where outsiders read')
  // An older save of this version, from before meetings, gets the seeded call lines linked.
  S().resetDemo()
  const { merge } = useProto.persist.getOptions()
  const old = { messages: S().messages.map(({ meetingId, ...x }) => x) }
  check(merge(old, S()).messages.find((x) => x.text.startsWith('Video call · 18 min')).meetingId === 'MTG-1', 'CH4 review: an older save gets MTG-1 linked to its call line')
  S().resetDemo()
}

// --- Template Studio (client round 3, item 4) -----------------------------------------------
// The design team's own templates: validated, found by every reader like a built-in, managed
// only by the CEO and PMs, and never lost from under an invitation that uses one.
{
  const tpls = await import('../src/lib/templates.js')
  const { validateTemplate, newTemplate, registerTemplates, allTemplates, themeOf, inGallery, FONTS } = tpls
  const { templateUsage } = await import('../src/lib/invites.js')
  const { canDo, canSee, ROLES } = await import('../src/lib/roles.js')
  const { useProto } = await import('../src/store/useProto.js')
  const S = () => useProto.getState()
  S().resetDemo()

  // validateTemplate: a fresh blank or copy passes; each kind of bad input is refused.
  const good = newTemplate({ id: 'studio-1', family: 'private' })
  check(!validateTemplate(good) && !validateTemplate(newTemplate({ id: 'studio-2', family: 'corporate' })), 'R3 studio: a blank template of either family validates')
  check(TEMPLATES.every((b) => !validateTemplate(newTemplate({ id: `studio-${b.id}`, from: b }))), 'R3 studio: a copy of every built-in validates')
  const bad = (patch) => validateTemplate({ ...structuredClone(good), ...patch })
  check(Boolean(validateTemplate(null)) && Boolean(bad({ id: 'gala' })) && Boolean(bad({ name: '  ' })), 'R3 studio: refuses no template, a built-in id, a blank name')
  check(Boolean(bad({ palette: { ...good.palette, accent: 'red' } })) && Boolean(bad({ palette: { bg: '#fff', surface: '#ffffff', accent: '#000000', text: '#000000' } })), 'R3 studio: colours must be six-digit hex')
  check(Boolean(bad({ fonts: { ...good.fonts, heading: 'comic-sans' } })) && Boolean(bad({ fonts: { ...good.fonts, body: FONTS.inter } })), 'R3 studio: fonts must be keys of the loaded fonts')
  check(Boolean(bad({ cover: 'carousel' })) && Boolean(bad({ ornament: 'stars' })) && Boolean(bad({ family: 'party' })), 'R3 studio: cover, ornament and family come from the allowed lists')
  check(Boolean(bad({ sections: ['message', 'cover', 'details', 'rsvp'] })) && Boolean(bad({ sections: ['cover', 'details', 'rsvp', 'rsvp'] })), 'R3 studio: cover first, no section twice')
  check(Boolean(bad({ sections: ['cover', 'details', 'agenda', 'rsvp'], off: [] })) && Boolean(bad({ sections: ['cover', 'details', 'message'], off: [] })), 'R3 studio: sections suit the family; required ones are present')
  check(Boolean(bad({ off: ['rsvp'] })) && Boolean(bad({ off: ['agenda'] })), 'R3 studio: only optional sections in the template start off')
  check(Boolean(bad({ art: { ...good.art, frame: 'data:image/svg+xml,<svg/>' } })) && Boolean(bad({ art: { logo: null } })) && Boolean(bad({ status: 'live' })), 'R3 studio: artwork is media references in known slots; status is known')

  // Registered → every reader finds it; bad entries are skipped; the built-ins stay as they were.
  registerTemplates([{ ...good, status: 'published' }, { ...good, id: 'studio-9', cover: 'nope' }, 'junk'])
  const reg = tpls.templateById('studio-1')
  check(reg?.custom && !tpls.templateById('studio-9') && allTemplates().length === 7, 'R3 studio: a valid custom template resolves by id; invalid ones are left out')
  check(reg.fonts.heading === FONTS.playfair && reg.sample.couple && typeof reg.coverBg === 'string', 'R3 studio: a registered template reads like a built-in (font stacks, family sample, cover)')
  const inv = { templateId: 'studio-1', on: {}, content: blankContent({ name: 'X', date: '2026-12-01' }) }
  check(themeOf(inv).tpl === reg && themeOf(inv).palette.bg === good.palette.bg, 'R3 studio: themeOf finds a custom template')
  check(sectionOn(inv, 'couple') && sectionOn(inv, 'rsvp') && visibleSections(inv).includes('details'), 'R3 studio: sectionOn / visibleSections work on a custom template')
  check(TEMPLATES.length === 6 && TEMPLATES.every((b) => Object.isFrozen(b) && !b.custom) && allTemplates().slice(0, 6).every((b, i) => b === TEMPLATES[i]), 'R3 studio: the six built-ins stay frozen and first')
  const stranger = { templateId: 'studio-77', on: {}, content: blankContent({ name: 'X', date: '2026-12-01' }) }
  check(themeOf(stranger).tpl.id === 'gala' && visibleSections(stranger).includes('details'), 'R3 studio: an id this browser does not know draws as the first built-in, not a blank page')
  registerTemplates(S().customTemplates)

  // Who may: CEO and PMs only, in the role table and in the store.
  check(canDo('ceo', 'manage_templates') && canDo('pm', 'manage_templates') && !['finance', 'sales', 'warehouse'].some((r) => canDo(r, 'manage_templates')), 'R3 studio: only the CEO and PMs manage templates')
  check(Object.keys(ROLES).every((r) => canSee(r, 'templates') === canDo(r, 'manage_templates')), 'R3 studio: the sidebar item shows for exactly the roles that may manage templates')
  check(S().createTemplate({ family: 'private' }, 'finance') === null && S().createTemplate({ from: 'gala' }, 'sales') === null && S().customTemplates.length === 0, 'R3 studio: finance and sales cannot create templates')
  const id = S().createTemplate({ from: 'royal' }, 'pm')
  const T = () => S().customTemplates.find((x) => x.id === id)
  check(id === 'studio-1' && T().status === 'draft' && T().name === 'Royal copy' && T().fonts.script === 'vibes' && tpls.templateById(id)?.custom, 'R3 studio: a PM duplicates a built-in into a draft (fonts as keys), found at once')
  check(S().createTemplate({ from: 'nope' }, 'ceo') === null, 'R3 studio: duplicating an unknown template is refused')
  check(Boolean(S().updateTemplate(id, { palette: { ...T().palette, accent: 'gold' } }, 'pm')) && T().palette.accent === '#a8823c', 'R3 studio: a bad colour is not saved, and says why')
  check(S().updateTemplate(id, { name: 'Tries' }, 'sales') === 'This login cannot design templates.' && T().name === 'Royal copy', 'R3 studio: sales cannot edit a template')
  check(S().updateTemplate(id, { name: ' Batik Night ', cover: 'framed', palette: { ...T().palette, accent: '#7a2e2e' }, status: 'published', id: 'gala' }, 'ceo') === null
    && T().name === 'Batik Night' && T().cover === 'framed' && T().status === 'draft' && T().id === id, 'R3 studio: a save keeps only the editable settings')
  const png = { key: 'm-art', name: 'cover.png', size: 10, type: 'image/png' }
  check(!S().setTemplateArt(id, 'coverBg', { key: 'm-x', name: 'x.svg', size: 1, type: 'image/svg+xml' }, 'pm') && !S().setTemplateArt(id, 'logo', png, 'pm') && !S().setTemplateArt(id, 'coverBg', png, 'finance'), 'R3 studio: artwork must be a photo file, in a known slot, set by a manager')
  check(S().setTemplateArt(id, 'coverBg', png, 'pm') && tpls.templateById(id).art.coverBg.key === 'm-art', 'R3 studio: cover artwork is stored as a media reference')

  // The gallery: a draft cannot be picked; once added it can; archived leaves the gallery but
  // the invitation already on it keeps rendering. (Decision: chooseTemplate takes a studio
  // template only while it is in the gallery — except re-choosing the one an event already has.)
  const evId = S().createEvent({ name: 'Studio test', date: '2026-12-10' })
  const E = () => S().events.find((e) => e.id === evId)
  check(!S().chooseTemplate(evId, id) && !inGallery(tpls.templateById(id)), 'R3 studio: a draft template cannot be chosen for an invitation')
  check(!S().publishTemplate(id, 'sales') && S().publishTemplate(id, 'pm') && T().status === 'published', 'R3 studio: a PM (not sales) adds it to the gallery')
  check(S().chooseTemplate(evId, id) && E().invite.templateId === id, 'R3 studio: a template in the gallery can be chosen')
  S().publishInvite(evId)
  check(E().status === 'Published' && templateUsage(S().events, id).live === 1 && templateUsage(S().events, id).events === 1, 'R3 studio: usage counts the event and its published invitation')
  check(!S().archiveTemplate(id, 'finance') && S().archiveTemplate(id, 'ceo') && T().status === 'archived' && !inGallery(tpls.templateById(id)), 'R3 studio: archive (managers only) takes it out of the gallery')
  check(themeOf(E().published).tpl.id === id && visibleSections(E().published).includes('details'), 'R3 studio: an archived template still renders the invitation already on it')
  const other = S().createEvent({ name: 'Other', date: '2026-12-11' })
  check(!S().chooseTemplate(other, id) && S().chooseTemplate(evId, id), 'R3 studio: an archived template cannot be newly chosen; the event already on it keeps it')
  check(Boolean(S().updateTemplate(id, { name: 'Edit while archived' }, 'pm')) && !S().setTemplateArt(id, 'frame', png, 'pm'), 'R3 studio: an archived template is restored before editing')
  check(!S().publishTemplate(id, 'ceo') && T().status === 'archived' && !inGallery(tpls.templateById(id)), 'R3 studio: an archived template cannot go straight back to the gallery (Restore first)')
  check(S().unpublishTemplate(id, 'pm') && T().status === 'draft' && S().updateTemplate(id, { name: 'Restored' }, 'pm') === null, 'R3 studio: restoring brings it back as a draft')

  // Persistence: an older save has no studio key and keeps the empty default (no version bump).
  const { merge } = useProto.persist.getOptions()
  const before = S()
  check(Array.isArray(merge({ events: before.events }, { ...before, customTemplates: [] }).customTemplates)
    && Array.isArray(merge({ customTemplates: 'junk' }, before).customTemplates), 'R3 studio: an older or damaged save gets an empty template list')
  S().resetDemo()
  check(S().customTemplates.length === 0 && !tpls.templateById(id) && allTemplates().length === 6, 'R3 studio: reset demo clears the studio, and the lookup follows')
}

// --- store selectors that would loop forever ------------------------------------------------
// A zustand selector that builds a new array or object on every call (`s.x.filter(…)`,
// `({ … })`) makes the component re-render without end in the browser. Server rendering reads
// the store once, so the smoke check cannot see it — hence this scan of the source.
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const walk = (dir) => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : /\.jsx?$/.test(f) ? [p] : []
  })
  const bad = /use(Proto|Store)\(\s*\(s\)\s*=>\s*(\(\{|\[|[^)]*\.(filter|map|slice|concat|flatMap)\()/
  const offenders = walk(fileURLToPath(new URL('../src', import.meta.url)))
    .flatMap((file) => readFileSync(file, 'utf8').split('\n').map((line, i) => [file, i + 1, line]))
    .filter(([, , line]) => bad.test(line))
    .map(([file, n]) => `${file.split(/[\/]src[\/]/)[1]}:${n}`)
  check(offenders.length === 0, 'no store selector builds a new array or object per call', offenders.join(', '))
}

console.log(failures ? `\n${failures} PROTOTYPE CHECK(S) FAILED (${passes} passed)` : `ALL ${passes} PROTOTYPE CHECKS PASSED`)
process.exitCode = failures ? 1 : 0
