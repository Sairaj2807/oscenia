// Users (CEO): who has a login, what role it has, and how a lost password is replaced. There is no
// email yet, so a new person gets a temporary password shown once, and a lost password is a
// one-time link the administrator hands over.
import { useCallback, useEffect, useState } from 'react'
import { Plus, KeyRound, UserX, UserCheck, Copy } from 'lucide-react'
import { PageHeader, Card, Badge, TableWrap, Field, TextInput, Select } from '../components/ui'
import Modal from '../components/Modal'
import { useStore } from '../store/useStore'
import { useAuth } from '../store/useAuth'
import { usersApi } from '../lib/usersApi'
import { ROLES } from '../lib/roles'
import { useT } from '../i18n'

const WORKSPACE_ROLES = ['staff', 'intern', 'leader']

export default function Users() {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const pushToast = useStore((s) => s.pushToast)
  const me = useAuth((s) => s.user)
  const [rows, setRows] = useState(null)
  const [failed, setFailed] = useState(false)
  const [creating, setCreating] = useState(false)
  const [shown, setShown] = useState(null) // { title, lines[] } - something to show once and hand over
  const [busy, setBusy] = useState(null)

  const load = useCallback(async () => {
    try {
      setRows(await usersApi.list())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])
  useEffect(() => { if (live) load() }, [live, load])

  const act = async (id, run, failTitle) => {
    setBusy(id)
    try {
      const out = await run()
      await load()
      return out
    } catch (err) {
      pushToast({ title: failTitle, body: err.message, kind: 'redflag' })
      return null
    } finally {
      setBusy(null)
    }
  }
  const setRole = (u, role) => act(u.id, () => usersApi.update(u.id, { role }), 'Could not change the role')
  const setActive = (u) => act(u.id, () => (u.active ? usersApi.deactivate(u.id) : usersApi.activate(u.id)), u.active ? 'Could not deactivate' : 'Could not reactivate')
  const resetLink = async (u) => {
    const out = await act(u.id, () => usersApi.resetLink(u.id), 'Could not make a link')
    if (!out) return
    const link = `${window.location.origin}${import.meta.env.BASE_URL}reset-password#${out.token}`
    setShown({
      title: `Password link for ${u.fullName}`,
      note: 'Send it to them yourself (chat or WhatsApp). It works once and expires in 24 hours; making another replaces this one.',
      lines: [link],
    })
  }

  if (!live) {
    return (
      <div className="animate-fade-up">
        <PageHeader eyebrow="Administration" title="Users" subtitle="Accounts and roles." />
        <Card className="text-sm text-white/55">{t('Managing users needs the server: sign in to see and change real accounts.')}</Card>
      </div>
    )
  }

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Administration"
        title="Users"
        subtitle="Who can sign in, and as what. A role change or a deactivation takes effect on that person's next click."
        actions={<button className="btn-gold" onClick={() => setCreating(true)}><Plus size={15} /> {t('New user')}</button>}
      />
      {failed && <Card className="mb-4 border-rose-500/30 text-sm text-rose-200">{t('The users could not be loaded. Try again shortly.')}</Card>}
      <TableWrap>
        <thead>
          <tr>
            <th className="th text-left">{t('Name')}</th>
            <th className="th text-left">{t('Email')}</th>
            <th className="th text-left">{t('Role')}</th>
            <th className="th text-left">{t('Status')}</th>
            <th className="th text-left">{t('Last sign-in')}</th>
            <th className="th"><span className="sr-only">{t('Actions')}</span></th>
          </tr>
        </thead>
        <tbody>
          {(rows || []).map((u) => {
            const self = u.id === me?.id
            return (
              <tr key={u.id} className="border-t border-white/5">
                <td className="td text-white/85">{u.fullName}{self && <span className="ml-2 text-[10px] text-white/35">{t('you')}</span>}</td>
                <td className="td text-xs text-white/55">{u.email}</td>
                <td className="td">
                  <Select value={u.role} disabled={self || busy === u.id} onChange={(e) => setRole(u, e.target.value)} aria-label={`${t('Role')} — ${u.fullName}`}>
                    {Object.values(ROLES).map((r) => <option key={r.id} value={r.id}>{t(r.label)}</option>)}
                  </Select>
                </td>
                <td className="td">
                  <Badge>{u.active ? 'Active' : 'Deactivated'}</Badge>
                  {u.mustChangePassword && <span className="ml-2 text-[10px] text-amber-300">{t('temporary password')}</span>}
                </td>
                <td className="td text-xs text-white/45">{u.lastLoginAt ? String(u.lastLoginAt).slice(0, 10) : '—'}</td>
                <td className="td text-right whitespace-nowrap">
                  {u.active && (
                    <button type="button" disabled={busy === u.id} onClick={() => resetLink(u)} className="btn-ghost !py-1 text-xs" title={t('Make a one-time password link')}>
                      <KeyRound size={13} /> {t('Password link')}
                    </button>
                  )}
                  {!self && (
                    <button type="button" disabled={busy === u.id} onClick={() => setActive(u)} className="btn-ghost ml-2 !py-1 text-xs">
                      {u.active ? <UserX size={13} /> : <UserCheck size={13} />} {t(u.active ? 'Deactivate' : 'Reactivate')}
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {rows && !rows.length && <tr><td colSpan={6} className="td text-center text-sm text-white/35">{t('No users yet.')}</td></tr>}
        </tbody>
      </TableWrap>

      {creating && (
        <CreateUser
          onClose={() => setCreating(false)}
          onCreated={async (out) => {
            setCreating(false)
            await load()
            setShown({
              title: `${out.user.fullName} can sign in`,
              note: 'Give them this temporary password now. It is shown only once, and they must replace it the first time they sign in.',
              lines: [`${out.user.email}`, out.temporaryPassword],
            })
          }}
        />
      )}
      {shown && <ShowOnce shown={shown} onClose={() => setShown(null)} />}
    </div>
  )
}

function CreateUser({ onClose, onCreated }) {
  const t = useT()
  const [form, setForm] = useState({ email: '', fullName: '', role: 'sales', workspace: false, workspaceRole: 'staff', division: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { email: form.email.trim(), fullName: form.fullName.trim(), role: form.role }
      if (form.workspace) Object.assign(body, { workspaceRole: form.workspaceRole, division: form.division.trim() || null })
      onCreated(await usersApi.create(body))
    } catch (err) {
      setError(err.message || t('Could not create the user.'))
      setBusy(false)
    }
  }
  return (
    <Modal title="New user" subtitle="They get a temporary password to replace on first sign-in" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Full name"><TextInput value={form.fullName} onChange={set('fullName')} required autoFocus /></Field>
        <Field label="Email"><TextInput type="email" value={form.email} onChange={set('email')} required /></Field>
        <Field label="Role">
          <Select value={form.role} onChange={set('role')}>
            {Object.values(ROLES).map((r) => <option key={r.id} value={r.id}>{t(r.label)}</option>)}
          </Select>
        </Field>
        <label className="flex items-center gap-2 text-xs text-white/60">
          <input type="checkbox" checked={form.workspace} onChange={set('workspace')} /> {t('Add to the workspace and team chat')}
        </label>
        {form.workspace && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Workspace role">
              <Select value={form.workspaceRole} onChange={set('workspaceRole')}>
                {WORKSPACE_ROLES.map((r) => <option key={r} value={r}>{t(r)}</option>)}
              </Select>
            </Field>
            <Field label="Division"><TextInput value={form.division} onChange={set('division')} placeholder={form.workspaceRole === 'leader' ? t('required for a leader') : ''} /></Field>
          </div>
        )}
        {error && <div role="alert" className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</div>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>{t('Cancel')}</button>
          <button type="submit" className="btn-gold text-xs" disabled={busy}>{t('Create user')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** A secret to read out or copy once (a temporary password, a reset link). Not kept anywhere. */
function ShowOnce({ shown, onClose }) {
  const t = useT()
  const [copied, setCopied] = useState(-1)
  const copy = async (text, i) => {
    try { await navigator.clipboard.writeText(text); setCopied(i) } catch { setCopied(-1) }
  }
  return (
    <Modal title={shown.title} subtitle={shown.note} onClose={onClose}>
      <div className="space-y-2">
        {shown.lines.map((line, i) => (
          <div key={i} className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-950 px-3 py-2">
            <span className="min-w-0 flex-1 break-all font-mono text-xs text-white/85">{line}</span>
            <button type="button" onClick={() => copy(line, i)} className="shrink-0 text-xs text-gold/80 hover:text-gold-light">
              <Copy size={13} className="inline" /> {copied === i ? t('Copied') : t('Copy')}
            </button>
          </div>
        ))}
        <div className="flex justify-end pt-1"><button type="button" className="btn-gold text-xs" onClick={onClose}>{t('Done')}</button></div>
      </div>
    </Modal>
  )
}
