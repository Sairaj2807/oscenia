# Oscenia Web — Animation Reference

Every animation on the site, what triggers it, and exactly what happens from start to finish. There is no animation library in this project (no Framer Motion, no GSAP) — everything is built from CSS transitions/keyframes (Tailwind), the Web Animations that CSS gives you for free, `requestAnimationFrame` loops, and `IntersectionObserver`. Source files are linked at the start of each section.

All motion respects `prefers-reduced-motion: reduce`. Where an animation has a reduced-motion fallback, it's called out explicitly.

---

## 1. Global building blocks

**Files:** [tailwind.config.js](tailwind.config.js), [src/index.css](src/index.css)

Five reusable CSS keyframe animations are registered in `tailwind.config.js` and used as utility classes (`animate-*`) across the site:

| Utility class | Keyframe | Duration | Easing / repeat |
|---|---|---|---|
| `animate-fade-in` | `fade-in`: opacity 0 → 1 | 1.2s | `ease-out`, plays once (`both`) |
| `animate-pulse-soft` | `pulse-soft`: opacity 0.8 → 0.35 → 0.8 | 2.6s | `ease-in-out`, loops forever |
| `animate-ken-burns` | `ken-burns`: `scale(1)` → `scale(1.16) translate(-2%, -1.2%)` | 26s | `ease-in-out`, loops forever, **alternates** direction (zooms in, then back out, forever) |
| `animate-marquee` | `marquee`: `translateX(0)` → `translateX(-50%)` | 38s | linear, loops forever |
| `animate-sheen` | `sheen`: `translateX(-8%) rotate(18deg)` → `translateX(58%) rotate(18deg)` | 9s | `ease-in-out`, loops forever, alternates |

Two more one-off keyframes live directly in `index.css`:

- `word-in` (opacity 0 + `translateY(0.45em)` → opacity 1 + `translateY(0)`), 700ms, `cubic-bezier(0.22, 1, 0.36, 1)`, plays once and holds its end state (`both`). Drives the kinetic headline and the hero CTA (§3).
- The `.headline-line` transform (a per-line horizontal shift) only activates above `1280px` — see §3.

**Reduced motion overrides** (`@media (prefers-reduced-motion: reduce)` in `index.css`):
- `animate-ken-burns`, `animate-marquee`, `animate-sheen` are hard-disabled (`animation: none !important`).
- `word-in`'s duration collapses to `1ms` (so content still appears, just instantly).
- `html { scroll-behavior: auto }` — smooth-scroll-to-anchor is turned off.
- Every custom React component and hook (`Reveal`, `GoldThread`, `useCardToss`, `Ripple`, `Intro`, `Disclosure`, `BackdropVideo`) additionally checks `window.matchMedia('(prefers-reduced-motion: reduce)')` itself in JS and skips its `requestAnimationFrame` loop / `IntersectionObserver` entirely, rendering the finished state immediately.

---

## 2. Intro sequence (splash → showreel → site)

**File:** [src/components/Intro.jsx](src/components/Intro.jsx)

This is the very first thing a visitor sees on any route (mounted in `App.jsx` above the router, so it overlays whatever page loaded underneath). It's a state machine with four stages: `SPLASH (-2) → SPLASH_LEAVING (-1) → VIDEO (0) → DONE (1)`.

**Step 1 — Splash (`SPLASH`).**
A full-screen black overlay (`fixed inset-0 z-[100]`) fades up a looping background video of navy velvet (`/media/velvet.mp4`, via `BackdropVideo`, loaded eagerly), darkened with a `bg-navy-950/45` scrim. Centered on top: the Oscenia brand mark at `h-40`/`h-52`, and below it the label text ("click logo to enter" equivalent) pulsing forever via `animate-pulse-soft` (2.6s opacity breathing, see §1). The logo button auto-focuses on mount so keyboard users land on it immediately.

**Step 2 — The push-through (`SPLASH_LEAVING`), triggered by clicking the logo.**
This is a camera push *through* the mark, matched to `Video Project.mp4` in the repo root — a screen recording of the intended prototype. Every number is measured off that clip (click lands at 3.00s in it), not chosen by eye. Times below are relative to the click; the whole handover runs 1450ms (`SPLASH_EXIT_MS`).

The mark you see during the push is **not** the `<img>` from the splash — it's the same artwork re-drawn as real SVG geometry (`data/markGeometry.js`, copied verbatim from `mark-stacked-gold.svg`), mounted over the splash and matched to where the `<img>` sits, so the swap at t=0 shows nothing. It has to be real geometry because the push takes the mark tens of times past its own size, and only vector paths re-render sharp at that scale — a CSS transform would scale the rasterised texture into mush.

| Window | What happens |
|---|---|
| 0–80ms | nothing moves at all |
| 80–260ms | the ink brightens **gold → cream → white**, via `INK_STOPS` (measured samples: (197,186,153) → (211,199,171) → (249,241,228) → white). It only ever brightens — it never darkens or passes through grey |
| 80–400ms | still no movement. The reference holds dead still here, and that pause is most of what makes the push afterwards read as deliberate |
| 400–1300ms | the mark scales away from the viewer, until one of its strokes covers the viewport outright |
| 1300–1450ms | it keeps accelerating past that point rather than easing to a stop — the difference between a push and an object inflating |

Three things make it a push rather than a zoom:

