// Background music for invitations (Invitations v2): the three built-in tracks, played with
// the Web Audio API so the prototype ships no audio files and needs no licence, and the
// client's own uploaded song. The built-in tracks are placeholders — the backend will offer
// licensed recordings.
//
// `trackPlan` is plain data (scripts/verify-proto.mjs checks it under Node). Everything that
// makes a sound — AudioContext, <audio>, timers — starts inside `play()`, which the page only
// calls from a tap: browsers refuse sound that no one asked for, and the smoke test renders on
// the server, where none of it exists.

const PLANS = {
  // Broken-chord arpeggios over a held bass: Cmaj7 · Am7 · Fmaj7 · G.
  'soft-piano': {
    bpm: 72, voice: 'piano', beatsPerChord: 4,
    chords: [[60, 64, 67, 71], [57, 60, 64, 67], [53, 57, 60, 64], [55, 59, 62, 67]],
    arp: [0, 1, 2, 3, 4, 3, 2, 1],
  },
  // Slow held chords, two detuned voices each: Am · F · C · G.
  'warm-strings': {
    bpm: 60, voice: 'strings', beatsPerChord: 8,
    chords: [[57, 60, 64], [53, 57, 60], [48, 55, 64], [55, 59, 62]],
    arp: null,
  },
  // Bell-like notes on the off-beats: Dmaj7 · Bm7 · Gmaj7 · A.
  'evening-glow': {
    bpm: 88, voice: 'bell', beatsPerChord: 4,
    chords: [[62, 66, 69, 73], [59, 62, 66, 69], [55, 59, 62, 66], [57, 61, 64, 69]],
    arp: [0, 2, 1, 3, 2, 4, 3, 1],
  },
}

export const TRACK_IDS = Object.keys(PLANS)

export const midiToHz = (m) => 440 * 2 ** ((m - 69) / 12)

/**
 * One loop of a track as notes: { beat, midi, len (beats), vel 0–1 }, sorted by beat. An
 * unknown id gets the first track, so a stale saved choice still plays something.
 */
export function trackPlan(trackId) {
  const p = PLANS[trackId] || PLANS[TRACK_IDS[0]]
  const notes = []
  p.chords.forEach((chord, i) => {
    const start = i * p.beatsPerChord
    notes.push({ beat: start, midi: chord[0] - 12, len: p.beatsPerChord, vel: 0.5 }) // bass
    if (!p.arp) {
      for (const m of chord) notes.push({ beat: start, midi: m, len: p.beatsPerChord, vel: 0.32 })
      return
    }
    const step = p.beatsPerChord / p.arp.length
    p.arp.forEach((k, j) => {
      const midi = k < chord.length ? chord[k] : chord[k - chord.length] + 12
      notes.push({ beat: start + j * step, midi, len: step * 3, vel: j === 0 ? 0.5 : 0.36 })
    })
  })
  notes.sort((a, b) => a.beat - b.beat)
  return { bpm: p.bpm, voice: p.voice, loopBeats: p.chords.length * p.beatsPerChord, notes }
}

// --- the synthesiser (browser only) ----------------------------------------------

const LOOKAHEAD = 0.5 // seconds of notes scheduled ahead of the clock
const VOLUME = 0.32

