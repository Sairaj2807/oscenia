// Mock data for the prototype modules: project workspace, team chat, events/RSVP and the CRM
// relationship layer. Front-end only — nothing here exists on the backend yet.
//
// Everything is dated relative to DEMO_TODAY (2026-07-26) and hangs off the existing seed:
// the four projects in seed.js and the clients CL-01…CL-04.

import { simulateTranscript, demoMinutes } from '../lib/meetings.js'
import { DEMO_TODAY } from '../lib/format.js'
import { fromLegacyDesign, blankInvite } from '../lib/invites.js'
import { recipientRows, DEFAULT_INVITE_MESSAGE, DEFAULT_INVITE_SUBJECT } from '../lib/broadcasts.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const addDays = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
const minDate = (a, b) => (a < b ? a : b)
const at = (date, time = '09:00') => `${date}T${time}`

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export const DIVISIONS = ['Field', 'Design', 'Production']

export const seedMembers = [
  { id: 'M-01', name: 'Agus P.', workspaceRole: 'pm', division: 'Management', title: 'Project Manager' },
  { id: 'M-02', name: 'Dinda A.', workspaceRole: 'leader', division: 'Field', title: 'Field Division Lead' },
  { id: 'M-03', name: 'Maya S.', workspaceRole: 'leader', division: 'Design', title: 'Design Division Lead' },
  { id: 'M-04', name: 'Hendra T.', workspaceRole: 'leader', division: 'Production', title: 'Production Division Lead' },
  { id: 'M-05', name: 'Rina M.', workspaceRole: 'staff', division: 'Field', title: 'Stage Manager', projectIds: ['EVT-2026-GALA-01', 'EVT-2026-PROD-04'] },
  { id: 'M-06', name: 'Yoga K.', workspaceRole: 'staff', division: 'Production', title: 'Rigging Tech', projectIds: ['EVT-2026-GALA-01', 'EVT-2026-CONF-03'] },
  { id: 'M-07', name: 'Sela D.', workspaceRole: 'staff', division: 'Production', title: 'Lighting & AV', projectIds: ['EVT-2026-CONF-03'] },
  { id: 'M-08', name: 'Putri L.', workspaceRole: 'staff', division: 'Design', title: 'Senior Designer', projectIds: ['EVT-2026-WED-02', 'EVT-2026-CONF-03', 'EVT-2026-PROD-04'] },
  { id: 'M-09', name: 'Kevin W.', workspaceRole: 'intern', division: 'Design', title: 'Design Intern', projectIds: ['EVT-2026-WED-02', 'EVT-2026-CONF-03'] },
  { id: 'M-10', name: 'Nadia R.', workspaceRole: 'intern', division: 'Field', title: 'Field Intern', projectIds: ['EVT-2026-GALA-01'] },
]

// Which divisions work on each project. The PM assigns these (Team & access tab).
export const seedProjectDivisions = {
  'EVT-2026-GALA-01': ['Field', 'Production'],
  'EVT-2026-WED-02': ['Design', 'Field'],
  'EVT-2026-CONF-03': ['Design', 'Production'],
  'EVT-2026-PROD-04': ['Field', 'Design'],
}

const LEADER_OF = { Field: 'M-02', Design: 'M-03', Production: 'M-04' }

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

// Builds the activity trail a task in `status` would have accumulated, so every seeded task
// reads as if it really went through the flow: assigned → started → (blocked | submitted →
// leader approved → PM approved).
function task(id, projectId, division, title, assigneeId, assignedById, assignedOn, deadline, priority, status, extra = {}) {
  const started = minDate(addDays(assignedOn, 1), DEMO_TODAY)
  const submitted = minDate(addDays(deadline, -1), DEMO_TODAY)
  const activity = [{ at: at(assignedOn), by: assignedById, text: 'assigned', kind: 'assign' }]
  const approvals = {}
  let completedAt = null

  if (status !== 'To do') activity.push({ at: at(started, '10:30'), by: assigneeId, text: 'started', kind: 'status' })
  if (extra.rejection) {
    const r = extra.rejection
    activity.push({ at: at(r.submittedOn, '15:00'), by: assigneeId, text: 'submitted for approval', kind: 'status' })
    activity.push({ at: at(r.on, '11:15'), by: r.by, text: `rejected: ${r.comment}`, kind: 'reject' })
  }
  if (status === 'Blocked') {
    activity.push({ at: at(extra.blockedOn || started, '16:00'), by: assigneeId, text: `blocked: ${extra.blockerReason}`, kind: 'block' })
  }
  if (['Submitted', 'Leader approved', 'PM approved'].includes(status)) {
    activity.push({ at: at(submitted, '17:00'), by: assigneeId, text: 'submitted for approval', kind: 'status' })
  }
  if (['Leader approved', 'PM approved'].includes(status)) {
    const on = minDate(addDays(submitted, 1), DEMO_TODAY)
    approvals.leader = { by: LEADER_OF[division], at: at(on, '10:00') }
    activity.push({ at: approvals.leader.at, by: LEADER_OF[division], text: 'approved (Division Leader)', kind: 'approve' })
  }
  if (status === 'PM approved') {
    const on = minDate(addDays(submitted, 2), DEMO_TODAY)
    approvals.pm = { by: 'M-01', at: at(on, '14:00') }
    completedAt = approvals.pm.at
    activity.push({ at: approvals.pm.at, by: 'M-01', text: 'approved (PM) — done', kind: 'approve' })
  }

  return {
    id, projectId, division, title,
    description: extra.description || '',
    assigneeId, assignedById,
    assignedAt: at(assignedOn),
    deadline, priority, status,
    blockerReason: status === 'Blocked' ? extra.blockerReason : '',
    approvals, completedAt,
    activity: activity.sort((a, b) => a.at.localeCompare(b.at)),
  }
}

const G = 'EVT-2026-GALA-01'
const W = 'EVT-2026-WED-02'
const C = 'EVT-2026-CONF-03'
const P = 'EVT-2026-PROD-04'