1. **It's anchored off-centre.** On mount the component rasterises the mark to an offscreen canvas and runs a two-pass chamfer distance transform (`findAnchor`) to find the centre of the largest circle that fits inside the ink — by construction the point with the most artwork around it, and so the one place the camera can travel into without the frame breaking into gaps. Independently fitting the scale's fixed point off the reference recording gives ~19%/16% of the mark's box, which is the cross-check on it.
2. **The scale law is exponential**, not a bezier: `s = exp(rate · (t − 400ms))`. A constant *multiplicative* rate is what a camera moving at steady speed toward an object actually produces (the reference measures ×1.46 per 100ms). Crucially it never decelerates.
3. **How far it has to travel is solved, not assumed.** `solveCoverScale` binary-searches for the smallest scale at which every point of a 49×29 viewport grid maps onto ink. The mark is a set of ribbons, not a disc, so what fills the screen is a stroke's length and curvature, and no closed-form radius predicts it. It's recomputed per click, so it adapts to viewport size and to how large the logo happens to render.

The velvet stays visible behind the mark the entire time — nothing masks it out, the mark's own ink is what covers it. Once the ink passes ~4.5× the wordmark is well outside the frame and stops being drawn, so the expensive high-zoom frames repaint one path instead of fourteen. The final ink colour isn't white but **rgb(241,239,236)** — sampled from `showreel.mp4`'s own opening frame — so that when the splash unmounts there is no step in the colour at all.

All of it is driven from a single `requestAnimationFrame` loop writing the `viewBox` attribute and the group `fill` directly, so the colour ramp, the scale and the wordmark drop cannot drift apart.

**Step 3 — Showreel (`VIDEO`), when the 1450ms timer elapses.**
The splash and the drawn mark both unmount. The showreel (`/media/showreel.mp4`) has been mounted underneath the whole time and started playing at the 400ms mark — timed so its own ~1.8s of flat cream opening still has most of its length left when the wipe lands on top of it, which is why the swap reads as continuous rather than as a cut. Two live pieces of UI ride on top:
- A "Skip" button, bottom-right, which auto-focuses when this stage begins. Hovering it transitions its background/text colors over 300ms into gold.
- A 3px-tall progress hairline pinned to the bottom edge (`bg-white/5` track, `bg-gold/90` fill). Its width is driven directly by `video.currentTime / video.duration` on every `timeupdate` event — no easing, it's a literal scrub bar filling left-to-right as the film plays.

