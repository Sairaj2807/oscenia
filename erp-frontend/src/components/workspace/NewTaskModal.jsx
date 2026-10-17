// New task on a project. The assignee list is whoever the current persona may assign on
// this project (lib/workspaceAccess.js) — the store enforces the same rule on save.
import { useState } from 'react'
import Modal from '../Modal'
import { Field, TextInput, Select, todayFor } from '../ui'
import { useProto, selectPersona } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { assignableMembers, memberProjectIds, WORKSPACE_ROLES } from '../../lib/workspaceAccess'
import { useT } from '../../i18n'

export default function NewTaskModal({ projectId, onClose, onCreated, initialTitle = '', initialDescription = '' }) {
  const t = useT()
  const persona = useProto(selectPersona)
  const members = useProto((s) => s.members)
  const projectDivisions = useProto((s) => s.projectDivisions)
  const pushToast = useStore((s) => s.pushToast)
  const options = assignableMembers(persona, projectId, members, projectDivisions)

  const [title, setTitle] = useState(initialTitle)
  const [description, setDescription] = useState(initialDescription)
  const [assigneeId, setAssigneeId] = useState(options[0]?.id || '')
  const [deadline, setDeadline] = useState('')
  const [priority, setPriority] = useState('Medium')

  const live = useProto((s) => s.live)
  const valid = title.trim() && assigneeId && deadline && deadline >= todayFor(live)

  const save = async () => {
    const id = await useProto.getState().createTask({ projectId, title, description, assigneeId, deadline, priority })
    if (!id) {
      if (!live) pushToast({ title: 'Not allowed', body: 'This persona cannot assign that person on this project.', kind: 'redflag' })
      return
    }
    const who = members.find((m) => m.id === assigneeId)
    pushToast({ title: 'Task assigned', body: `${id} → ${who?.name}`, kind: 'project' })
    onCreated?.(id)
    onClose()
  }

  return (
    <Modal
      title="New task"
      subtitle={`${t('Assigning as')} ${persona.name} (${t(WORKSPACE_ROLES[persona.workspaceRole])})`}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={onClose}>{t('Cancel')}</button>
          <button className="btn-gold" disabled={!valid} onClick={save}>{t('Assign task')}</button>
        </>
      }
    >
      <Field label="Title">
        <TextInput autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={t('e.g. Confirm AV rider with venue')} />
      </Field>
      <Field label="Description">
        <textarea
          rows={3}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none"
        />
      </Field>
      <Field label="Assign to" hint={t('Only people this persona may assign on this project are listed.')}>
        <Select value={assigneeId} onChange={(e) => setAssigneeId(e.target.value)}>
          {options.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name} — {t(m.division)} {t(WORKSPACE_ROLES[m.workspaceRole])}
              {!memberProjectIds(m, projectDivisions).includes(projectId) && ` · ${t('will be added to the project')}`}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Deadline">
          <TextInput type="date" min={todayFor(live)} value={deadline} onChange={(e) => setDeadline(e.target.value)} />
        </Field>
        <Field label="Priority">
          <Select value={priority} onChange={(e) => setPriority(e.target.value)}>
            {['High', 'Medium', 'Low'].map((p) => <option key={p} value={p}>{t(p)}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}
