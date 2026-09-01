// Motion derived from "HOME - ABOUT US.pptx" — see docs/Deck-Transitions-Reference.md
// for the full analysis and how to re-derive it.
//
// Every direction and duration on the site should come from here rather than
// being chosen by eye, so each one is traceable to a measured slide.
//
// The deck is Morph (`byObject`) at 2000ms between slides 2-15: elements are
// parked off-canvas and travel in. Within a slide, the only effect used anywhere
// is a Fade entrance on the *body paragraph*, usually click-triggered.

// The deck's own morph duration. Full 2000ms reads as slow for a scroll-driven
// entrance, so sections use SECTION_MS; the automatic slide 1 -> 2 move uses the
// real thing.
export const DECK_MORPH_MS = 2000
export const SECTION_MS = 1400

// Gap between staggered siblings. The deck moves grid items together, but a
// small offset keeps a row from arriving as one flat block.
export const STAGGER_MS = 110

// The deck reveals body copy ON CLICK, because a presenter is advancing it. A
// page has no presenter, so the copy opens itself shortly after the section is
// reached and the interaction stays available rather than being required.
export const AUTO_REVEAL_MS = 900
export const AUTO_REVEAL_STAGGER_MS = 650

// Slide 1 -> 2: the wave goes 7.50x13.33in @ (2.92,-0.70) to 12.25x21.78in @
// (1.30,-9.52). Relative to its own box that is a scale plus a percentage shift,
// with the origin top-left.
export const WAVE = {
  slide1Box: { left: '21.91%', top: '-9.33%', width: '56.26%', height: '177.73%' },
  scale: 1.6333,
  tx: -21.6,
  ty: -66.2,
  opacity: 0.85,
}

// Entrances per section. `from` values match Reveal's ENTER_FROM keys.
export const MOTION = {
  // Slide 1 is the one slide that is NOT a morph — a plain fade, 700ms.
  hero: { slide: 1, duration: 700 },

  // Slide 2. Heading travels +6.15in from the left; the client grid -7.21in from
  // the right, rows staying level.
  clients: {
    slide: 2,
    heading: { from: 'left', duration: 1600 },
    // Rightmost column travels least, so it lands first.
    grid: { from: 'right', duration: 1500, columnStagger: 120 },
  },

  // Slide 3. The four panels enter horizontally by column — left column from the
  // left, right column from the right. (They *exit* to the four corners on
  // slide 3 -> 4; the corners are not the entrance.)
  direct: {
    slide: 3,
    eyebrow: { from: 'down' },
    heading: { from: 'left', delay: 180 },
    // Index order is Corporate, Brand, Executive, Experience -> a 2x2 grid.
    panels: ['left', 'right', 'left', 'right'],
    panelDuration: 1600,
  },

  // Slide 4. New objects, so Morph fades them.
  testimonials: { slide: 4, heading: { from: 'scale' } },

  // Slide 5. "OSCENIA" enters from the left. The intro paragraph is click-
  // revealed (a Disclosure in About.jsx), per the <p:timing> fade on slides 4-6.
  aboutIntro: { slide: 5, heading: { from: 'left' } },

  // Slide 6. The name paragraph exits top, so it enters from above.
  nameMeaning: { slide: 6, heading: { from: 'left' }, body: { from: 'down' } },

  // Slides 7-9. The description enters from below the circle and leaves the same
  // way; already click-triggered, which is what the deck does.
  standsFor: { slide: 7, heading: { from: 'down' }, revealFrom: 'up' },

  // Slide 10. The two halves converge — label down, statement up.
  vision: {
    slide: 10,
    eyebrow: { from: 'down' },
    rule: { from: 'scale', delay: 220 },
    statement: { from: 'up', delay: 420, duration: 1600 },
  },

  // Slide 11. Both new objects -> fade. The body is the one effect in the deck
  // marked explicitly ON CLICK, so it is a Disclosure in About.jsx.
  why: { slide: 11, heading: { from: 'scale', duration: 1600 } },

  // Slides 12-15. One label from the left per slide, each with a click-revealed
  // paragraph beside it.
  value: {
    slide: 12,
    heading: { from: 'left', duration: 1600 },
    label: { from: 'left' },
    rowStagger: 90,
  },
}
