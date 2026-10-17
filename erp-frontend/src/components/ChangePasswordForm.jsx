// Replace your own password. Used in the account menu, and full-screen when a temporary password
// (one an administrator handed over) has to be replaced before anything else.
import { useState } from 'react'
import { useAuth } from '../store/useAuth'
import { passwordProblem } from '../lib/usersApi'
import { useT } from '../i18n'

const FIELD = 'mt-1 w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50'

export default function ChangePasswordForm({ onDone, onCancel }) {
  const t = useT()
  const changePassword = useAuth((s) => s.changePassword)
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const problem = passwordProblem(form.next, form.confirm)
    if (problem) return setError(t(problem))
    setBusy(true)
    setError('')
    try {
      await changePassword(form.current, form.next)
      onDone?.()
    } catch (err) {
      // The server says what is wrong (the current password, or one that is not new); a lockout says how long.
      setError(err?.status === 429 ? t('Too many attempts. Try again shortly.') : err?.message || t('Could not change the password.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-white/40">{t('Current password')}</span>
        <input type="password" autoComplete="current-password" value={form.current} onChange={set('current')} className={FIELD} required />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-white/40">{t('New password')}</span>
        <input type="password" autoComplete="new-password" value={form.next} onChange={set('next')} className={FIELD} required />
      </label>
      <label className="block">
        <span className="text-[11px] uppercase tracking-wider text-white/40">{t('Repeat the new password')}</span>
        <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} className={FIELD} required />
      </label>
      <p className="text-[11px] text-white/40">{t('At least 12 characters. Changing it signs you out of your other devices.')}</p>
      {error && <div role="alert" className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</div>}
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" className="btn-ghost text-xs" onClick={onCancel}>{t('Cancel')}</button>}
        <button type="submit" className="btn-gold text-xs" disabled={busy}>{t('Change password')}</button>
      </div>
    </form>
  )
}