**On a portrait screen** the showreel is letterboxed instead of cropped (`.showreel-letterbox` in `index.css`): it's kinetic type, and a fill-crop on a phone shows only the middle quarter of every sentence. Each frame, Intro reads the film at 16×9 on an offscreen canvas and paints the bars above and below in the colours of the film's own top and bottom edges (the film's scenes all sit on flat cream, navy or black), on a layer behind the video; the film's top and bottom edges are masked into a 7vw fade so there's no seam. Landscape screens keep the full-bleed crop.

The showreel plays **with its soundtrack**. Browsers only allow sound from a user gesture, and the film's real start (400ms into the push, from the animation loop) isn't one as far as Safari is concerned — so the logo click itself unmutes the element and starts and immediately pauses it, which unlocks it without a sample being heard. If a browser still refuses sound, `playWithSound` falls back to playing muted rather than leaving the intro frozen. Skip, Escape or the film ending unmount the overlay, which stops the sound.

Pressing `Escape` at any point, clicking Skip, or the video reaching `onEnded` all call `finish()`.

**Step 4 — Done (`DONE`).**
`finish()` sets stage to `DONE`; the component returns `null` (unmounts entirely) and fires a global `window.dispatchEvent(new Event('oscenia:intro-done'))`. This event is what wakes up the Ripple cursor effect on the home page (see §7) and is only used once — however the intro ended.

**Reduced motion:** if `prefers-reduced-motion: reduce` is set, clicking the splash logo returns straight to `DONE` — the push never runs, the drawn mark is never mounted, the showreel element isn't even rendered, and the offscreen rasterisation is skipped too.

---

## 3. Hero headline — word-by-word kinetic type

**Files:** [src/components/KineticHeadline.jsx](src/components/KineticHeadline.jsx), [src/data/headline.js](src/data/headline.js), keyframe in [src/index.css](src/index.css)

The hero sentence ("Strategic events & immersive experiences that transform business objectives into memorable human moments.") is not one heading — it's ten separately-styled `<span>` fragments (varying font size, italics, and baseline offset, defined in `data/headline.js`), arranged across three lines, each of which animates in independently.

**Step-by-step, on page load (no scroll trigger — this plays immediately when Home mounts):**
1. Every word-span starts with the `word-in` animation applied but staggered: word index `i` gets `animation-delay: i * 380ms` (`WORD_STAGGER_MS`) and `animation-duration: 1100ms` (`WORD_DURATION_MS`).
2. Each word therefore individually animates `opacity 0→1` and `translateY(0.45em)→0` (lifting up into place) over 1100ms, using the eased curve `cubic-bezier(0.22, 1, 0.36, 1)` (a gentle overshoot-free ease-out).
3. Because each successive word starts 380ms after the previous one, the sentence appears to "type in" fragment by fragment across all three lines rather than as one block.
4. Each word also carries a small permanent baseline nudge (`WORD_NUDGE`, in em, applied as a static inline `translateY`) so small words visually ride up against the cap-height of the large words next to them — this offset is not animated, it's the word's resting position.
5. On screens ≥1280px, each of the three lines additionally carries a static horizontal offset (`--line-shift`, from `LINE_SHIFT`) via the `.headline-line` CSS rule — this is a layout offset, not a scroll- or time-based animation.
6. Once the whole headline finishes landing (`headlineDurationMs()` = total word count × 380ms + 1100ms, minus 500ms), the "Start your event" glass CTA button beneath the headline plays the *same* `word-in` animation (900ms, delayed to land right as the last word settles) — so the button arrives as the sentence's natural final beat rather than popping in separately.

**Reduced motion:** the `word-in` keyframe's duration is forced to 1ms, so all words and the CTA appear instantly in their final position with no stagger.

---

## 4. Scroll reveals (`Reveal` component)

**File:** [src/components/Reveal.jsx](src/components/Reveal.jsx)

This is the single most-used animation in the codebase — nearly every heading, card, and paragraph on Home, About, Services, and Contact is wrapped in `<Reveal>`. It slides content in from a chosen direction as it scrolls into view, modeled directly on the PowerPoint "Morph" transitions of the source deck (`data/deckMotion.js` documents which direction/duration was measured off which slide).

**Setup (on mount):** an `IntersectionObserver` is attached to the wrapped element with two thresholds, `[0, 0.15]` — this creates hysteresis:
- Once the element is **≥15% visible**, `shown` flips to `true` and the reveal plays.
- Once the element is **completely gone** (0% visible), `shown` flips back to `false` — so scrolling back up to a section and back down replays the animation, unless the `once` prop is passed (in which case the observer disconnects after the first play and it never resets).

**Step-by-step animation, when `shown` becomes `true`:**
1. Before reveal: the element sits at `opacity-0` plus a directional Tailwind transform class from `ENTER_FROM`, e.g. `translate-y-8` for `from="up"`, `-translate-x-16` for `from="left"`, `scale-95` for `from="scale"`, or a diagonal combo like `translate-x-8 translate-y-8` for `from="bottom-right"`. Horizontal offsets are halved on mobile (`sm:` breakpoint doubles them) since a 4rem shift is proportionally huge on a 390px-wide phone.
2. When triggered, all four properties (`opacity`, `translate-x`, `translate-y`, `scale`) animate simultaneously via a single `transition-all` to their resting state: `opacity-100 translate-x-0 translate-y-0 scale-100`.
3. The transition uses a custom cubic-bezier, `cubic-bezier(0.33, 0, 0.15, 1)` (`MORPH_EASE`) — matching PowerPoint Morph's characteristic ease-out-of-the-move feel — over a duration set per-instance (default 1400ms, `SECTION_MS`; individual call sites override this, e.g. 900ms for the champagne-film caption, 1600ms for the About page's larger headings). The home page's format cards no longer use it — they have their own entrance (§13).
4. An optional `delay` prop (in ms) staggers siblings — e.g. Services.jsx staggers a grid of cards by `(i % 3) * 80ms` so a row doesn't land as one flat block.

**Reduced motion:** the component renders the child directly with no wrapping transition styles at all — content is simply present at full opacity/position from the start, and the `IntersectionObserver` is never created.

---

## 5. Gold threads — scroll-drawn hairlines

**Files:** [src/components/GoldThread.jsx](src/components/GoldThread.jsx), routes and pacing in [src/data/formatsMotion.js](src/data/formatsMotion.js), placed in [src/pages/Home.jsx](src/pages/Home.jsx) (`Formats`)

Two decorative, `aria-hidden` gold hairlines run through the "What we direct" section. Rather than fading in, they look *hand-drawn*: how much of each stroke shows is tied to scroll position, so it writes itself as you scroll down and un-writes if you scroll back. Both routes are matched to `Video Project 2.mp4` in the repo root (a screen recording of the reference at 1920×1080): each is a least-squares Bézier fit to the hairline traced out of the frames, with smooth joins.

**Thread one**, from the champagne film to the cards (median 1.5px off the traced reference). Every joint between its curve segments is tangent-continuous: the two handles at each joint are collinear, which removed a visible 27° corner where the loop's descent crosses the film's bottom edge:
1. Starts at the far left edge of the film, about half a screen above its bottom edge.
2. A long, nearly straight diagonal down through "What we direct / Formats", crossing the film's edge about a sixth of the way across.
3. A wide, shallow U in the black gap, lowest about 45% across.
4. A vertical right arm about 65% across, climbing back into the film.
5. A loop over the top, down through "end." and across its own U.
6. It crosses the gutter between the first two cards, just below their tops, and the link carries it on in under the second card's photo.

