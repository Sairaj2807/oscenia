import { useState } from 'react'
import { useStore } from '../store/useStore'
import { Card } from '../components/ui'

export default function Survey() {
  const projects = useStore((s) => s.projects)
  const submitSurvey = useStore((s) => s.submitSurvey)
  const live = useStore((s) => s.hydrated)
  const finished = projects.filter((p) => !p.cancelled && (p.stage === 'Finished' || p.stage === 'Post-Event Feedback'))
  // The demo falls back to its first project; a real login only rates an event that has happened.
  const target = finished[0] || (live ? null : projects[0])

  const [score, setScore] = useState(0)
  const [hover, setHover] = useState(0)
  const [done, setDone] = useState(false)

  const submit = async () => {
    if (!score || !target) return
    // Only say "recorded" when it was: the server can refuse (and says why in a toast).
    const res = await submitSurvey(target.id, score)
    if (res && res.ok === false) return
    setDone(true)
  }

  if (!target) {
    return (
      <div className="animate-fade-up max-w-xl mx-auto">
        <Card className="text-center p-8 text-sm text-white/50">There is no finished event to rate yet.</Card>
      </div>
    )
  }

  return (
    <div className="animate-fade-up max-w-xl mx-auto">
      <div className="text-center mb-6">
        <div className="brand-mark text-lg">OSCENIA</div>
        <div className="text-[10px] tracking-[0.3em] text-white/40 mt-1">CLIENT SATISFACTION</div>
      </div>

      <Card className="text-center p-8">
        {!done ? (
          <>
            <div className="eyebrow mb-2">Post-Event Survey</div>
            <h1 className="font-display text-2xl text-white">How was {target.name}?</h1>
            <p className="text-sm text-white/50 mt-2">Your rating helps us reward the crew who made it happen.</p>

            <div className="my-8 flex justify-center gap-1.5" onMouseLeave={() => setHover(0)}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <button
                  key={n}
                  onMouseEnter={() => setHover(n)}
                  onClick={() => setScore(n)}
                  className={`text-2xl sm:text-3xl transition-transform hover:scale-110 ${
                    n <= (hover || score) ? 'text-gold-light' : 'text-white/15'
                  }`}
                >
                  ★
                </button>
              ))}
            </div>
            <div className="text-sm text-white/60 mb-6 h-5">{score ? `You rated ${score} / 10` : 'Tap a star to rate'}</div>

            <button onClick={submit} disabled={!score} className="btn-gold w-full sm:w-auto px-10">
              Submit rating
            </button>
          </>
        ) : (
          <>
            <div className="text-5xl mb-4">🎉</div>
            <h1 className="font-display text-2xl text-white">Thank you!</h1>
            <p className="text-sm text-white/50 mt-2">
              Your {score}/10 rating for <span className="text-gold-light">{target.name}</span> was recorded.
            </p>
            <p className="text-xs text-white/40 mt-4">
              Behind the scenes, this just recalculated the crew’s performance bonuses on the Payroll screen — automatically.
            </p>
          </>
        )}
      </Card>
      <div className="text-center text-[11px] text-white/30 mt-4">
        Prototype · this form feeds the Feedback-Driven Incentives module.
      </div>
    </div>
  )
}
