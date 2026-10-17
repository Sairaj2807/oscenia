// The client's rating page: no sign-in. The link's token rides in the address after `#` (so it is never
// sent to a server in a request line or logged) and goes to the API in a header. A link that is wrong,
// expired, withdrawn or for an event that cannot be rated all say the same thing.
import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { publicApi, whyPublic } from '../../lib/publicApi'

export default function SurveyPage() {
  const { projectNo } = useParams()
  const [token, setToken] = useState('')
  const [page, setPage] = useState(null)
  const [state, setState] = useState('loading') // loading | ready | gone | error
  const [error, setError] = useState('')
  const [score, setScore] = useState(0)
  const [hover, setHover] = useState(0)
  const [busy, setBusy] = useState(false)
  const [thanks, setThanks] = useState(false)

  // Read after the first paint, never during render (the smoke test renders on the server).
  useEffect(() => { setToken(window.location.hash.replace(/^#/, '')) }, [])
  useEffect(() => {
    if (!token) return undefined
    let off = false
    publicApi.survey(projectNo, token).then(
      (p) => { if (!off) { setPage(p); setScore(p.rating ? Math.round(p.rating) : 0); setState('ready') } },
      (err) => { if (!off) { setState(err?.status === 404 ? 'gone' : 'error'); setError(whyPublic(err).message) } },
    )
    return () => { off = true }
  }, [projectNo, token])

  const submit = async () => {
    if (!score) return
    setBusy(true)
    setError('')
    try {
      const next = await publicApi.rateSurvey(projectNo, token, score)
      setPage(next)
      setThanks(true)
    } catch (err) {
      if (err?.status === 404) setState('gone')
      else setError(whyPublic(err).message)
    } finally {
      setBusy(false)
    }
  }

  const shell = (body) => (
    <div className="min-h-screen bg-navy-950 flex items-center justify-center px-4">
      <div className="w-full max-w-xl">
        <div className="text-center mb-6">
          <div className="brand-mark text-lg">OSCENIA</div>
          <div className="text-[10px] tracking-[0.3em] text-white/40 mt-1">CLIENT SATISFACTION</div>
        </div>
        <div className="card p-8 text-center">{body}</div>
      </div>
    </div>
  )

  if (!token && state === 'loading') {
    return shell(<p className="text-sm text-white/60">This page needs the full link you were sent.</p>)
  }
  if (state === 'loading') return shell(<p className="text-sm text-white/50">One moment…</p>)
  if (state === 'gone') {
    return shell(<>
      <h1 className="font-display text-2xl text-white">This survey link is not available</h1>
      <p className="text-sm text-white/50 mt-2">It may have expired or been replaced. Please ask your Oscenia contact for a new one.</p>
    </>)
  }
  if (state === 'error') return shell(<p role="alert" className="text-sm text-rose-300">{error}</p>)

  if (thanks) {
    return shell(<>
      <h1 className="font-display text-2xl text-white">Thank you!</h1>
      <p className="text-sm text-white/60 mt-2">
        Your {Math.round(page.rating)}/10 rating for <span className="text-gold-light">{page.name}</span> was recorded.
      </p>
      {!page.locked && (
        <button type="button" onClick={() => setThanks(false)} className="mt-5 text-xs text-white/50 underline hover:text-white">Change my rating</button>
      )}
    </>)
  }

  return shell(<>
    <div className="eyebrow mb-2">Post-Event Survey</div>
    <h1 className="font-display text-2xl text-white">How was {page.name}?</h1>
    <p className="text-sm text-white/50 mt-2">Your rating helps us reward the crew who made it happen.</p>
    {page.locked ? (
      <p className="mt-6 text-sm text-white/60">
        {page.rating ? `You rated this ${Math.round(page.rating)}/10. ` : ''}The crew bonuses for this event have been paid, so the rating can no longer change.
      </p>
    ) : (
      <>
        <div className="my-8 flex justify-center gap-1.5" onMouseLeave={() => setHover(0)}>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              aria-label={`${n} out of 10`}
              onMouseEnter={() => setHover(n)}
              onClick={() => setScore(n)}
              className={`text-2xl sm:text-3xl transition-transform hover:scale-110 ${n <= (hover || score) ? 'text-gold-light' : 'text-white/15'}`}
            >
              ★
            </button>
          ))}
        </div>
        <div className="text-sm text-white/60 mb-6 h-5">{score ? `You rated ${score} / 10` : 'Tap a star to rate'}</div>
        {error && <div role="alert" className="mb-4 rounded-lg bg-rose-500/15 px-3 py-2 text-sm text-rose-300">{error}</div>}
        <button type="button" onClick={submit} disabled={!score || busy} className="btn-gold w-full sm:w-auto px-10 disabled:opacity-50">
          {page.rating ? 'Update my rating' : 'Submit rating'}
        </button>
      </>
    )}
  </>)
}