**Thread two**, from row two to the testimonials — re-fitted to `VID-20260830-WA0000.mp4` in the repo root (18 frames registered by scroll into one trace; a G1-smooth Bézier chain, median 2.3px off, most of that the recording's blur): it comes out from behind "Experience Systems", sweeps down-left in one convex curve straight into the belly of a teardrop loop (no knee where the two meet), runs along the bottom of the loop, up round its left end and back along the top, out through its own crossing, and diagonally off the right edge a little above "Client Testimonials". **The link**: in the reference the two threads are one line. Frame by frame (1:02.7–1:02.9 in `VID-20260830-WA0000.mp4`), thread one carries straight on along its 45° exit diagonal in under the "Brand Experiences" photo, comes out from under its bottom edge (x≈1380), crosses behind "Experiences" and the gap between the rows on the same heading, and goes in under the "Experience Systems" photo — where it bends round to come out below it heading straight down, as thread two. `buildLink` reproduces that from the measured photos: a straight run on thread one's heading, then one cubic under the second photo onto thread two's heading, tangent-continuous at both joins. Timing as measured: the pen lags under the first photo and only comes out below "Brand Experiences" once that caption has risen to ~11% down the screen, writes the diagonal as the caption leaves the top, then finishes the hidden bend quickly. It starts on the frame thread one finishes and ends on the frame thread two starts, so the pen never lifts. The Testimonials section has no thread of its own — the line across its top-right is this one's tail. (The `Formats` section is `z-10` so the tail draws over the testimonials' background.)

**How a thread draws:**
1. The path lives in a 1920-wide viewBox stretched to a full-screen-width box (`preserveAspectRatio="none"`, `w-screen`), so x follows the viewport width and y its height. That keeps thread one's crossing — 49.5% across — inside our gutter at every width from 640px up (the gutter always straddles the centre), and its hidden end under the second card's photo. Thread two's start instead follows its caption: `Formats` measures where 70% along "Experience Systems" falls and moves the first point there (capped at 40 units leftward, past which the opening sweep would kink into a hook).
2. A scroll listener (one measurement per animation frame) turns the box's position into a `0–1` progress: `from`/`to` in `formatsMotion.js` say where the box's top edge sits, as a fraction of the viewport height, when drawing starts and ends. For thread one that's the film's bottom edge going from 97.6% of the screen to 16.3% for the visible line (plus a few percent for the hidden run under the photo). For thread two it's the caption's box top going from 28.7% of the screen to −7%.
3. Progress goes through a **pacing curve** — a monotone cubic through `[progress, drawn]` points read off the recording. Thread one is front-loaded: the diagonal, the U and the right arm (63% of the line) write themselves in the first 27% of the scroll, and the loop and descent onto the cards take the rest. Thread two, measured frame by frame against the caption's position, writes the sweep and most of the loop at a steady pace, slows over the top of the loop, then whips the tail off the right edge in the last tenth of its scroll. Rendered in Chrome at the reference's scroll positions, the drawn fraction tracks the recording (0.267 vs 0.25, 0.630 vs 0.62, 0.727 vs 0.731, 0.856 vs 0.859), and the rendered pixels land on the recording's own (median 0.0px, 90th percentile ≤ 2.2px).
4. The stroke is revealed with `stroke-dasharray` / `stroke-dashoffset`, and the dash length is **measured on screen** — walked along the path with each step scaled by the box's stretch, and re-measured on resize. This matters: with a non-scaling stroke, Chromium lays the dash out in screen pixels, while `getTotalLength()` measures viewBox units. The old thread sized its dash from `getTotalLength()`, which on a 1920×1080 screen was 1.26× too short — so its last 21%, the descent onto the cards, never drew at all.
5. Stroke: 2.2px (non-scaling) of `rgba(238, 225, 188, 0.92)` — a pale champagne, far less orange than the brand gold. Both numbers come from integrating the line's cross-section in the recording, so its blur doesn't inflate the width.
6. The path starts invisible and only shows once its first measured draw has set the dash, so the whole line never flashes up first; at nothing drawn it's hidden outright, since a round cap would otherwise leave a dot.

Both threads are hidden below 640px wide. **Reduced motion:** drawn complete and static — no scroll listener.

---

## 6. Hero background — Ken Burns zoom

**File:** [src/pages/Home.jsx](src/pages/Home.jsx) (`HeroFilm`), keyframe `ken-burns` in `tailwind.config.js`

The hero's background photograph (`/media/hero-table.webp`) is pinned via `sticky top-0` behind the hero and client-strip sections, and carries the `animate-ken-burns` class.

**Step-by-step:** the image continuously animates `transform: scale(1) translate3d(0,0,0)` → `transform: scale(1.16) translate3d(-2%, -1.2%, 0)` over 26 seconds, `ease-in-out`, and because the animation direction is set to `alternate` with `infinite` repeat, it doesn't snap back to the start — it smoothly reverses and pushes back out again, in an endless slow breathing zoom/pan, mimicking a documentary-style push into the table setting. Two static gradient scrims sit on top (an even navy veil for text contrast, and a bottom-edge fade into the next section's black) — these are not animated, just fixed overlays.

**Reduced motion:** the `animate-ken-burns` class is disabled site-wide (§1), so the image is a static frame.

---

## 7. Cursor ripple — pointer-driven water simulation

**File:** [src/components/Ripple.jsx](src/components/Ripple.jsx)

A full-viewport, `pointer-events: none`, `mix-blend-mode: screen` `<canvas>` that renders a live 2D wave simulation displaced by the mouse cursor — the most technically involved animation on the site. It deliberately imitates water rather than a generic cursor-glow.

**Step-by-step, continuously while active:**
1. **Grid setup:** the canvas backing store is a coarse grid, one cell per 10 CSS pixels (`CELL = 10`), stored as two `Float32Array`s (`curr` and `prev` height fields) — intentionally low-res because the browser's own image upscaling is what gives the ripple its soft, blurred, water-like look.
2. **Injecting energy (`poke`)**: on every `pointermove` (mouse/pen only — touch is ignored), the code doesn't just stamp the current point — it walks the line segment from the previous pointer position to the current one in up to 20 sub-steps (more steps for faster movement, so a flick lays down a longer, stronger wake than a slow hover), and at each step "pushes" a soft cosine-falloff dent into the height field (`AMPLITUDE = 0.1`, radius `POKE = 3` cells). A soft falloff is used deliberately — a hard-edged disc would "ring" instead of "displace."
3. **Propagation (`step`, run once per animation frame):** a standard discrete wave-equation update — each cell becomes the average of its four neighbors from the previous frame, minus the cell's own value two frames back, times a damping factor `DAMP = 0.95`. This is what makes disturbances spread outward and ripple realistically instead of just fading in place. At 0.95 damping, a wake takes roughly a second and a half to fully die out after the pointer stops moving.
4. **Rendering (`draw`, also once per frame):** for every cell, height and local slope (via finite differences with neighboring cells) are combined into a light intensity value — slope matters more than raw height, because a real wave is visible mainly where it tilts and catches light. That intensity is squared before being used to blend between a navy trough color and a gold-light crest color, and used directly as the pixel's alpha — so only the sharpest wave crests read as bright gold, while the broad swell underneath stays a dim cool sheen. The result is blitted to the canvas each frame via `putImageData`.
5. **Auto-stop:** each frame, `draw()` returns the peak intensity on screen. If that peak drops below a near-invisible threshold (`QUIET = 0.004`) and it's been more than 400ms since the last pointer poke, the `requestAnimationFrame` loop cancels itself and clears the canvas — so an idle page isn't burning a rAF loop animating something nobody can see. Any subsequent pointer move restarts the loop.
6. **Tab visibility:** if the tab is hidden mid-ripple, the loop is cancelled and the whole simulation state (height fields, canvas) is wiped, so returning to the tab doesn't show a frozen mid-ripple frame.

**Gating (not part of the physics, but part of the animation's lifecycle):** on the homepage (`/`), the canvas doesn't activate until it receives the `oscenia:intro-done` event dispatched by the Intro component (§2) — this avoids competing with the intro's own video decode/paint work for main-thread time. On every other route it's active immediately on mount.

**Reduced motion:** the entire effect is skipped — no canvas context is even created, no listeners attached.

---

## 8. Logo marquee — infinite horizontal scroll

**File:** [src/components/LogoMarquee.jsx](src/components/LogoMarquee.jsx), keyframe `marquee` in `tailwind.config.js`

The client-logo strip laid across the hero film. The list of client marks is rendered **twice back-to-back** in one flex row (`[...CLIENTS, ...CLIENTS]`), and the whole row carries `animate-marquee`.

**Step-by-step:** the track continuously animates `translateX(0)` → `translateX(-50%)` over 38 seconds, linear, looping forever. Because the content is duplicated and the translation distance is exactly half the track's total width, the moment the animation completes one loop and snaps back to `translateX(0)`, the visual content is pixel-identical to what was already showing — so the loop point is invisible and the scroll appears perfectly seamless and endless.

**Reduced motion:** `animate-marquee` is disabled site-wide (§1); the strip becomes a static row.

---

## 9. Testimonials — carousel, sheen sweep, and quote fade

**File:** [src/pages/Home.jsx](src/pages/Home.jsx) (`Testimonials`), keyframe `sheen` in `tailwind.config.js`

Three separate animations run together inside the testimonial card:

**a) Auto-advancing carousel.** A `setInterval` fires every 4000ms (`SLIDE_MS`) and advances `index` to the next testimonial, wrapping at the end. It pauses whenever the pointer hovers the card or a control inside it receives keyboard focus (`onMouseEnter`/`onFocusCapture` set `paused=true`; the matching leave/blur handlers release it), and is disabled entirely if there are fewer than 2 testimonials or reduced motion is on.

**b) Gold sheen sweep.** A blurred, gradient-filled `<span>` positioned behind the quote text carries `animate-sheen`: it continuously animates `translateX(-8%) rotate(18deg)` → `translateX(58%) rotate(18deg)` over 9 seconds, `ease-in-out`, `alternate`, forever — so a soft band of warm gold light rocks back and forth across the card rather than sweeping past and leaving it dark. This runs independently of the carousel's index and never stops.

