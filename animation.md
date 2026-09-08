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
- Every custom React component (`Reveal`, `GoldThread`, `Ripple`, `Intro`, `Disclosure`, `BackdropVideo`) additionally checks `window.matchMedia('(prefers-reduced-motion: reduce)')` itself in JS and skips its `requestAnimationFrame` loop / `IntersectionObserver` entirely, rendering the finished state immediately.

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
3. The transition uses a custom cubic-bezier, `cubic-bezier(0.33, 0, 0.15, 1)` (`MORPH_EASE`) — matching PowerPoint Morph's characteristic ease-out-of-the-move feel — over a duration set per-instance (default 1400ms, `SECTION_MS`; individual call sites override this, e.g. 900ms for the champagne-film caption, 1100ms for format cards, 1600ms for the About page's larger headings).
4. An optional `delay` prop (in ms) staggers siblings — e.g. Services.jsx staggers a grid of cards by `(i % 3) * 80ms` so a row doesn't land as one flat block.

**Reduced motion:** the component renders the child directly with no wrapping transition styles at all — content is simply present at full opacity/position from the start, and the `IntersectionObserver` is never created.

---

## 5. Gold thread — scroll-drawn SVG line

**File:** [src/components/GoldThread.jsx](src/components/GoldThread.jsx)

A decorative, `aria-hidden` gold hairline that threads from the hero film down into the "What We Direct" cards (and a smaller one beside the testimonials). Rather than fading in, it looks *hand-drawn*: the visible length of the stroke is tied directly to scroll position.

**Step-by-step:**
1. On mount, the component measures the SVG `<path>`'s total length via `pathRef.current.getTotalLength()`.
2. It sets `stroke-dasharray` to that full length and `stroke-dashoffset` to `length * (1 - progress)`, where `progress` starts at `0` — meaning initially the entire dash is offset and nothing is visible.
3. A scroll listener (throttled to one measurement per animation frame via `requestAnimationFrame`) recalculates `progress` on every scroll/resize event: it takes the wrapping `<div>`'s bounding rect, and maps how far the box has travelled through a window spanning `innerHeight * 0.75` — starting when the box's top crosses `innerHeight * 0.95` — into a `0–1` progress value (clamped).
4. As `progress` climbs from 0 to 1, `stroke-dashoffset` shrinks toward 0, so the stroke appears to "draw itself" continuously as the user scrolls the section into view. There's no easing here beyond what natural scroll velocity provides — it's a direct 1:1 mapping to scroll position, not a timed animation.
5. By design, the stroke reaches full length once its box has scrolled about a fifth of the way up the viewport — well before the section is done being read, so what's on screen for most of the dwell time is the *finished* line, not the drawing motion.

**Reduced motion:** `progress` is hard-set to `1` immediately and the scroll listener is never attached — the line renders fully drawn and static.

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
2. **Injecting energy (`poke`)**: on every `pointermove` (mouse/pen only — touch is ignored), the code doesn't just stamp the current point — it walks the line segment from the previous pointer position to the current one in up to 20 sub-steps (more steps for faster movement, so a flick lays down a longer, stronger wake than a slow hover), and at each step "pushes" a soft cosine-falloff dent into the height field (`AMPLITUDE = 0.14`, radius `POKE = 4` cells). A soft falloff is used deliberately — a hard-edged disc would "ring" instead of "displace."
3. **Propagation (`step`, run once per animation frame):** a standard discrete wave-equation update — each cell becomes the average of its four neighbors from the previous frame, minus the cell's own value two frames back, times a damping factor `DAMP = 0.962`. This is what makes disturbances spread outward and ripple realistically instead of just fading in place. At 0.962 damping, a wake takes roughly five seconds to fully die out after the pointer stops moving.
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

**a) Auto-advancing carousel.** A `setInterval` fires every 6000ms (`SLIDE_MS`) and advances `index` to the next testimonial, wrapping at the end. It pauses whenever the pointer hovers the card or a control inside it receives keyboard focus (`onMouseEnter`/`onFocusCapture` set `paused=true`; the matching leave/blur handlers release it), and is disabled entirely if there are fewer than 2 testimonials or reduced motion is on.

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

