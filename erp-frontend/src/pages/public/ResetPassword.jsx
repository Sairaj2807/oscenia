// Spend a password link an administrator handed over: choose a new password, signed out. The link's
// token rides in the address after `#` (so it is never sent to a server in a request line or logged)
// and goes to the API in a header.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { publicApi, whyPublic } from '../../lib/publicApi'
import { passwordProblem } from '../../lib/usersApi'

const FIELD = 'mt-1 w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 outline-none focus:border-gold/50'

export default function ResetPassword() {
  const [token, setToken] = useState('')
  const [form, setForm] = useState({ next: '', confirm: '' })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  // Read after the first paint, never during render (the smoke test renders on the server).
  useEffect(() => { setToken(window.location.hash.replace(/^#/, '')) }, [])
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  const submit = async (e) => {
    e.preventDefault()
    const problem = passwordProblem(form.next, form.confirm)
    if (problem) return setError(problem)
    setBusy(true)
    setError('')
    try {
      await publicApi.passwordReset(token, form.next)
      setDone(true)
    } catch (err) {
      setError(whyPublic(err).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="eyebrow mb-2">Oscenia</div>
          <h1 className="font-display text-3xl text-white">Choose a new password</h1>
        </div>
        {done ? (
          <div className="card p-6 text-center text-sm text-white/80">
            <p>Your password is set and your other sessions are signed out.</p>
            <Link to="/" className="btn-gold mt-4 inline-flex">Sign in</Link>
          </div>
        ) : (
          <form onSubmit={submit} className="card p-6 space-y-4">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-white/40">New password</span>
              <input type="password" autoComplete="new-password" value={form.next} onChange={set('next')} className={FIELD} required />
            </label>
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-white/40">Repeat it</span>
              <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} className={FIELD} required />
            </label>
            <p className="text-[11px] text-white/40">At least 12 characters. The link works once.</p>
            {!token && <div className="rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200">This page needs the full link your administrator sent you.</div>}
            {error && <div role="alert" className="rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</div>}
            <button type="submit" disabled={busy || !token} className="btn-gold w-full justify-center disabled:opacity-50">Set password</button>
          </form>
        )}
      </div>
    </div>
  )
}
