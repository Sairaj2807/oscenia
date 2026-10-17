// Who sees and does what in the project workspace and team chat (BRD §2.2, v0.2).
//
// Deliberately separate from lib/roles.js. Those roles decide which *modules* an ERP login
// can open; inside the workspace the question is different — which projects, tasks and
// channels one person on the team can reach — and it depends on their project persona:
//
//   PM        every project and task; assigns anyone; gives the final (stage 2) approval
//   Leader    projects their division works on; tasks in their division or that they
//             assigned; assigns anyone in their division (who then joins the project);
//             gives the first (stage 1) approval
//   Staff     projects they are a member of, and every task in them; assigns to members
//             of their own projects; approves nothing
//   Intern    projects they are a member of (possibly several), their own tasks only;
//             assigns nothing, approves nothing
//
// Only the assignee submits their own task. The PM and leaders can start, block or reassign
// it, but not submit on someone's behalf — so the approvers stay separate from the work.
//
// Pure functions over plain data so the same rules can move server-side unchanged.

export const WORKSPACE_ROLES = {
  pm: 'Project Manager',
  leader: 'Division Leader',
  staff: 'Staff',
  intern: 'Intern',
}

export const TASK_STATUSES = ['To do', 'In progress', 'Blocked', 'Submitted', 'Leader approved', 'PM approved']

// Tasks that still need someone to act. A PM-approved task is done.
export const OPEN_STATUSES = ['To do', 'In progress', 'Blocked', 'Submitted', 'Leader approved']

/** Project ids this member works on. */
export function memberProjectIds(member, projectDivisions) {
  if (!member) return []
  if (member.workspaceRole === 'pm') return Object.keys(projectDivisions)
  if (member.workspaceRole === 'leader') {
    return Object.keys(projectDivisions).filter((pid) => projectDivisions[pid].includes(member.division))
  }
  return member.projectIds || []
}

export function visibleProjects(member, projects, projectDivisions) {
  const ids = memberProjectIds(member, projectDivisions)
  return projects.filter((p) => ids.includes(p.id))
}

export function canSeeTask(member, task, projectDivisions) {
  if (!member) return false
  switch (member.workspaceRole) {
    case 'pm':
      return true
    case 'leader':
      return task.division === member.division || task.assignedById === member.id
    case 'staff':
      return memberProjectIds(member, projectDivisions).includes(task.projectId)
    case 'intern':
      return task.assigneeId === member.id
    default:
      return false
  }
}

export function visibleTasks(member, tasks, projectDivisions) {
  return tasks.filter((t) => canSeeTask(member, t, projectDivisions))
}

/** Team members `member` may assign a task to on `projectId`. Empty = cannot assign. */
export function assignableMembers(member, projectId, members, projectDivisions) {
  if (!member) return []
  const onProject = (m) => memberProjectIds(m, projectDivisions).includes(projectId)
  switch (member.workspaceRole) {
    case 'pm':
      // Anyone doing the work on the project; the PM oversees rather than takes tasks.
      return members.filter((m) => onProject(m) && m.workspaceRole !== 'pm')
    case 'leader':
      // Anyone in their division, on the project yet or not — assigning adds them to it.
      if (!onProject(member)) return []
      return members.filter((m) => m.division === member.division && m.workspaceRole !== 'pm')
    case 'staff':
      // Peers and interns on their own projects — not upward to a leader or the PM.
      if (!onProject(member)) return []
      return members.filter((m) => onProject(m) && ['staff', 'intern'].includes(m.workspaceRole))
    default:
      return []
  }
}

export function canAssign(member, projectId, members, projectDivisions) {
  return assignableMembers(member, projectId, members, projectDivisions).length > 0
}

/**
 * Which approval `member` can give on `task` right now: 'leader', 'pm', or null.
 * Two stages in sequence — the Division Leader first, then the PM. Nobody approves their own
 * work: a task the division's leader is doing themselves skips stage 1 and goes to the PM.
 */
export function approvalStage(member, task, members) {
  if (!member || member.id === task.assigneeId) return null
  const assignee = members.find((m) => m.id === task.assigneeId)
  const leaderIsAssignee = assignee?.workspaceRole === 'leader' && assignee.division === task.division
  if (task.status === 'Submitted') {
    if (member.workspaceRole === 'leader' && member.division === task.division) return 'leader'
    if (member.workspaceRole === 'pm' && leaderIsAssignee) return 'pm'
  }
  if (task.status === 'Leader approved' && member.workspaceRole === 'pm') return 'pm'
  return null
}

/** The person on a task may move it along; so may whoever assigned it, and the PM. */
export function canWorkOn(member, task) {
  if (!member) return false
  return member.workspaceRole === 'pm' || task.assigneeId === member.id || task.assignedById === member.id
}

/** Only the person doing the task submits it for approval. */
export function canSubmit(member, task) {
  return !!member && task.assigneeId === member.id
}