export const seedTasks = [
  // Aurora Bank Annual Gala — 14 Aug, in execution
  task('T-101', G, 'Field', 'Finalise run-of-show v3', 'M-05', 'M-02', '2026-07-10', '2026-07-28', 'High', 'In progress',
    { description: 'Lock timings with the MC and the bank’s comms team. Include the CEO speech slot.' }),
  task('T-102', G, 'Production', 'LED wall content render (main + side screens)', 'M-06', 'M-04', '2026-07-12', '2026-07-24', 'High', 'Blocked',
    { blockerReason: 'Waiting on the client’s final logo files — requested 20 Jul, no reply yet', blockedOn: '2026-07-20' }),
  task('T-103', G, 'Field', 'VIP seating plan from guest list', 'M-10', 'M-02', '2026-07-15', '2026-07-30', 'Medium', 'Submitted'),
  task('T-104', G, 'Production', 'Rigging load calculation sign-off', 'M-06', 'M-04', '2026-07-08', '2026-07-20', 'High', 'Leader approved'),
  task('T-105', G, 'Field', 'Venue walkthrough with client', 'M-05', 'M-02', '2026-07-01', '2026-07-12', 'Medium', 'PM approved'),
  task('T-106', G, 'Field', 'Print guest badges and table cards', 'M-10', 'M-05', '2026-07-20', '2026-08-07', 'Low', 'To do',
    { description: 'Assigned by Rina (staff) — wait for the RSVP list to close on 1 Aug.' }),
  task('T-107', G, 'Production', 'Stage lighting cue sheet', 'M-06', 'M-04', '2026-07-18', '2026-08-05', 'Medium', 'To do'),
  task('T-108', G, 'Field', 'Confirm catering headcount and allergy list', 'M-05', 'M-01', '2026-07-19', '2026-07-25', 'High', 'Blocked',
    { blockerReason: 'RSVP closes 1 Aug — headcount cannot be locked before then', blockedOn: '2026-07-24' }),

  // Wibowo–Sari Wedding — 5 Sep, client approval
  task('T-201', W, 'Design', 'Moodboard revision 2 (warmer palette)', 'M-08', 'M-03', '2026-07-14', '2026-07-27', 'High', 'Submitted'),
  task('T-202', W, 'Design', 'Floral arch 3D render', 'M-09', 'M-03', '2026-07-16', '2026-07-29', 'Medium', 'In progress',
    { rejection: { submittedOn: '2026-07-21', on: '2026-07-22', by: 'M-03', comment: 'arch is too tall for the pendopo — keep it under 3 m' } }),
  task('T-203', W, 'Field', 'Venue permit application (Gianyar regency)', 'M-02', 'M-01', '2026-07-05', '2026-07-31', 'High', 'Blocked',
    { blockerReason: 'Regency office needs the signed family consent letter — with the client since 18 Jul', blockedOn: '2026-07-18' }),
  task('T-204', W, 'Design', 'Invitation website design', 'M-08', 'M-03', '2026-07-18', '2026-08-02', 'Medium', 'To do'),
  task('T-205', W, 'Design', 'Table-setting mockups', 'M-09', 'M-08', '2026-07-21', '2026-08-06', 'Low', 'To do'),
  task('T-206', W, 'Design', 'Signage copy review', 'M-09', 'M-03', '2026-07-10', '2026-07-18', 'Low', 'PM approved'),

  // TechNusa Developer Conference — 22 Oct, design uploaded
  task('T-301', C, 'Design', 'Keynote stage design concept', 'M-08', 'M-03', '2026-07-12', '2026-07-26', 'High', 'Submitted'),
  task('T-302', C, 'Production', 'Streaming kit vendor shortlist', 'M-07', 'M-04', '2026-07-15', '2026-07-30', 'Medium', 'In progress'),
  task('T-303', C, 'Production', 'Power distribution plan', 'M-06', 'M-04', '2026-07-20', '2026-08-10', 'Medium', 'To do'),
  task('T-304', C, 'Design', 'Breakout room wayfinding', 'M-09', 'M-03', '2026-07-17', '2026-07-24', 'Medium', 'In progress'),
  task('T-305', C, 'Production', 'LED floor supplier quotes', 'M-07', 'M-04', '2026-07-05', '2026-07-19', 'High', 'Leader approved'),
  task('T-306', C, 'Design', 'Sponsor booth templates', 'M-08', 'M-01', '2026-07-22', '2026-08-15', 'Low', 'To do'),
  task('T-307', C, 'Production', 'Audio test plan', 'M-07', 'M-06', '2026-07-23', '2026-08-20', 'Low', 'To do'),
  task('T-308', C, 'Design', 'Brand guideline intake', 'M-08', 'M-03', '2026-07-01', '2026-07-08', 'Medium', 'PM approved'),
  task('T-309', C, 'Production', 'Truss height clearance check', 'M-06', 'M-04', '2026-07-19', '2026-07-23', 'High', 'Blocked',
    { blockerReason: 'Venue has not shared the ballroom ceiling drawings', blockedOn: '2026-07-21' }),

  // Meridian Product Launch — 30 Jun, finished
  task('T-401', P, 'Field', 'Post-event client survey', 'M-05', 'M-02', '2026-07-01', '2026-07-10', 'Medium', 'PM approved'),
  task('T-402', P, 'Design', 'Photo and video handover pack', 'M-08', 'M-03', '2026-07-02', '2026-07-15', 'Medium', 'Leader approved'),
  task('T-403', P, 'Field', 'Return rented furniture', 'M-05', 'M-02', '2026-07-01', '2026-07-05', 'Low', 'PM approved'),
  task('T-404', P, 'Field', 'Collect vendor feedback forms', 'M-05', 'M-02', '2026-07-08', '2026-07-28', 'Low', 'In progress'),
]