**c) Quote fade-in on change.** The `<blockquote>` element is keyed on `index` (`key={index}`) and carries `animate-fade-in` (opacity 0→1 over 1.2s, `ease-out`, plays once). Because React remounts the element whenever `key` changes, every time the carousel advances (automatically or via the prev/next dot controls) the outgoing quote is instantly replaced and the incoming one fades in fresh from opacity 0.

**Reduced motion:** the carousel's auto-advance timer is never started (manual prev/next controls still work); `animate-sheen` is disabled site-wide, so the card's light stays static. `animate-fade-in` is not covered by the reduced-motion override in `index.css`, so the quote-swap fade still plays when a control is used manually — this is a per-transition fade tied to user-initiated content change, not a decorative background loop.

---

## 10. Disclosure — self-opening accordion panels

**File:** [src/components/Disclosure.jsx](src/components/Disclosure.jsx)

Used on the About page for body copy that the source PowerPoint deck reveals "on click" (because a human presenter was advancing slides) — here it opens itself automatically after the section is reached, since there's no presenter, while staying manually toggleable.

**Step-by-step:**
1. An `IntersectionObserver` (threshold 0.3) watches the panel's wrapping element.
2. When it becomes ≥30% visible, a `setTimeout` starts for `autoOpenAfter` ms (defaults to 900ms, `AUTO_REVEAL_MS`). When that timer fires, `open` flips to `true`.
3. If the element scrolls back out of view before the timer fires (or after having opened), `open` resets to `false` and the pending timer is cleared — so scrolling away and back replays the auto-reveal, exactly like `Reveal`'s hysteresis behavior.
4. Once a visitor manually clicks the summary/toggle button even once, `touched` is set `true` permanently, and the auto-open effect disengages entirely — the component stops opening or closing things on its own and only responds to further clicks.
5. **The open/close animation itself** uses the CSS grid `0fr → 1fr` row-sizing trick: the panel wrapper is `grid grid-rows-[0fr]` (closed) or `grid-rows-[1fr]` (open), transitioning `grid-template-rows` (bundled into `transition-all`) over 700ms `ease-out`. This animates from zero height to the content's natural height without ever needing to measure a pixel value in JS, and it collapses/expands cleanly regardless of content length. `opacity` (0↔100) and a small `translate-y-3` directional offset animate in parallel with the grid-row transition, so the panel both grows and slides/fades into place simultaneously.
6. The `+` toggle glyph beside the summary text rotates 45° (into a `×`) over 500ms when open, and on hover (while closed) scales up to `1.25×` as a hover affordance.