export function isOverdue(task, today) {
  return OPEN_STATUSES.includes(task.status) && task.deadline < today
}

// ---------------------------------------------------------------------------
// Channel access (CH5)
// ---------------------------------------------------------------------------
// Each channel says who may join it:
//   project    everyone on the project (a company channel: everyone at Oscenia)
//   divisions  those of the project in the listed divisions
//   invite     only the people on `memberIds`
// `memberIds` also lets named people in on top of the rule (an approved join request), and
// `blockedIds` keeps people out whatever the rule says — except the PM, who is never blocked.
// `listed: false` hides a channel from those who can't open it; otherwise they see it locked
// and may ask to join. Direct messages stand apart: their two people, nobody else.

export const CHANNEL_ACCESS = ['project', 'divisions', 'invite']

/** The access rule of a channel, reading older shapes too (`division`, a private `memberIds`). */
export function channelAccess(c) {
  const access = c.access || (c.memberIds ? 'invite' : c.division ? 'divisions' : 'project')
  return {
    access,
    divisions: c.divisions || (c.division ? [c.division] : []),
    memberIds: c.memberIds || [],
    blockedIds: c.blockedIds || [],
    // #leaders-style private company channels stay out of sight by default.
    listed: c.listed ?? !(access === 'invite' && !c.projectId),
  }
}

/** Can `member` open channel `c`? */
export function canOpenChannel(member, c, projectDivisions) {
  if (!member || !c) return false
  // Direct messages are for their two people only — the PM included, who otherwise sees all.
  if (c.dm) return c.memberIds.includes(member.id)
  if (member.workspaceRole === 'pm') return true
  const a = channelAccess(c)
  if (a.blockedIds.includes(member.id)) return false
  // Someone moved off the project loses its channels, even ones they were let into.
  if (c.projectId && !memberProjectIds(member, projectDivisions).includes(c.projectId)) return false
  if (a.memberIds.includes(member.id)) return true
  if (a.access === 'invite') return false
  return a.access === 'project' || a.divisions.includes(member.division)
}

/** Channels a member can open: company-wide, their projects', ones they are let into, their DMs. */
export function visibleChannels(member, channels, projectDivisions) {
  if (!member) return []
  return channels.filter((c) => canOpenChannel(member, c, projectDivisions))
}

/**
 * Channels `member` can see listed but not open — shown locked, with "Request to join". Only
 * on projects they work on (or company-wide), never when blocked, never a DM or unlisted one.
 */
export function discoverableChannels(member, channels, projectDivisions) {
  if (!member || member.workspaceRole === 'pm') return []
  const projectIds = memberProjectIds(member, projectDivisions)
  return channels.filter((c) => {
    if (c.dm || canOpenChannel(member, c, projectDivisions)) return false
    const a = channelAccess(c)
    if (!a.listed || a.blockedIds.includes(member.id)) return false
    return !c.projectId || projectIds.includes(c.projectId)
  })
}

/**
 * Who may change a channel's settings and decide join requests: the PM anywhere; on a project,
 * also the leaders whose division works on it. Company channels are the PM's.
 */
export function canManageChannel(member, c, projectDivisions) {
  if (!member || !c || c.dm) return false
  if (member.workspaceRole === 'pm') return true
  // Blocked from a channel means no say over it either.
  if (channelAccess(c).blockedIds.includes(member.id)) return false
  return Boolean(c.projectId) && member.workspaceRole === 'leader' && (projectDivisions[c.projectId] || []).includes(member.division)
}

/**
 * The main text channel of a project (or of the company, `projectId` null): the first one
 * open to everybody there. Found by its rule, so a renamed #general still counts.
 */
export function homeChannel(channels, projectId) {
  const texts = channels.filter((c) => !c.dm && c.kind !== 'voice' && (c.projectId || null) === (projectId || null))
  const open = texts.filter((c) => channelAccess(c).access === 'project')
  // #general when there is one (the company has #announcements too), else the first open one.
  return open.find((c) => c.name === 'general') || open[0] || texts[0] || null
}

/**
 * Where a call in a voice channel is logged: its linked text channel, but only when everyone
 * who can read that channel may also open the room. Otherwise a restricted room's log would
 * tell outsiders who met there, so it is not logged in the channel at all (null).
 */
export function callLogChannel(room, channels, members, projectDivisions) {
  const home = channels.find((c) => c.id === room?.textChannelId)
  if (!home) return null
  const leaks = members.some((m) => canOpenChannel(m, home, projectDivisions) && !canOpenChannel(m, room, projectDivisions))
  return leaks ? null : home
}

/** May `member` add channels to this server (`projectId`, or null for the company)? */
export function canCreateChannel(member, projectId, projectDivisions) {
  return canManageChannel(member, { projectId }, projectDivisions)
}
