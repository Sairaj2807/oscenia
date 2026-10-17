// The sign-in screen.
//
// The prototype had none: `role` was a store field and switching it was the whole of
// "authentication". This is the first screen in the app that the server can say no to.

import { useState } from 'react'
import { useAuth, DEMO_USERS, DEMO_PASSWORD, DEMO_MODE } from '../store/useAuth.js'
import { ROLES } from '../lib/roles.js'

export default function SignIn() {
  const signIn = useAuth((s) => s.signIn)
  // A real build starts empty: no account is pre-filled and none is advertised.
  const [email, setEmail] = useState(DEMO_MODE ? DEMO_USERS.ceo : '')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  async function submit(event) {
    event.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await signIn(email.trim(), password)
    } catch (err) {
      // The server returns one message for every failure — unknown account, wrong password,
      // deactivated — because telling them apart hands out a free list of who has an account
      // here. Showing its message verbatim keeps that property instead of undoing it.
      setError(
        err.status === 429
          ? `Too many attempts. Try again in about ${Math.ceil((err.retryAfter || 60) / 60)} minute(s).`
          : err.message || 'Could not sign in.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="eyebrow mb-2">Oscenia</div>
          <h1 className="font-display text-3xl text-white">Finance &amp; Operations</h1>
          <p className="mt-2 text-sm text-white/45">Sign in to continue.</p>
        </div>

        <form onSubmit={submit} className="card p-6 space-y-4">
          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-white/40">Email</span>
            <input
              type="email"
              required
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none"
            />
          </label>

          <label className="block">
            <span className="text-[11px] uppercase tracking-wider text-white/40">Password</span>
            <input
              type="password"
              required
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none"
            />
          </label>

          <p className="text-[11px] text-white/35">Forgot your password? Ask your administrator for a one-time link.</p>

          {error && (
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-gold w-full justify-center">
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        {DEMO_MODE && <div className="mt-6 card p-5">
          <div className="text-[11px] uppercase tracking-wider text-white/40 mb-3">
            Demo accounts
          </div>
          <div className="space-y-1">
            {Object.entries(DEMO_USERS).map(([role, address]) => (
              <button
                key={role}
                type="button"
                onClick={() => { setEmail(address); setPassword(DEMO_PASSWORD) }}
                className="w-full flex items-center justify-between rounded-lg px-3 py-2 text-left text-sm hover:bg-white/5"
              >
                <span className="text-white/80">{ROLES[role]?.label || role}</span>
                <span className="font-mono text-xs text-white/40">{address}</span>
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-white/35">
            All demo accounts use <span className="font-mono text-white/50">{DEMO_PASSWORD}</span>.
            They are useless anywhere real — a production deployment seeds its own users and
            refuses to start with the development signing key.
          </p>
        </div>}
      </div>
    </div>
  )
}