function synthPlayer(trackId) {
  const plan = trackPlan(trackId)
  const spb = 60 / plan.bpm
  let ctx = null
  let master = null
  let timer = null
  let suspendTimer = null
  let i = 0
  let loopStart = 0

  const build = () => {
    const AC = window.AudioContext || window.webkitAudioContext
    if (!AC) return false
    ctx = new AC()
    master = ctx.createGain()
    master.gain.value = 0
    // A soft echo stands in for a room.
    const delay = ctx.createDelay(1)
    delay.delayTime.value = 0.28
    const feedback = ctx.createGain()
    feedback.gain.value = 0.28
    master.connect(ctx.destination)
    master.connect(delay)
    delay.connect(feedback)
    feedback.connect(delay)
    delay.connect(ctx.destination)
    loopStart = ctx.currentTime + 0.1
    return true
  }

  const note = (n, at) => {
    const hz = midiToHz(n.midi)
    const dur = n.len * spb
    const env = ctx.createGain()
    env.connect(master)
    const g = env.gain
    const osc = (type, freq, level) => {
      const o = ctx.createOscillator()
      o.type = type
      o.frequency.value = freq
      const lvl = ctx.createGain()
      lvl.gain.value = level
      o.connect(lvl)
      lvl.connect(env)
      o.start(at)
      o.stop(at + dur + 2.5)
    }
    if (plan.voice === 'strings') {
      const filter = ctx.createBiquadFilter()
      filter.type = 'lowpass'
      filter.frequency.value = 1100
      env.disconnect()
      env.connect(filter)
      filter.connect(master)
      g.setValueAtTime(0, at)
      g.linearRampToValueAtTime(n.vel * 0.5, at + 1.6)
      g.setValueAtTime(n.vel * 0.5, at + dur - 0.2)
      g.linearRampToValueAtTime(0, at + dur + 2)
      osc('sawtooth', hz * 0.997, 0.5)
      osc('sawtooth', hz * 1.003, 0.5)
      return
    }
    // piano and bell: a quick strike that rings away.
    g.setValueAtTime(0, at)
    g.linearRampToValueAtTime(n.vel, at + 0.01)
    g.exponentialRampToValueAtTime(0.001, at + (plan.voice === 'bell' ? 2.2 : 1.6))
    osc(plan.voice === 'bell' ? 'sine' : 'triangle', hz, 0.8)
    osc('sine', hz * (plan.voice === 'bell' ? 3 : 2), plan.voice === 'bell' ? 0.18 : 0.12)
  }

  const schedule = () => {
    const horizon = ctx.currentTime + LOOKAHEAD
    for (;;) {
      const n = plan.notes[i]
      const at = loopStart + n.beat * spb
      if (at > horizon) return
      if (at >= ctx.currentTime - 0.05) note(n, at) // a late note is skipped, not crammed in
      i += 1
      if (i === plan.notes.length) {
        i = 0
        loopStart += plan.loopBeats * spb
      }
    }
  }

  return {
    play() {
      if (!ctx && !build()) return Promise.resolve(false)
      clearTimeout(suspendTimer)
      const resumed = ctx.resume()
      const now = ctx.currentTime
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(master.gain.value, now)
      master.gain.linearRampToValueAtTime(VOLUME, now + 1.2)
      if (loopStart < now) {
        // Coming back from a pause: start the progression again rather than mid-chord.
        loopStart = now + 0.1
        i = 0
      }
      clearInterval(timer)
      timer = setInterval(schedule, 120)
      schedule()
      return resumed.then(() => true, () => false)
    },
    pause() {
      if (!ctx) return
      clearInterval(timer)
      const now = ctx.currentTime
      master.gain.cancelScheduledValues(now)
      master.gain.setValueAtTime(master.gain.value, now)
      master.gain.linearRampToValueAtTime(0, now + 0.4)
      suspendTimer = setTimeout(() => ctx?.suspend(), 450)
    },
    destroy() {
      clearInterval(timer)
      clearTimeout(suspendTimer)
      ctx?.close().catch(() => {})
      ctx = null
    },
  }
}

// --- an uploaded song ----------------------------------------------------------------

function filePlayer(url) {
  const audio = new Audio(url)
  audio.loop = true
  audio.volume = 0
  let fade = null
  const fadeTo = (target, then) => {
    clearInterval(fade)
    fade = setInterval(() => {
      const next = audio.volume + Math.sign(target - audio.volume) * 0.05
      if (Math.abs(target - audio.volume) <= 0.05) {
        audio.volume = target
        clearInterval(fade)
        then?.()
      } else audio.volume = Math.min(1, Math.max(0, next))
    }, 50)
  }
  return {
    play() {
      const started = audio.play()
      fadeTo(0.7)
      return started.then(() => true, () => false)
    },
    pause() { fadeTo(0, () => audio.pause()) },
    destroy() {
      clearInterval(fade)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    },
  }
}

/**
 * A player for `{ kind:'builtin', trackId }` or `{ kind:'upload', url }`. Create it and call
 * `play()` inside a tap handler. play() resolves to whether the browser let it start.
 */
export function createMusic(source) {
  return source.kind === 'upload' ? filePlayer(source.url) : synthPlayer(source.trackId)
}