**Reduced motion:** `open` initializes to `true` immediately (content is present with no closed state ever rendered), the auto-open `IntersectionObserver` effect is skipped entirely, and the panel's transition classes are neutralized via `motion-reduce:transition-none`.

---

## 11. Navigation — header, mobile drawer, hamburger, language toggle

**File:** [src/components/Nav.jsx](src/components/Nav.jsx)

Several small, purely CSS-transition-driven interactions live in the header:

- **Nav link hover/active:** each link's text/background color transitions over 300ms (`transition-colors duration-300`) between the resting `text-white/80` and the hover state (gold-light background, navy text).
- **Language toggle pill:** clicking EN/AR (or whichever locales) swaps the active chip's background/text color over 300ms; only color properties transition, the pill itself doesn't move.
- **Hamburger → close icon morph (mobile only):** the icon is three absolutely-positioned 1px bars. Opening the drawer transitions (via default `transition-transform`/`transition-opacity` utility timing) the top bar to `translate-y-1.5 rotate-45`, fades the middle bar to `opacity-0`, and transitions the bottom bar to `-translate-y-1.5 -rotate-45` — the three independent bar transforms combine into a smooth hamburger-to-X morph. Reversed on close.
- **Mobile drawer open/close:** the full-height drawer panel transitions `opacity` over 300ms between `opacity-0` (also `invisible pointer-events-none` while closed, so it can't be tabbed into or clicked when hidden) and `opacity-100`. There is no slide/transform component — it's a pure cross-fade.
- **"Let's Talk Further" pill / mobile CTA buttons:** standard `.btn-*` hover color transitions (see §12).

No scroll-position-based header animation exists deliberately — the header stays transparent over every section (including near-black ones) at all scroll depths; a "solidify on scroll" state was intentionally not built, per the reference design's uniform look.

---

## 12. Shared button hover states

**File:** [src/index.css](src/index.css) (`@layer components`)

Three plain pill-button classes each define a 300ms hover transition (`transition-all duration-300`):

- **`.btn-pill`** — transparent with a gold outline → on hover, fills solid gold and the border brightens, text flips to navy.
- **`.btn-gold`** — solid gold → on hover, brightens to `gold-light`.
- **`.btn-solid`** — dark translucent with a white/20 border → on hover, fills gold, border and text follow.

Each also has a permanent underlying `Reveal` or `word-in` entrance the first time it appears on screen (see §3, §4) — the hover transition is layered on top of, and independent from, that entrance.

### 12a. Liquid glass — "Start your event" and the quick-contact bead

**Files:** [src/index.css](src/index.css) (`.liquid-glass`, `.liquid-glass--bead`, `.btn-glass`), [src/components/useLiquidGlass.js](src/components/useLiquidGlass.js)

Both buttons wear one material modelled on Apple's Liquid Glass. `.btn-glass` is now only the pill's shape and type; the glass is `.liquid-glass`. What separates it from ordinary frosted glass is that it behaves like a thick lens.

**At rest** (all CSS, every browser):
- Backdrop: `blur(2.5px) saturate(170%) brightness(1.06)` — the *clear* variant, barely frosted, so the film still reads through. The bead uses the frostier variant (`blur(10px)`, darker tint), since it floats over arbitrary page content and its glyph has to stay legible over anything.
- A 1.25px **specular rim** (`::before`), brightest at top-left where the light comes from, nearly gone along the middle, returning faintly at bottom-right the way light re-emerges after crossing a glass body. It's a gradient ring cut out with `mask-composite: exclude`, because a border can't vary its brightness around the shape.
- A **caustic**: light pooled along the inside of the lower edge (`inset 0 -12px 14px -12px`), plus a softer glow along the top. These give it thickness.
- A **specular bloom** (`::after`), a soft radial highlight resting at the light source (28%, 0%).

**Lensing** (Chromium only, via the hook): content behind the rim bends. This needs an SVG `feDisplacementMap` fed to `backdrop-filter`, and the displacement map has to match the element's exact size and radius — so `useLiquidGlass` draws one per element on a canvas and redraws it through a `ResizeObserver`. Within a bevel of 30% of the short side, each pixel samples from further *in* along the edge's inward normal, with quadratic falloff: sharp bend at the rim, a clear middle. Pull at the very edge is 85% of the bevel depth — tuned by rendering the hero button over `hero-table.webp` at 1600px, where a light arc in the photo crosses behind it and visibly jogs at the rim. Only Chromium applies an SVG filter from `backdrop-filter`, so the hook gates it on `navigator.userAgentData` (itself Chromium-only, which also correctly excludes Chrome on iOS); every other browser keeps everything above.

**Hover / focus** (400ms): the glass warms with the brand's gold — `--lg-rim` transitions to `#f0dca8`, the tint takes on gold, the caustic brightens, and a gold halo lifts it off the film. `--lg-rim` is registered with `@property` so it interpolates rather than snapping. This doubles as the keyboard focus indicator.

**Pointer**: the bloom follows the pointer. The hook writes `--lg-x`/`--lg-y` on every `pointermove`, and because both are registered `<percentage>` properties with a 260ms transition, the light glides after the cursor rather than being stuck to it. On `pointerleave` the inline values are dropped and it drifts back up to the light source. On touch, `pointerdown` places it under the finger.

**Press**: Apple's interactive glass grows under the finger rather than sinking, so `:active` swells to `scale: 1.035` on a spring (`cubic-bezier(0.34, 1.56, 0.64, 1)`, 560ms) that overshoots both ways — a small gel-like bounce on release. The bloom jumps to full strength in 120ms. It uses the individual `scale` property, which composes with the bead's `translate` show/hide rather than fighting it for `transform`.

**Reduced motion:** no press swell, and the hook doesn't attach pointer tracking — the highlight stays at the light source. Colour transitions remain, as they aren't motion.

**Reduced transparency:** honoured the way Apple's own glass does, by going opaque — `backdrop-filter: none` over a near-solid dark ground, and the hook skips building the refraction filter since there'd be nothing for it to bend.

---

## 13. Format cards — the toss, and the hover float

**Files:** [src/components/useCardToss.js](src/components/useCardToss.js), numbers in [src/data/formatsMotion.js](src/data/formatsMotion.js) (`TOSS`), markup in [src/pages/Home.jsx](src/pages/Home.jsx) (`FormatCard`), hover in [src/index.css](src/index.css) (`.format-card-lift`)

### The toss (entrance, and its reverse on scroll up)

Each "What we direct" card is **thrown onto the table** as it arrives — measured frame by frame off `Video Project 2.mp4`:

1. **Parked.** Before its slot reaches the screen, the photo waits just clear of its own side of the screen — left cards off the left edge, right cards off the right — 28% of the screen height above its slot, and tilted: **13° clockwise** on the left, **8° counter-clockwise** on the right. The offset is computed from the slot and the photo's size, including the corners the tilt swings outward, so it starts exactly at the edge. The caption waits separately: 24% of the screen width out to the same side, 21% of the screen height *below* its place, at 40% opacity.
2. **Triggered by position, not scroll-scrubbed.** An `IntersectionObserver` on the untransformed grid cell (the photo itself starts off-screen, so it could never be seen to intersect) launches the toss once the slot is 20px inside the viewport — 60px for right cards, which also sit 28px lower. So the right card leaves after about 70px more scrolling: the recording's stagger (1.1s at its slow scroll, 0.25s at its fast one) is positional. The flight itself is timed — the recording scrolls row two 3.2× faster than row one and both flights take about as long.
3. **The flight.** The photo slides home over **2270ms** on `cubic-bezier(0.92, 1, 0.7, 1)` — constant speed, then a hard brake in the last ~10% — while the tilt unwinds on `cubic-bezier(0.18, 0, 0, 0.92)`: early, flat by ~80% of the flight, no overshoot. Sampled live in Chrome, the photo's track matches the recording's to **0.7%** of the travel.
4. **The caption** lands in two moves on its own timing: sideways (290ms delay, 1350ms, `cubic-bezier(0, 0.44, 0, 1)`) reaching its column first, then upward and brightening (330ms delay, 1370ms, `cubic-bezier(1, 0.47, 0.77, 1)`). Sampled live, the remaining offsets match the recording's reads (sideways 1.0/0.35/0.13/0.05 vs 1.0/0.34/0.13/0.05; upward 1.0/0.96/0.83/0.66 vs 1.0/0.96/0.83/0.67).
5. **Thrown back out on scroll up.** Scrolling back up plays the same flight in reverse, once the slot's top drops below **60% of the screen height** (`TOSS.exitLine`) while the card is still mostly in view. Everything that happened at time *t* on the way in happens at *2270ms − t* on the way out, on the mirrored curve (a cubic-bezier rotated 180°, so the brake becomes a gentle lift-off): the photo flies back up and out to its own side, re-tilting to 13° / −8°; the caption drops and slides away in mirrored order (slide delay 630ms, rise delay 570ms); on phones the fade-in becomes a fade-out over the last 45%. Scrolling down past the line again throws it back in, turning round mid-air if it's still leaving. Only crossings of the line count, so a card that loads already in view is never thrown out on arrival.
6. **Replay.** When a card leaves off the *top* (scrolling down), it re-parks silently once its slot is entirely off screen, so coming back to it replays the toss — never yanking a card that's still visible.

Each card is four layers so no two motions fight: the photo layer takes the toss (`translate` + `rotate`); inside it `.format-card-lift` takes the hover; inside that the frame carries the hover-only halo and the slow photo zoom. The caption is split the same way — sideways on the `figcaption`, upward on the block within. Styles are written directly, not through React state, so the parked position is measured and committed in the same frame the flight starts from it. The section is `overflow-x-clip` because a parked card would otherwise widen the page on a phone (iOS Safari pans past `body`'s `overflow-x`).

**Below 640px** (one column): a full-width card thrown from off-screen would cross the whole phone, so it's gentler — 35% of the width, 6% of the height, ±4°, 1300ms, fading in. **Reduced motion:** no toss; cards sit in place.

### Hover

1. **Swell and float:** the card grows to `1.08×` from its foot over 1200ms (so the caption underneath stays uncovered), then floats ±5px, once every 1.05s, while the pointer rests on it — measured off the reference with the page and pointer both still. The reference grows ~14%, but its gutter is 88px; ours is 48px, and 8% keeps a hovered card clear of its neighbour. Touch devices (`hover: none`) and reduced motion skip this.
2. **Image scale:** inside the frame the photo still zooms `1.05×` over 1200ms `ease-out`.
3. **Glow on hover:** the card has no halo at rest — its shadow is `shadow-[0_0_110px_-34px_rgba(198,161,91,0)]`, fully transparent. On hover it blooms to `shadow-[0_0_130px_-24px_rgba(198,161,91,0.95)]` over 700ms and fades back out when the pointer leaves. The hover rule is wrapped in `[@media(hover:hover)]:`, so a tap on a touch screen never leaves it stuck on.
4. **Description reveal:** the one-line description under the title fades from `opacity-0` to `opacity-100` over 500ms.

---

## 14. Quick-contact floating button — scroll-gated appear/disappear

**File:** [src/components/QuickContact.jsx](src/components/QuickContact.jsx)

A round WhatsApp button pinned to the right edge, gated by scroll position rather than always visible.

**Step-by-step, on every scroll/resize event:**
1. It computes two booleans: `pastHero` (scrollY > 45% of one viewport height) and `nearEnd` (within 420px of the bottom of the document).
2. It's shown only when `pastHero && !nearEnd` — i.e., it appears once you've scrolled past the hero, and disappears again near the page's end (where a closing CTA takes over the same role), and is hidden entirely on the Contact page (since it would just point at the page you're already on).
3. The show/hide transition itself animates `opacity` (0↔100) and `translateY` (`translate-y-4` hidden → `translate-y-0` shown) together over 500ms — so it eases up into place from slightly below, and eases back down out of sight, rather than just popping.
4. While hidden it also gets `pointer-events-none`, `aria-hidden`, and `tabIndex={-1}`, so it's non-interactive and unreachable by keyboard when invisible.
5. The bead itself is liquid glass (`.liquid-glass--bead`, see §12a): pointer-following highlight, gold rim and halo, lensing in Chromium, and a spring swell on press rather than the old `active:scale-95` sink. The show/hide slide above lives in the material's own transition list, so adding it didn't need a transition utility that would have replaced the press spring.

---

## 15. Case study modal

**File:** [src/components/CaseStudy.jsx](src/components/CaseStudy.jsx)

Opened by clicking a portfolio tile on the Services page. The whole dialog overlay (`fixed inset-0`, dark navy + backdrop-blur) carries `animate-fade-in` — a single 1.2s `ease-out` opacity fade from 0 to 1, playing once on mount. There is no exit animation: closing (via the × button, clicking the backdrop, or `Escape`) unmounts the dialog immediately. Body scroll is locked (`document.body.style.overflow = 'hidden'`) for the duration it's open, restored on close — not a visual animation, but part of the same open/close lifecycle.

---

## Quick index — file ↔ animation

| Animation | Component/Page |
|---|---|
| Splash logo bloom, showreel, skip/progress | `components/Intro.jsx` |
| Word-by-word headline reveal | `components/KineticHeadline.jsx` + `data/headline.js` |
| Directional scroll reveal (used everywhere) | `components/Reveal.jsx` |
| Scroll-drawn gold threads (two routes, front-loaded pacing) | `components/GoldThread.jsx` + `data/formatsMotion.js` |
| Hero background zoom/pan | `pages/Home.jsx` (`animate-ken-burns`) |
| Cursor water ripple | `components/Ripple.jsx` |
| Infinite client-logo scroll | `components/LogoMarquee.jsx` |
| Testimonial carousel, sheen, quote fade | `pages/Home.jsx` (`Testimonials`) |
| Self-opening accordion | `components/Disclosure.jsx` |
| Nav hover / hamburger morph / drawer fade | `components/Nav.jsx` |
| Button hover states | `index.css` (`.btn-*` classes) |
| Liquid glass (lensing, rim, pointer light, press swell) | `index.css` (`.liquid-glass`) + `components/useLiquidGlass.js` |
| Format card toss entrance | `components/useCardToss.js` + `data/formatsMotion.js` |
| Format card hover (swell, float, glow, caption) | `pages/Home.jsx` (`FormatCard`) + `index.css` (`.format-card-lift`) |
| Floating quick-contact appear/disappear | `components/QuickContact.jsx` |
| Case study modal fade-in | `components/CaseStudy.jsx` |