// Files on two tasks (W2). Details only — the prototype keeps no real file contents in the seed.
const SEED_FILES = {
  'T-101': [{ id: 'A-1', name: 'run-of-show-v3-draft.docx', kind: 'docx', size: 184_320, by: 'M-05', at: at('2026-07-24', '15:10') }],
  'T-309': [{ id: 'A-1', name: 'venue-floor-plan-v3.pdf', kind: 'pdf', size: 2_516_582, by: 'M-04', at: at('2026-07-23', '10:05') }],
}
for (const t of seedTasks) {
  if (!SEED_FILES[t.id]) continue
  t.attachments = SEED_FILES[t.id]
  t.activity.push(...SEED_FILES[t.id].map((f) => ({ at: f.at, by: f.by, text: `attached ${f.name}`, kind: 'attach' })))
  t.activity.sort((x, y) => x.at.localeCompare(y.at))
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------
// Message text carries tokens the chat renders: <@M-05> mentions a member, <#T-102> links a
// task. Keeping ids (not names) in the text means a renamed person or task still resolves.

const PROJECT_CHANNELS = [
  [G, 'gala', ['Field', 'Production']],
  [W, 'wedding', ['Design', 'Field']],
  [C, 'devconf', ['Design', 'Production']],
  [P, 'meridian', ['Field', 'Design']],
]

export const seedChannels = [
  // Who may join (CH5, lib/workspaceAccess.js): access 'project' | 'divisions' | 'invite'.
  { id: 'ch-announcements', name: 'announcements', projectId: null, access: 'project', topic: 'Company-wide news. PM and leaders post here.' },
  // Everyone at Oscenia: day-to-day chat, questions, and the Lounge's call log.
  { id: 'ch-general', name: 'general', projectId: null, access: 'project', topic: 'Everyone at Oscenia — questions, chat and the Lounge.' },
  { id: 'ch-leaders', name: 'leaders', projectId: null, access: 'invite', listed: false, topic: 'Division leads and PM only.', memberIds: ['M-01', 'M-02', 'M-03', 'M-04'] },
  ...PROJECT_CHANNELS.flatMap(([projectId, slug, divisions]) => [
    { id: `ch-${slug}-general`, name: 'general', projectId, access: 'project', topic: 'Everyone on the project.' },
    ...divisions.map((d) => ({
      id: `ch-${slug}-${d.toLowerCase()}`, name: d.toLowerCase(), projectId, access: 'divisions', divisions: [d], topic: `${d} team working channel.`,
    })),
  ]),
  // Voice channels (CH3): drop in to talk. No messages of their own — a call held in one is
  // logged in its linked text channel (`textChannelId`). Access follows the channel itself.
  { id: 'vc-lounge', kind: 'voice', name: 'Lounge', projectId: null, access: 'project', textChannelId: 'ch-general', topic: 'Drop in any time.' },
  ...PROJECT_CHANNELS.map(([projectId, slug]) => ({
    id: `vc-${slug}`, kind: 'voice', name: 'Meeting room', projectId, access: 'project', textChannelId: `ch-${slug}-general`, topic: 'Project meetings.',
  })),
]

// A join request waiting for a decision (CH5): Rina (Field) asks into Gala #production, which
// is for the Production division. Hendra (Production lead), Dinda (Field lead) or the PM decide.
seedChannels.find((c) => c.id === 'ch-gala-production').requests = [
  { memberId: 'M-05', at: '2026-07-25T17:30', note: 'I need the rigging schedule for the stage plan.', status: 'pending' },
]

// Who is around (CH3, simulated): online / idle / dnd / invisible / offline. Whoever you view
// as is always shown online to themselves (`presenceOf`, lib/chat.js).
export const seedPresence = {
  'M-01': 'online', 'M-02': 'online', 'M-03': 'idle', 'M-04': 'dnd', 'M-05': 'online',
  'M-06': 'offline', 'M-07': 'online', 'M-08': 'offline', 'M-09': 'idle', 'M-10': 'offline',
}

let msgSeq = 0
const msg = (channelId, authorId, when, text, extra = {}) => ({
  id: `MSG-${String(++msgSeq).padStart(3, '0')}`, channelId, authorId, at: when, text,
  reactions: {}, parentId: null, editedAt: null, deleted: false, ...extra,
})

export const seedMessages = [
  msg('ch-announcements', 'M-01', at('2026-07-20', '08:30'), 'Morning all. From this week, please log every blocker on the task itself so it shows up on the Blocked board — not only in chat.', { reactions: { '👍': ['M-02', 'M-03', 'M-04', 'M-05'] } }),
  msg('ch-announcements', 'M-01', at('2026-07-24', '17:05'), 'Aurora Gala is 3 weeks out. <@M-02> <@M-04> please review open items with your teams on Monday.'),
  msg('ch-leaders', 'M-04', at('2026-07-23', '10:12'), 'Heads-up: <#T-309> will slip unless the venue sends the ceiling drawings this week.'),
  msg('ch-leaders', 'M-01', at('2026-07-23', '10:40'), 'I’ll call the venue GM today.'),

  msg('ch-gala-general', 'M-02', at('2026-07-22', '09:15'), 'Client confirmed the stage layout. Run-of-show v3 in progress — <#T-101>.'),
  msg('ch-gala-general', 'M-05', at('2026-07-22', '09:32'), 'Noted. I’ll share a draft with <@M-10> for the seating side by Friday.'),
  msg('ch-gala-general', 'M-10', at('2026-07-24', '16:20'), 'Seating plan submitted for approval: <#T-103>', { reactions: { '🙌': ['M-05'] } }),
  msg('ch-gala-production', 'M-06', at('2026-07-20', '14:02'), 'Still no logo files from Aurora. Marked <#T-102> as blocked.'),
  msg('ch-gala-production', 'M-04', at('2026-07-20', '14:20'), '<@M-06> thanks — I’ve asked <@M-02> to chase the client comms team.'),
  msg('ch-gala-field', 'M-02', at('2026-07-24', '11:00'), 'Catering needs a headcount. We can’t lock it until RSVP closes on 1 Aug — see <#T-108>.'),

  msg('ch-wedding-general', 'M-03', at('2026-07-22', '11:20'), 'Sent back the arch render — too tall for the pendopo. <@M-09> please keep it under 3 m.'),
  msg('ch-wedding-general', 'M-09', at('2026-07-22', '11:34'), 'On it, will resubmit by Wednesday.', { reactions: { '👍': ['M-03'] } }),
  msg('ch-wedding-design', 'M-08', at('2026-07-25', '15:48'), 'Moodboard rev 2 is up for approval: <#T-201>. Warmer palette as the family asked.'),

  msg('ch-devconf-general', 'M-03', at('2026-07-25', '09:05'), 'Keynote concept is in <#T-301>. Feedback welcome before I pass it to Agus.'),
  msg('ch-devconf-production', 'M-07', at('2026-07-24', '13:30'), 'Three streaming vendors shortlisted so far. Will add the quotes to <#T-302>.'),
  msg('ch-devconf-design', 'M-09', at('2026-07-25', '10:10'), 'Wayfinding is taking longer than planned — the floor plan changed. <@M-03> can we move the deadline?'),

  msg('ch-meridian-general', 'M-05', at('2026-07-21', '16:00'), 'Survey results are in: 4.2 / 5 overall. Full summary attached to <#T-401>.'),
]

// A quoted reply in the main chat (CH1): Rina answers Dinda's catering note with a quote.
seedMessages.push(msg('ch-gala-field', 'M-05', at('2026-07-24', '11:20'), 'Venue can hold the catering order until 3 Aug if we send a provisional count now — I’ll send 220.', {
  quoteId: seedMessages.find((m) => m.channelId === 'ch-gala-field').id,
}))
// A finished group call (CH2), logged in the channel.
seedMessages.push(msg('ch-gala-general', 'M-02', at('2026-07-24', '16:45'), 'Video call · 18 min · Dinda A., Rina M., Hendra T.', { kind: 'call', meetingId: 'MTG-1' }))
// A second meeting (CH4), in TechNusa #design, whose minutes are open to the whole channel.
seedMessages.push(msg('ch-devconf-design', 'M-03', at('2026-07-25', '11:12'), 'Video call · 12 min · Maya S., Putri L., Kevin W.', { kind: 'call', meetingId: 'MTG-2' }))

// Meeting records (CH4) behind those two call lines. MTG-1 is open to its participants only, so
// Yoga K. (on the project, not on the call) sees "Minutes restricted" while Dinda reads them.
// MTG-2 is open to the channel and has no summary yet — the one to try "Generate" on.
const meeting = (id, channelId, hostId, participantIds, startedAt, endedAt, projectName, extra) => {
  const base = {
    id, channelId, logChannelId: channelId, dm: false, video: true, startedAt, endedAt, hostId, participantIds,
    transcript: simulateTranscript({ participantIds, hostId, startedAt, endedAt }, projectName),
    notes: [], files: [], access: { mode: 'participants', extraIds: [] }, filesViewOnly: false, summary: null, ...extra,
  }
  return base
}
const mtg1 = meeting('MTG-1', 'ch-gala-general', 'M-02', ['M-02', 'M-05', 'M-04'], at('2026-07-24', '16:27'), at('2026-07-24', '16:45'), 'Aurora Bank Annual Gala', {
  notes: [{ id: 'N-1', by: 'M-05', at: at('2026-07-24', '16:33'), text: 'Venue load-in window still unconfirmed — get it in writing.' }],
  files: [{ id: 'F-1', name: 'Run-of-show-v3.pdf', kind: 'pdf', size: 184320, by: 'M-02', at: at('2026-07-24', '16:30') }],
})
mtg1.summary = { ...demoMinutes(mtg1, seedMembers, 'Aurora Bank Annual Gala'), source: 'seeded', provider: null, model: null, at: at('2026-07-24', '16:50'), by: 'M-02' }
export const seedMeetings = [
  mtg1,
  meeting('MTG-2', 'ch-devconf-design', 'M-03', ['M-03', 'M-08', 'M-09'], at('2026-07-25', '11:00'), at('2026-07-25', '11:12'), 'TechNusa Developer Conference', {
    access: { mode: 'channel', extraIds: [] },
    notes: [{ id: 'N-1', by: 'M-08', at: at('2026-07-25', '11:06'), text: 'Wayfinding signs: reuse last year’s icon set.' }],
  }),
]

// Direct messages (CH2): a channel for exactly two people.
seedChannels.push(
  { id: 'dm-M-01-M-05', dm: true, memberIds: ['M-01', 'M-05'], name: '', projectId: null },
  { id: 'dm-M-02-M-05', dm: true, memberIds: ['M-02', 'M-05'], name: '', projectId: null },
)
seedMessages.push(
  msg('dm-M-01-M-05', 'M-01', at('2026-07-25', '18:10'), 'Rina, great work on the run-of-show. Can you take the client walkthrough on Tuesday?'),
  msg('dm-M-01-M-05', 'M-05', at('2026-07-25', '18:22'), 'Yes, happy to. I’ll bring the seating draft too.'),
  msg('dm-M-02-M-05', 'M-02', at('2026-07-26', '08:40'), 'Quick one — are you free for a call at 10 about the stage manager brief?'),
)

// A reply to Kevin's deadline question, quoting it in the main chat. (Until round 3 this was a
// thread reply; threads are gone from the chat, and saved copies of it still show as a quote.)
seedMessages.push(msg('ch-devconf-design', 'M-03', at('2026-07-25', '10:25'), 'Yes — take until 30 Jul, and log the floor-plan change on the task.', {
  quoteId: seedMessages.find((m) => m.channelId === 'ch-devconf-design' && m.authorId === 'M-09' && !m.kind).id,
}))
// Company #general (added last, so the earlier message numbers stay as they were).
seedMessages.push(msg('ch-general', 'M-01', at('2026-07-21', '09:00'), 'Welcome to #general — for everyday questions and chat. #announcements stays for company news. The Lounge voice channel is open any time.'))

// ---------------------------------------------------------------------------
// Events, invitations and guests
// ---------------------------------------------------------------------------

const FIRST = ['Andi', 'Budi', 'Citra', 'Dewi', 'Eko', 'Fitri', 'Gilang', 'Hana', 'Indra', 'Joko', 'Kartika', 'Lukas',
  'Mega', 'Nanda', 'Oki', 'Putu', 'Rahul', 'Sari', 'Teguh', 'Utari', 'Vina', 'Wahyu', 'Yudi', 'Zahra', 'Arif', 'Bella',
  'Dimas', 'Elsa', 'Fajar', 'Galih', 'Intan', 'Kevin', 'Laras', 'Made', 'Novi', 'Raka', 'Siti', 'Tommy', 'Wulan', 'Yosef']
const LAST = ['Santoso', 'Wijaya', 'Pratama', 'Halim', 'Kusuma', 'Saputra', 'Lestari', 'Gunawan', 'Tan', 'Nugroho',
  'Hartono', 'Siregar', 'Tanoto', 'Wibisono', 'Susanto', 'Rahman', 'Setiawan', 'Purnama', 'Chandra', 'Hidayat']
const ALLERGIES = ['', '', '', '', 'Peanuts', '', 'Vegetarian', '', 'Seafood', '', '', 'Gluten-free', '', 'Halal only', '']

// Deterministic guest `n` of an event: same name, phone and email on every load. Names repeat
// every 40 values of n, so the seed keeps n within 0–39: Gala uses 3–32 and 39, Meridian
// 11–38 and 0–2. The overlap (11–32) is deliberate — the same people at two events, which is
// what the CRM's de-duplicated contact list has to cope with.
function person(n, domain) {
  const first = FIRST[n % FIRST.length]
  const last = LAST[(n * 7) % LAST.length]
  const phone = `+62 81${(n * 37) % 10}-${String(1000 + ((n * 7919) % 9000))}-${String(1000 + ((n * 104729) % 9000))}`
  return { name: `${first} ${last}`, phone, email: `${first}.${last}@${domain}`.toLowerCase() }
}

// A fixed personal-link key per seed guest, so demo links keep working across reloads.
const seedToken = (id) => ((Number(id.slice(2)) * 2654435761) % 2176782336).toString(36).padStart(6, '0')

let guestSeq = 0
function guest(eventId, n, domain, fields) {
  const id = `G-${String(++guestSeq).padStart(3, '0')}`
  return {
    id,
    eventId,
    token: seedToken(id),
    category: 'Regular', // 'VIP' | 'Media' | 'Regular' | 'Vendor'
    note: '', // staff-only, e.g. why a guest did not come
    noteBy: null,
    noteAt: null,
    answers: {}, // custom RSVP questions (R7): { [questionId]: string | string[] }
    ...person(n, domain),
    onMasterList: true,
    rsvp: null, // 'Attending' | 'Declined' | null (no response)
    pax: 0,
    allergies: '',
    consent: false,
    consentAt: null,
    respondedAt: null,
    table: '',
    checkedInAt: null,
    walkIn: false,
    invitedAt: null, // when the invitation last went out (Invitations v2, D9)
    invitedVia: null, // 'platform' (Oscenia sent it) | 'client' (the client sent it themselves)
    ...fields,
  }
}

const GALA_INVITED_AT = at('2026-07-20', '10:00')

const GALA_TABLES = ['VIP 1', 'VIP 2', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']

// Aurora Gala (upcoming): 30 on the client's list — 18 attending, 4 declined, 8 not yet
// responded — plus one guest who RSVP'd from a forwarded link.
function galaGuests() {
  const list = []
  for (let i = 0; i < 30; i++) {
    const n = i + 3
    if (i < 18) {
      list.push(guest('EV-01', n, i % 3 ? 'gmail.com' : 'aurorabank.co.id', {
        rsvp: 'Attending', pax: i % 4 === 0 ? 2 : 1, allergies: ALLERGIES[i % ALLERGIES.length],
        consent: i % 3 !== 1, consentAt: i % 3 !== 1 ? at(addDays('2026-07-21', i % 5), '20:15') : null,
        respondedAt: at(addDays('2026-07-21', i % 5), '20:15'), table: GALA_TABLES[i % GALA_TABLES.length],
      }))
    } else if (i < 22) {
      list.push(guest('EV-01', n, 'gmail.com', { rsvp: 'Declined', respondedAt: at('2026-07-23', '12:00') }))
    } else {
      list.push(guest('EV-01', n, 'gmail.com'))
    }
  }
  list.push(guest('EV-01', 39, 'yahoo.com', {
    onMasterList: false, rsvp: 'Attending', pax: 1, consent: true,
    consentAt: at('2026-07-25', '19:40'), respondedAt: at('2026-07-25', '19:40'),
  }))
  // Everyone seated at a VIP table is VIP; a few press guests and one supplier among the rest.
  // Answers to the Gala's own questions (see seedEvents), for everyone who accepted.
  const MEALS = ['Beef', 'Fish', 'Vegetarian', 'Fish', 'Beef']
  const SONGS = ['September — Earth, Wind & Fire', '', '', 'Bengawan Solo', '', 'Fly Me to the Moon', '']
  list.filter((g) => g.rsvp === 'Attending').forEach((g, i) => {
    g.answers = { 'Q-1': MEALS[i % MEALS.length], 'Q-2': i % 3 === 0 ? 'Yes' : 'No' }
    if (SONGS[i % SONGS.length]) g.answers['Q-3'] = SONGS[i % SONGS.length]
  })
  list.forEach((g, i) => {
    if (g.table.startsWith('VIP')) g.category = 'VIP'
    else if ([5, 13, 25].includes(i)) g.category = 'Media'
    else if (i === 11) g.category = 'Vendor'
  })
  // The client's file had no email for one guest: the seed invitation reached them on
  // WhatsApp only, and its email row shows as failed.
  list[29].email = ''
  // Everyone on the list was sent the invitation on 20 Jul (the seed broadcast, BC-1).
  list.filter((g) => g.onMasterList).forEach((g) => Object.assign(g, { invitedAt: GALA_INVITED_AT, invitedVia: 'platform' }))
  return list
}

// Meridian launch (past, 30 Jun): 28 on the list. 20 attending (16 came, 4 no-shows),
// 2 declined, 6 never responded (2 came anyway), plus 3 walk-ins not on the list — every
// cell of the reconciliation grid has people in it.
function meridianGuests() {
  const list = []
  for (let i = 0; i < 28; i++) {
    const n = i + 11
    const came = (hh) => at('2026-06-30', hh)
    if (i < 20) {
      list.push(guest('EV-02', n, i % 2 ? 'gmail.com' : 'meridian.com', {
        rsvp: 'Attending', pax: 1, allergies: ALLERGIES[(i + 3) % ALLERGIES.length],
        consent: i % 4 !== 0, consentAt: i % 4 !== 0 ? at('2026-06-18', '09:00') : null,
        respondedAt: at('2026-06-18', '09:00'), table: `T${(i % 5) + 1}`,
        checkedInAt: i < 16 ? came(`18:${String(10 + i * 2).padStart(2, '0')}`) : null,
      }))
    } else if (i < 22) {
      list.push(guest('EV-02', n, 'gmail.com', { rsvp: 'Declined', respondedAt: at('2026-06-20', '10:00') }))
    } else {
      list.push(guest('EV-02', n, 'gmail.com', { checkedInAt: i < 24 ? came('19:05') : null }))
    }
  }
  for (let k = 0; k < 3; k++) {
    list.push(guest('EV-02', k, 'gmail.com', {
      onMasterList: false, walkIn: true, pax: 1, consent: k !== 2,
      consentAt: k !== 2 ? at('2026-06-30', `19:1${k}`) : null, checkedInAt: at('2026-06-30', `19:1${k}`),
    }))
  }
  const INTERESTS = [['Lipstick'], ['Skincare', 'Fragrance'], ['Skincare'], ['Lipstick', 'Skincare', 'Fragrance'], ['Fragrance']]
  list.filter((g) => g.rsvp === 'Attending').forEach((g, i) => { g.answers = { 'Q-1': INTERESTS[i % INTERESTS.length] } })
  list.forEach((g, i) => {
    if ([3, 9, 17].includes(i)) g.category = 'Media'
    else if (i === 12) g.category = 'Vendor'
  })
  // Follow-up on two of the four who said yes and did not come (R5).
  Object.assign(list[16], { note: 'Called 1 Jul — flight from Surabaya was delayed. Send the launch kit by courier.', noteBy: 'Rina M.', noteAt: at('2026-07-01', '10:20') })
  Object.assign(list[17], { note: 'Beauty editor, sick on the day. Offer a private preview.', noteBy: 'Agus P.', noteAt: at('2026-07-01', '11:05') })
  return list
}

export const seedGuests = [...galaGuests(), ...meridianGuests()]

// Every scan at an event's checkpoints (R1). The Meridian launch is over: each arrival was
// scanned at the entrance, and most collected a goodie bag on the way out.
export const seedScans = (() => {
  const scans = []
  const add = (g, checkpointId, when) => scans.push({ id: `SC-${String(scans.length + 1).padStart(3, '0')}`, eventId: g.eventId, guestId: g.id, checkpointId, at: when })
  const came = seedGuests.filter((g) => g.eventId === 'EV-02' && g.checkedInAt)
  came.forEach((g) => add(g, 'CP-1', g.checkedInAt))
  came.filter((_, i) => i % 4 !== 3).forEach((g, i) => add(g, 'CP-2', at('2026-06-30', `21:${String(10 + i).padStart(2, '0')}`)))
  return scans
})()

const REMINDER_ATTENDING = 'Hi {name}, a friendly reminder that {event} is on {date} at {venue}. Please show your QR code at the registration desk. See you there!'
const REMINDER_PENDING = 'Hi {name}, we have not received your RSVP for {event} on {date} yet. Please let us know here: {link}'
export const FOLLOW_UP_THANKS = 'Thank you for joining us at {event}, {name}! We would love to hear how it went: {feedback}'

const legacyEvents = [
  {
    id: 'EV-01',
    name: 'Aurora Bank Annual Gala 2026',
    clientId: 'CL-01',
    projectId: 'EVT-2026-GALA-01',
    date: '2026-08-14',
    time: '19:00',
    venue: 'The Ritz-Carlton Jakarta, Mega Kuningan — Grand Ballroom',
    rsvpDeadline: '2026-08-01',
    status: 'Published',
    editToken: 'aurora-7f2k',
    design: {
      paletteId: 'midnight-gold',
      fontPairId: 'classic',
      heroPreset: 'aurora',
      heroImage: null,
      eyebrow: 'You are cordially invited',
      headline: 'An Evening of Gratitude',
      subheadline: 'Aurora Bank Annual Gala 2026',
      body: 'Join us as we celebrate a remarkable year with the partners and friends who made it possible.',
      schedule: [
        { time: '18:30', label: 'Arrival & cocktails' },
        { time: '19:30', label: 'Welcome address' },
        { time: '20:00', label: 'Dinner & performances' },
      ],
      dressCode: 'Black tie',
      mapUrl: 'https://maps.google.com/?q=Ritz-Carlton+Mega+Kuningan',
    },
    rsvpFields: { email: true, allergies: true, pax: true },
    maxPax: 2,
    tables: GALA_TABLES,
    feedbackUrl: 'https://forms.gle/aurora-gala-2026',
    customFields: [
      { id: 'Q-1', label: 'Meal preference', type: 'dropdown', options: ['Beef', 'Fish', 'Vegetarian'], multi: false, required: true, attendingOnly: true },
      { id: 'Q-2', label: 'Will you take the shuttle from Senayan?', type: 'choice', options: ['Yes', 'No'], multi: false, required: false, attendingOnly: true },
      { id: 'Q-3', label: 'A song you would love to hear', type: 'text', options: [], multi: false, required: false, attendingOnly: true },
    ],
    checkpoints: [
      { id: 'CP-1', name: 'Main Entrance', categories: [] },
      { id: 'CP-2', name: 'VIP Lounge', categories: ['VIP'] },
      { id: 'CP-3', name: 'Goodie Bag', categories: [] },
    ],
    reminders: [
      { id: 'R-1', when: 'before', daysBefore: 10, audience: 'pending', channel: 'both', template: REMINDER_PENDING, active: true },
      { id: 'R-2', when: 'before', daysBefore: 7, audience: 'attending', channel: 'whatsapp', template: REMINDER_ATTENDING, active: true },
      { id: 'R-3', when: 'before', daysBefore: 3, audience: 'attending', channel: 'both', template: REMINDER_ATTENDING, active: true },
      { id: 'R-4', when: 'after', daysBefore: 1, audience: 'attended', channel: 'both', template: FOLLOW_UP_THANKS, active: false },
    ],
    sendLog: [
      { id: 'SL-1', at: at('2026-07-20', '10:00'), label: 'Invitation', channel: 'both', audience: 'master list', count: 30 },
    ],
  },
  {
    id: 'EV-02',
    name: 'Meridian Rose Collection Launch',
    clientId: 'CL-03',
    projectId: 'EVT-2026-PROD-04',
    date: '2026-06-30',
    time: '18:00',
    venue: 'Hotel Mulia Senayan — The Grand Ballroom',
    rsvpDeadline: '2026-06-23',
    status: 'Published',
    editToken: 'meridian-3q9d',
    design: {
      paletteId: 'blush-rose',
      fontPairId: 'romantic',
      heroPreset: 'rose',
      heroImage: null,
      eyebrow: 'Meridian Cosmetics presents',
      headline: 'The Rose Collection',
      subheadline: 'An exclusive launch evening',
      body: 'Be among the first to discover our new collection, with live demonstrations and a champagne reception.',
      schedule: [
        { time: '18:00', label: 'Reception' },
        { time: '19:00', label: 'Collection reveal' },
        { time: '20:00', label: 'Dinner' },
      ],
      dressCode: 'Cocktail — a touch of rose',
      mapUrl: 'https://maps.google.com/?q=Hotel+Mulia+Senayan',
    },
    rsvpFields: { email: true, allergies: true, pax: false },
    maxPax: 1,
    tables: ['T1', 'T2', 'T3', 'T4', 'T5'],
    feedbackUrl: 'https://forms.gle/meridian-rose-launch',
    customFields: [
      { id: 'Q-1', label: 'Which products interest you?', type: 'choice', options: ['Lipstick', 'Skincare', 'Fragrance'], multi: true, required: false, attendingOnly: true },
    ],
    checkpoints: [
      { id: 'CP-1', name: 'Main Entrance', categories: [] },
      { id: 'CP-2', name: 'Goodie Bag', categories: [] },
    ],
    reminders: [
      { id: 'R-1', when: 'before', daysBefore: 3, audience: 'attending', channel: 'both', template: REMINDER_ATTENDING, active: true },
      { id: 'R-2', when: 'after', daysBefore: 1, audience: 'attended', channel: 'both', template: FOLLOW_UP_THANKS, active: true },
    ],
    sendLog: [
      { id: 'SL-1', at: at('2026-06-10', '10:00'), label: 'Invitation', channel: 'both', audience: 'master list', count: 28 },
      { id: 'SL-2', at: at('2026-06-27', '09:00'), label: 'D-3 reminder', channel: 'both', audience: 'attending', count: 20 },
      { id: 'SL-3', at: at('2026-07-01', '10:00'), label: 'D+1 follow-up', channel: 'both', audience: 'came', count: 21 },
    ],
  },
]

// The two seed events on the v2 templates (D12): the Gala on Gala, the launch on Launch. Both
// are live, so the draft and the published copy start identical.
const SEED_EXTRAS = {
  'EV-01': { templateId: 'gala', hosts: 'Hosted by Aurora Bank · Jakarta' },
  'EV-02': { templateId: 'launch', hosts: 'Presented by Meridian Cosmetics' },
}
const SEED_WISHES = {
  'EV-01': [
    { id: 'W-1', guestId: 'G-001', name: 'Dewi Wijaya', text: 'Congratulations on a wonderful year — looking forward to the evening!', at: at('2026-07-21', '20:20'), hidden: false, approved: true },
    { id: 'W-2', guestId: 'G-004', name: 'Gilang Pratama', text: 'Thank you for having us. See you at the Ritz!', at: at('2026-07-22', '09:05'), hidden: false, approved: true },
    { id: 'W-3', guestId: null, name: 'A friend', text: 'Cheers to Aurora Bank 🎉', at: at('2026-07-24', '13:40'), hidden: false, approved: true },
  ],
  'EV-02': [],
}

// The Gala's invitation went out from the platform on 20 Jul, by WhatsApp and email, to the
// whole list (its send log entry SL-1). The Launch predates Send invitations.
const SEED_BROADCASTS = {
  'EV-01': [{
    id: 'BC-1', mode: 'platform', channel: 'both', subject: DEFAULT_INVITE_SUBJECT, message: DEFAULT_INVITE_MESSAGE,
    audience: 'all', scheduledAt: null, createdAt: GALA_INVITED_AT, by: 'Agus P.', status: 'sent', sentAt: GALA_INVITED_AT,
    recipients: recipientRows(seedGuests.filter((g) => g.eventId === 'EV-01' && g.onMasterList), 'both', GALA_INVITED_AT),
  }],
}

export const seedEvents = legacyEvents.map(({ design, ...ev }) => {
  const x = SEED_EXTRAS[ev.id]
  const invite = fromLegacyDesign(ev, design, x.templateId)
  invite.content.hosts.names = x.hosts
  // The Gala opens to its built-in track, so the demo plays music without an upload.
  invite.on = ev.id === 'EV-01' ? { hosts: true, music: true } : { hosts: true }
  if (ev.id === 'EV-01') invite.content.music = { kind: 'builtin', trackId: 'warm-strings', file: null }
  invite.content.details = { ...invite.content.details, date: ev.date, time: ev.time, venue: ev.venue }
  return {
    ...ev,
    invite,
    published: structuredClone(invite),
    review: { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
    holdWishes: false,
    wishes: SEED_WISHES[ev.id],
    broadcasts: SEED_BROADCASTS[ev.id] || [],
  }
}).concat({
  // A wedding not yet designed: no template, so it opens on the gallery. For the Royal /
  // Minimal / Garden demo, and the client start link.
  id: 'EV-03',
  name: 'Wibowo–Sari Wedding',
  clientId: 'CL-04',
  projectId: 'EVT-2026-WED-02',
  date: '2026-09-05',
  time: '10:00',
  venue: 'Gereja Santa Theresia, Menteng',
  rsvpDeadline: '2026-08-22',
  status: 'Draft',
  editToken: 'wibowo-5h2m',
  invite: blankInvite({ name: 'Wibowo–Sari Wedding', date: '2026-09-05', time: '10:00', venue: 'Gereja Santa Theresia, Menteng' }),
  published: null,
  review: { state: 'editing', submittedAt: null, submittedBy: null, note: '', returnedAt: null },
  holdWishes: false,
  wishes: [],
  broadcasts: [],
  rsvpFields: { email: true, allergies: true, pax: true },
  maxPax: 2,
  tables: ['T1', 'T2', 'T3', 'T4', 'T5'],
  feedbackUrl: '',
  customFields: [],
  checkpoints: [{ id: 'CP-1', name: 'Main Entrance', categories: [] }],
  reminders: [],
  sendLog: [],
})

// Delivery beside each purchase order's accounting status (V1). Keyed by PO number; the POs
// themselves live in the ERP store (seed.js) and are not changed.
export const seedPoDelivery = {
  'PO-3001': { status: 'Delivered', at: '2026-06-17T14:00', by: 'Hendra T.' },
  'PO-3002': { status: 'Delivered', at: '2026-07-09T11:30', by: 'Hendra T.' },
  'PO-3003': { status: 'In progress', at: '2026-07-22T09:15', by: 'Yoga K.' },
}

// What a connected Google Calendar would show (C2, simulated): the sales team's own meetings
// around the demo date, beside the CRM's dates.
export const seedGoogleEvents = [
  { id: 'GE-1', date: '2026-07-27', time: '09:00', title: 'Weekly sales sync' },
  { id: 'GE-2', date: '2026-07-28', time: '12:30', title: 'Lunch with Ibu Ratna (Aurora Bank)' },
  { id: 'GE-3', date: '2026-07-30', time: '15:00', title: 'Site visit — Ritz-Carlton ballroom' },
  { id: 'GE-4', date: '2026-08-03', time: '09:00', title: 'Weekly sales sync' },
  { id: 'GE-5', date: '2026-08-05', time: '10:00', title: 'TechNusa year-end brief (call)' },
  { id: 'GE-6', date: '2026-08-10', time: '09:00', title: 'Weekly sales sync' },
  { id: 'GE-7', date: '2026-08-12', time: '14:00', title: 'Gala rehearsal with AV vendor' },
  { id: 'GE-8', date: '2026-08-17', time: '09:00', title: 'Weekly sales sync' },
  { id: 'GE-9', date: '2026-08-20', time: '16:00', title: 'Meridian Q4 launch — first meeting' },
  { id: 'GE-10', date: '2026-08-24', time: '09:00', title: 'Weekly sales sync' },
  { id: 'GE-11', date: '2026-09-02', time: '11:00', title: 'Keluarga Wibowo — venue shortlist' },
  { id: 'GE-12', date: '2026-09-07', time: '09:00', title: 'Weekly sales sync' },
]

// ---------------------------------------------------------------------------
// CRM relationship layer
// ---------------------------------------------------------------------------
// Extends seedClients (seed.js) without changing it: several PICs per company, greeting
// settings, and each company's recurring events so the system can nudge ahead of the next one.
// `history` lists the YYYY-MM each edition ran.

export const seedRelations = {
  'CL-01': {
    pics: [
      { id: 'P-011', name: 'Ibu Ratna', role: 'Head of Corporate Communications', phone: '+62 812-1100-2200', email: 'ratna@aurorabank.co.id', birthday: '07-28', greet: true, channel: 'both' },
      { id: 'P-012', name: 'Pak Surya', role: 'Events Coordinator', phone: '+62 812-4455-7788', email: 'surya@aurorabank.co.id', birthday: '08-19', greet: true, channel: 'whatsapp' },
    ],
    anniversary: '2019-03-01',
    greetAnniversary: true,
    anniversaryChannel: 'both',
    nudgeLeadMonths: 3,
    cycles: [
      { name: 'Annual Gala', history: ['2024-08', '2025-08', '2026-08'] },
      { name: 'Year-end Town Hall', history: ['2024-11', '2025-11'] },
    ],
  },
  'CL-02': {
    pics: [
      { id: 'P-021', name: 'Pak Aditya', role: 'Developer Relations Lead', phone: '+62 811-3040-5060', email: 'aditya@technusa.io', birthday: '08-02', greet: true, channel: 'both' },
    ],
    anniversary: '2021-11-09',
    greetAnniversary: true,
    anniversaryChannel: 'email',
    nudgeLeadMonths: 3,
    cycles: [
      { name: 'Developer Conference', history: ['2025-10', '2026-10'] },
      { name: 'Product Launch', history: ['2024-08', '2025-08'] },
    ],
  },
  'CL-03': {
    pics: [
      { id: 'P-031', name: 'Ibu Clara', role: 'Brand Director', phone: '+62 813-7788-9900', email: 'clara@meridian.com', birthday: '12-15', greet: true, channel: 'both' },
      { id: 'P-032', name: 'Mbak Tasya', role: 'Marketing Executive', phone: '+62 813-2211-6655', email: 'tasya@meridian.com', birthday: '09-10', greet: true, channel: 'whatsapp' },
    ],
    anniversary: '2020-05-20',
    greetAnniversary: true,
    anniversaryChannel: 'both',
    nudgeLeadMonths: 3,
    cycles: [
      { name: 'Product Launch', history: ['2024-06', '2026-06'] },
    ],
  },
  'CL-04': {
    pics: [
      { id: 'P-041', name: 'Bpk. Wibowo', role: 'Father of the bride', phone: '+62 815-2233-4455', email: 'wibowo.family@gmail.com', birthday: '07-30', greet: true, channel: 'whatsapp' },
    ],
    anniversary: null,
    greetAnniversary: false,
    anniversaryChannel: 'whatsapp',
    nudgeLeadMonths: 3,
    cycles: [],
  },
}

export const seedGreetingLog = [
  { id: 'GL-1', at: at('2026-03-01', '08:00'), clientId: 'CL-01', kind: 'Company anniversary', to: 'Aurora Bank', channel: 'whatsapp' },
  { id: 'GL-2', at: at('2026-05-20', '08:00'), clientId: 'CL-03', kind: 'Company anniversary', to: 'Meridian Cosmetics', channel: 'both' },
]

// Vendor lifecycle (V2). Keyed by vendor id; the vendors themselves live in the ERP store
// (seed.js) and are not changed. Four suppliers are trading; BrightRig is still being vetted —
// its agreement and reference check are outstanding, so it cannot be approved yet (and its PO
// is still a draft).
const stageRow = (stage, at, by, reason) => ({ stage, at, by, ...(reason ? { reason } : {}) })
const trading = (approvedAt, activeAt, checks = { reference: true }) => ({
  stage: 'Active', at: activeAt, by: 'Finance',
  checks,
  history: [
    stageRow('Prospect', '2026-01-08T10:00', 'Agus P.'),
    stageRow('Onboarding', '2026-01-12T09:30', 'Agus P.'),
    stageRow('Approved', approvedAt, 'Finance'),
    stageRow('Active', activeAt, 'Finance'),
  ],
})
export const seedVendorStages = {
  'V-01': trading('2026-01-20T11:00', '2026-02-02T09:00'),
  'V-02': trading('2026-02-03T14:00', '2026-02-18T10:00'),
  'V-03': trading('2026-02-10T15:30', '2026-03-01T09:00'),
  // Bloom & Co's signed MoU is held on paper, so the agreement is ticked by hand.
  'V-04': trading('2026-03-04T10:00', '2026-03-20T13:00', { reference: true, agreement: true }),
  'V-05': {
    stage: 'Onboarding', at: '2026-07-14T16:20', by: 'Agus P.',
    checks: {},
    history: [
      stageRow('Prospect', '2026-07-02T09:00', 'Agus P.'),
      stageRow('Onboarding', '2026-07-14T16:20', 'Agus P.'),
    ],
  },
}