Four reusable pill-button classes each define a hover transition, all `transition-all duration-300` (300ms) except `.btn-glass`, which uses `duration-500`:

- **`.btn-pill`** — transparent with a gold outline → on hover, fills solid gold and the border brightens, text flips to navy.
- **`.btn-gold`** — solid gold → on hover, brightens to `gold-light`.
- **`.btn-solid`** — dark translucent with a white/20 border → on hover, fills gold, border and text follow.
- **`.btn-glass`** ("Start your event", the site's primary CTA) — the most elaborate: it transitions `color`, `border-color`, `box-shadow`, and `background-color` together over 500ms. At rest it's a barely-there white glass fill with three stacked `box-shadow` values that simulate blown glass (an inner top highlight, a bright inner crescent along the bottom edge, and a soft drop shadow). On hover/focus, all three shadows and the border/background shift from white-toned to gold-toned, and the crescent glow intensifies — the button visually "warms up" from glass to lit gold glass rather than swapping to a flat color block.

Each also has a permanent underlying `Reveal` or `word-in` entrance the first time it appears on screen (see §3, §4) — the hover transition is layered on top of, and independent from, that entrance.

---

## 13. Format cards — image scale, glow, and caption reveal on hover

**File:** [src/pages/Home.jsx](src/pages/Home.jsx) (`FormatCard`)

Each "What We Direct" card (Corporate, Brand, Executive, Experience) has three hover-triggered transitions layered on top of its scroll-triggered `Reveal` entrance (§4):

1. **Image scale:** the photo scales from `1` to `1.05×` over 1200ms `ease-out` on hover — a slow, heavy zoom rather than a snappy one, so it reads as deliberate rather than a UI "bump."
2. **Glow intensification:** the card's drop shadow (a large, soft gold glow, `shadow-[0_0_110px_-34px_...]`) strengthens to a slightly larger/brighter glow (`shadow-[0_0_130px_-24px_...]`) over 700ms.
3. **Caption description reveal:** each card's short description line sits at `opacity-0` and fades to `opacity-100` over 500ms on hover — so the card shows just a title normally, and reveals its one-line description only on hover/focus of the group.

---

## 14. Quick-contact floating button — scroll-gated appear/disappear

**File:** [src/components/QuickContact.jsx](src/components/QuickContact.jsx)

A round WhatsApp button pinned to the right edge, gated by scroll position rather than always visible.

**Step-by-step, on every scroll/resize event:**
1. It computes two booleans: `pastHero` (scrollY > 45% of one viewport height) and `nearEnd` (within 420px of the bottom of the document).
2. It's shown only when `pastHero && !nearEnd` — i.e., it appears once you've scrolled past the hero, and disappears again near the page's end (where a closing CTA takes over the same role), and is hidden entirely on the Contact page (since it would just point at the page you're already on).
3. The show/hide transition itself animates `opacity` (0↔100) and `translateY` (`translate-y-4` hidden → `translate-y-0` shown) together over 500ms — so it eases up into place from slightly below, and eases back down out of sight, rather than just popping.
4. While hidden it also gets `pointer-events-none`, `aria-hidden`, and `tabIndex={-1}`, so it's non-interactive and unreachable by keyboard when invisible.
5. Independently, clicking/pressing it triggers a native `active:scale-95` press-down effect (instant, browser-default active-state transition).

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
| Scroll-drawn gold line | `components/GoldThread.jsx` |
| Hero background zoom/pan | `pages/Home.jsx` (`animate-ken-burns`) |
| Cursor water ripple | `components/Ripple.jsx` |
| Infinite client-logo scroll | `components/LogoMarquee.jsx` |
| Testimonial carousel, sheen, quote fade | `pages/Home.jsx` (`Testimonials`) |
| Self-opening accordion | `components/Disclosure.jsx` |
| Nav hover / hamburger morph / drawer fade | `components/Nav.jsx` |
| Button hover states | `index.css` (`.btn-*` classes) |
| Format card hover (scale/glow/caption) | `pages/Home.jsx` (`FormatCard`) |
| Floating quick-contact appear/disappear | `components/QuickContact.jsx` |
| Case study modal fade-in | `components/CaseStudy.jsx` |
