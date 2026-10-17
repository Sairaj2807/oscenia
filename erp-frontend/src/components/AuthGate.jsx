// Decides whether to show the app or the sign-in screen, and keeps the old `role` selector
// working.
//
// ---------------------------------------------------------------------------
// Why it writes `role` into the business store
// ---------------------------------------------------------------------------
// 22 call sites read `useStore((s) => s.role)`. Rewriting all of them to read from `useAuth`
// would be a large diff whose only effect is to move where a string comes from. Instead the
// gate mirrors the authenticated role into the store once, here, so every existing selector
// keeps working — and now returns the server's answer rather than a client-side toggle.
//
// This is the single point of coupling between identity and business data, and it is
// deliberately one line in one place rather than an import in both stores.

import { useEffect } from 'react'
import { useAuth, DEMO_MODE } from '../store/useAuth.js'
import { useStore } from '../store/useStore.js'
import SignIn from '../pages/SignIn.jsx'
import ChangePasswordForm from './ChangePasswordForm.jsx'
import { canSee } from '../lib/roles.js'

// Every module that reads the business data (finance, projects, CRM, vendors, warehouse...).
// `workspace` and `chat` are deliberately absent: they have their own live data.
const BUSINESS_MODULES = [
  'dashboard', 'quotations', 'projects', 'finance', 'crm', 'vendors', 'procurement',
  'warehouse', 'payroll', 'sales', 'events',
]

export default function AuthGate({ children }) {
  const status = useAuth((s) => s.status)
  const hydrated = useStore((s) => s.hydrated)
  const hydrateError = useStore((s) => s.hydrateError)
  const user = useAuth((s) => s.user)
  const restore = useAuth((s) => s.restore)
  // Still waiting for the first load: not loaded, and it has not failed.
  const waiting = !hydrated && !hydrateError

  useEffect(() => {
    // Only on first mount: a stored token may still be good, and showing a sign-in form to
    // somebody who is already signed in is its own kind of wrong.
    if (status === 'unknown') restore()
  }, [status, restore])

  useEffect(() => {
    if (user?.role) useStore.setState({ role: user.role })
  }, [user?.role])

  useEffect(() => {
    // Hydration is gated on being signed in: every collection endpoint requires a bearer
    // token, so loading before authentication would be five guaranteed 401s. An offline demo
    // session has no server to load from, so it stays on seed data without trying.
    if (user && !user.offline) {
      // A login with no business module (a team member: workspace and chat only) has no finance
      // data to load and none it should see. Mark it loaded so the app opens, and so search
      // goes to the server rather than to the seed data the store starts on.
      if (BUSINESS_MODULES.some((m) => canSee(user.role, m))) useStore.getState().hydrate()
      else useStore.setState({ hydrated: true, hydrateError: null })
    }
  }, [user?.id, user?.offline, user?.role])

  if (status === 'unknown') {
    return (
      <div className="min-h-screen bg-navy-950 flex items-center justify-center">
        <div className="text-sm text-white/40">Checking your session…</div>
      </div>
    )
  }

  if (status !== 'authenticated') return <SignIn />

  // A temporary password an administrator handed over has to be replaced before anything else.
  if (user?.mustChangePassword && !user.offline) return <MustChangePassword />

  // A real build never shows stand-in figures. If the first load failed there is nothing true to
  // show, so say so and offer a retry instead of opening the app on seed data.
  if (!DEMO_MODE && !user?.offline && hydrateError && !hydrated) return <LoadFailed error={hydrateError} />

  return (
    <>
      {!user?.offline && <HydrationBanner />}
      {!user?.offline && waiting ? <LoadingLive /> : children}
    </>
  )
}

/**
 * Nothing is shown until the first load from the server has finished or failed.
 *
 * Before it does, the screens hold seed (demo) data and every action's `hydrated` check still says
 * "not live": a click in that window ran the DEMO branch of the action, changed browser memory only,
 * and looked as if it worked. Holding the app back for the second or so the load takes removes the
 * window. A failed load still opens the app (the banner says so), because a chat-only login has no
 * finance data to load and must not be locked out by that.
 */
function LoadingLive() {
  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center">
      <div className="text-sm text-white/40">Loading live data…</div>
    </div>
  )
}

/**
 * Says so when the figures on screen are not live.
 *
 * If the API cannot be reached the store stays on its seed data, which renders perfectly and
 * is entirely wrong. Silence there would be the worst outcome available: a plausible balance
 * sheet nobody has any reason to doubt.
 */
function HydrationBanner() {
  const hydrating = useStore((s) => s.hydrating)
  const error = useStore((s) => s.hydrateError)
  const hydrated = useStore((s) => s.hydrated)
  const retry = useStore((s) => s.hydrate)

  if (hydrated && !error) return null

  if (hydrating) {
    return (
      <div className="fixed bottom-4 right-4 z-50 rounded-lg border border-white/10 bg-navy-800 px-4 py-2 text-xs text-white/60 shadow-2xl">
        Loading live data…
      </div>
    )
  }

  if (!error) return null

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-xs text-amber-200 shadow-2xl">
      <div className="font-medium">Showing demo data — the API is not reachable.</div>
      <div className="mt-1 text-amber-200/70">{error.message}</div>
      <button onClick={() => retry()} className="mt-2 underline hover:text-white">
        Try again
      </button>
    </div>
  )
}


function LoadFailed({ error }) {
  const retry = useStore((s) => s.hydrate)
  const signOut = useAuth((s) => s.signOut)
  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <div className="eyebrow mb-2">Oscenia</div>
        <h1 className="font-display text-2xl text-white">Could not load your data</h1>
        <p className="mt-2 text-sm text-white/50">{error?.message || 'The server did not answer.'}</p>
        <div className="mt-6 flex justify-center gap-3">
          <button type="button" onClick={() => retry()} className="btn-gold">Try again</button>
          <button type="button" onClick={signOut} className="rounded-lg border border-white/15 px-4 py-2 text-sm text-white/70 hover:text-white">Sign out</button>
        </div>
      </div>
    </div>
  )
}

function MustChangePassword() {
  const signOut = useAuth((s) => s.signOut)
  return (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-6">
          <div className="eyebrow mb-2">Oscenia</div>
          <h1 className="font-display text-2xl text-white">Choose your own password</h1>
          <p className="mt-2 text-sm text-white/45">You signed in with a temporary password. Replace it to continue.</p>
        </div>
        <div className="card p-6">
          <ChangePasswordForm />
        </div>
        <button type="button" onClick={signOut} className="mt-4 w-full text-center text-xs text-white/40 underline underline-offset-2 hover:text-white/70">Sign out</button>
      </div>
    </div>
  )
}
