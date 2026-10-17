# Components

Every shared component and hook in `src/components/`: what it's for, its props, and the rules for using it. Page-specific sub-components (for example `FormatCard` in `Home.jsx`) are described in [pages.md](pages.md).

Conventions that hold across all of them:

- **Copy comes from the dictionary.** Components call `useI18n()` and read `t.…`; nothing user-visible is hard-coded. See [content-guide.md](content-guide.md).
- **Reduced motion is handled inside the component.** Each one checks `prefers-reduced-motion` and renders its final, static state. Callers never need to.
- **Decorative layers are `aria-hidden`.** Where a visual effect duplicates text (the kinetic headline, the logo marquee), a screen-reader-only copy carries the meaning once.

---

## Layout and navigation

### `Layout`
The shell every route renders inside (a React Router layout route).

- Renders: `ScrollToTop` → `Ripple` → `Nav` → `<main><Outlet/></main>` → `QuickContact` → `Footer` (skipped on `/`, where Home renders its own overlay footer).
- The wrapper is `bg-oscenia isolate min-h-screen`. `isolate` creates a stacking context so the ripple canvas (`-z-10`) sits above the page background but below all content, without any other element needing a z-index.
- `ScrollToTop` snaps to the top on every path change with `behavior: 'instant'`, which overrides the global `scroll-behavior: smooth`.

### `Nav`
The fixed header and the mobile drawer. No props.

- `pointer-events-none` on the `<header>` and `pointer-events-auto` on its children, so the transparent header never blocks clicks on the page beneath it.
- Links come from `NAV` in `site.js`, **minus `/contact`**: Contact is the "Let's Talk Further" pill. The Services link is labelled with `t.nav.service` ("Service") in the header and `t.nav.services` ("Services") in the footer, matching the reference design.
- **Drawer state** is stored as *the path it was opened on*, not a boolean. When the route changes the stored path no longer matches, so the drawer closes itself on navigation, including browser back, without an effect.
- While the drawer is open, `body` scrolling is locked.
- `LangToggle` (internal) renders one chip per entry in `LANGS` (`i18n/dict.js`), with `aria-pressed` on the active one.

### `Footer`
| Prop | Type | Default | Meaning |
|---|---|---|---|
| `overlay` | boolean | `false` | `true` = transparent, for laying over a film (Home). `false` = its own navy panel with a top rule |

Four columns at `md` and up: brand mark, *See More* (`NAV` minus Contact), *Follow Along* (`FOLLOW`), *Contact Us* (`CONTACT.phone`, `CONTACT.email`). Then the legal line: `t.footer.copyright` and `CONTACT.locations`.

### `BrandMark`
The Oscenia logo, always from the supplied SVG files, never rebuilt in markup.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `variant` | `'horizontal'` \| `'stacked'` | `'horizontal'` | Which lockup |
| `className` | string | `'h-9'` | Set the **height** here; width follows |
| `to` | string | `'/'` | Link target |
| `onClick` | function | — | Extra click handler (Nav uses it to close the drawer) |
| `as` | `'link'` \| `'plain'` | `'link'` | `'plain'` returns just the `<img>` |

---

## Calls to action

### `CTA`
"Start your event" as a plain pill, for inner pages.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `variant` | `'pill'` \| `'solid'` | `'pill'` | `.btn-pill` (gold outline) or `.btn-solid` (dark fill) |
| `to` | string | `'/contact'` | Destination |
| `className` | string | `''` | Extra classes |

The label is always `t.common.startEvent`. Services passes its own children for "Explore More", but `CTA` itself ignores `children`. See the note in [architecture.md](architecture.md#known-issues).

### `GlassCTA`
"Start your event" in liquid glass: the home page's one repeated action. Props: `to` (default `/contact`), `className`. Combines `.liquid-glass` (material), `.btn-glass` (shape and type) and `useLiquidGlass` (pointer highlight and lensing).

### `QuickContact`
The floating WhatsApp bead. No props.

| Constant | Value | Meaning |
|---|---|---|
| `APPEAR_AFTER` | `0.45` | Appears after scrolling 45% of the viewport height |
| `END_ZONE_PX` | `420` | Hides within 420px of the page bottom, where the closing CTA and footer take over |

It's not rendered on `/contact`. While hidden it's also removed from the tab order (`tabIndex -1`, `aria-hidden`). It links to `CONTACT.whatsapp` in a new tab.

### `useLiquidGlass()`
Returns a **callback ref** to attach to any `.liquid-glass` element.

- Tracks the pointer over the element and writes `--lg-x` / `--lg-y`, which the CSS highlight follows.
- **Chromium only:** builds an SVG displacement filter sized to the element's exact box and corner radius, and passes it to the CSS as `--lg-refract`, so the content behind the rim bends like a lens. It's rebuilt whenever the element resizes. Other browsers keep blur and tint only.
- Tuning: `BEVEL = 0.3` (rim depth as a fraction of the short side), `PULL = 0.85` (how far content bends at the edge).
- A callback ref rather than a ref object, because the bead unmounts and remounts when entering and leaving `/contact`.

---

## Content blocks

### `Reveal`
Slides its children into view when scrolled to. The standard entrance for all sections.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `from` | `'up'` `'down'` `'left'` `'right'` `'scale'` `'top-left'` `'top-right'` `'bottom-left'` `'bottom-right'` | `'up'` | Direction it travels in from |
| `delay` | ms | `0` | Start delay, for staggering siblings |
| `duration` | ms | `1400` | Travel time |
| `once` | boolean | `false` | Play only the first time. By default it **replays** every time the section comes back into view |
| `as` | element type | `'div'` | Wrapper tag |
| `className` | string | `''` | Applied to the wrapper |

- It plays when 15% is visible and resets only when 0% is visible. The two thresholds stop flicker at the boundary.
- The easing is `cubic-bezier(0.33, 0, 0.15, 1)`, modelled on PowerPoint Morph.
- Horizontal travel is halved below 640px (2rem instead of 4rem) so content doesn't push past a phone's edge.

### `Disclosure`
A block of body copy that **opens itself** a moment after its section is reached, with a `+` toggle to open and close it by hand.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `summary` | node | — | Always-visible heading, rendered inside the toggle button |
| `children` | node | — | The panel |
| `autoOpenAfter` | ms or `null` | `900` | Delay before auto-opening once 30% visible; `null` disables it |
| `from` | `'up'` \| `'down'` \| other | `'up'` | The panel's slight travel while opening |
| `align` | `'start'` \| `'center'` | `'start'` | Summary alignment |
| `className`, `summaryClassName`, `panelClassName` | string | `''` | Styling hooks |

- It closes again when the section scrolls away, so returning replays it. Once the visitor uses the toggle, auto-opening stops for good.
- Height animates with the `grid-rows-[0fr] → [1fr]` technique, which needs no measured heights and works at any content length.
- Accessible: `aria-expanded` and `aria-controls` on the button. Under reduced motion the panel starts open.

### `Media`
An image, or a finished-looking placeholder when there's no image yet.

| Prop | Type | Meaning |
|---|---|---|
| `src` | string | Image path. Empty = placeholder |
| `label` | string | Alt text; also the italic caption shown on the placeholder |
| `className` | string | Wrapper classes. If it includes `absolute`, `fixed`, `relative` or `sticky`, `Media` doesn't add its own `relative` |
| `imgClassName` | string | Classes for the `<img>` |
| `children` | node | Overlaid on top |

Images are `object-cover` and `loading="lazy"`.

### `BackdropVideo`
A full-bleed looping background film.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `src` | string | — | MP4 path |
| `poster` | string | — | Still shown until the video loads, and permanently under reduced motion |
| `eager` | boolean | `false` | Load immediately (intro splash). Otherwise waits until the section is within 1.5 screens |
| `className` | string | `''` | Applied to the `<img>` or `<video>` |

It renders the **poster `<img>`** until it's needed, then swaps to a `<video autoplay muted loop playsinline>`. That saves around 5 MB of video that used to download on page load.

### `Icon`
| Prop | Default | Meaning |
|---|---|---|
| `name` | — | `'instagram'`, `'linkedin'`, `'tiktok'`, `'whatsapp'`, `'arrow'` |
| `className` | `'h-5 w-5'` | Size; colour comes from `currentColor` |
| `strokeWidth` | `1.5` | Stroke weight |

Always `aria-hidden`. Label the surrounding link or button instead. To add an icon, add its 24×24 SVG children to `paths`.

### `LogoMarquee`
The paper client strip. No props; reads `CLIENTS` from `site.js`.

- It renders the list twice and moves by exactly −50% every 38s, which gives a seamless loop.
- An entry with a `logo` path renders the image (`h-8` → `sm:h-10`, 80% opacity). Without one, the name renders in the brand serif.
- The moving track is `aria-hidden`; a visually hidden list carries the names once for screen readers.

### `CaseStudy`
The portfolio project dialog.

| Prop | Type | Meaning |
|---|---|---|
| `project` | object | A `PORTFOLIO` entry: `{ client, logo, img, type, gallery }` |
| `title` | string | Project title (`t.services.portfolio[i]`) |
| `onClose` | function | Called on Close, backdrop click or Escape |

`role="dialog"`, `aria-modal`, locks `body` scroll while open, `z-50`, fades in over 1.2s. The event type is looked up as `t.contact.eventTypes[project.type]`, so it translates automatically.

---

## Home-page motion

### `KineticHeadline`
The hero sentence as composed type.

| Prop | Type | Meaning |
|---|---|---|
| `lines` | `string[][]` | Fragments per line: `t.hero.headline` |
| `plain` | string | The whole sentence as plain text, for screen readers: `t.hero.tagline` |
| `className` | string | Applied to the `<h1>` |

Styling per fragment comes from `data/headline.js` (see [design-system.md §3.5](design-system.md#35-the-hero-sentence)). The words hold invisible until `useIntroReady()` is true, then land 380ms apart over 1.1s each.

### `GoldThread`
One scroll-drawn hairline. Used three times in `Home.jsx`: thread one, the link, and thread two.

| Prop | Type | Default | Meaning |
|---|---|---|---|
| `d` | string | — | SVG path |
| `viewBox` | string | — | Coordinate space; the path is stretched to the box (`preserveAspectRatio="none"`) |
| `from` / `to` | number | `0.95` / `0.2` | Where the box's top edge sits, as a fraction of the viewport height, when drawing starts and finishes |
| `pacing` | `[progress, drawn][]` | linear | Maps scroll progress to fraction drawn, joined by a monotone curve that never runs backwards |
| `width` | px | `2.2` | Stroke width (non-scaling, so it stays a hairline however far the box stretches) |
| `className`, `style` | — | — | Positioning (`style.top` / `style.height` for runtime-placed boxes) |

- Stroke colour `rgba(238, 225, 188, 0.92)`. It's `aria-hidden`, and drawn complete under reduced motion.
- The dash length is measured **in screen pixels**, re-measured on resize. With a non-scaling stroke, Chromium lays out the dash in screen space, so a length from `getTotalLength()` (viewBox units) would stop short.
- Paths and the runtime link builder (`buildLink`) are in `data/formatsMotion.js`. Every joint in the paths is tangent-continuous, so the line never kinks.

### `useCardToss(side)`
The "thrown onto the table" entrance for a format card. `side` is `'left'` or `'right'`.

Returns four refs: `slot` (the grid cell, which is what's observed), `photo`, `slide` (caption, sideways move) and `rise` (caption, upward move). It writes styles directly rather than through React state, so a flight never waits on a render. Scrolling up throws the card back out: once the slot's top drops below `TOSS.exitLine` (60% of the screen), `retreat()` plays the flight in reverse, with mirrored delays and each easing curve rotated 180° (`reverseEase`). Scrolling down past that line relaunches it from wherever it is. Timings and curves are in `TOSS` in `data/formatsMotion.js`. There's a gentler variant below 640px, and nothing under reduced motion.

### `Ripple`
The cursor water ripple. No props; mounted once in `Layout`.

| Constant | Value | Meaning |
|---|---|---|
| `CELL` | `10` | Simulation grid: one cell per 10 CSS px, upscaled (soft by design) |
| `DAMP` | `0.95` | Energy kept per frame; the wake settles in ~1–1.5s |
| `POKE` / `AMPLITUDE` | `3` / `0.1` | Size and depth of each mouse dent |
| `GAIN` / `OPACITY` | `1.3` / `0.65` | Brightness |
| `CREST` / `TROUGH` | gold-light / navy-500 | Colours |

It runs only while there's visible motion (the loop stops when the surface is calm) and restarts on the next mouse move. It ignores touch, pauses when the tab is hidden, and on Home waits for the intro to finish. It's disabled under reduced motion.

### `Intro`
The opening overlay. See [pages.md](pages.md#intro-overlay-first-load-any-route) for what it does and [animation.md §2](../animation.md) for the frame-by-frame spec. Constants of note: `SPLASH_EXIT_MS 1450`, `PUSH_FROM_MS 400`, `COVER_MS 1300`, `INK_STOPS`. The helper `playWithSound(video)` plays unmuted and falls back to muted if the browser refuses.

---

## Shared state

### `useI18n()` (`i18n/LanguageContext.jsx`)
Returns `{ lang, setLang, t }`.

- `t` is the current language's dictionary (`dict.en` or `dict.id`).
- **Initial language:** a saved choice in `localStorage['oscenia-lang']` → the browser language if it starts with `id` → English.
- Changing language updates `<html lang>` and saves the choice.

### `useIntroReady()` (`src/introReady.js`)
Returns `true` once the intro overlay has finished (`oscenia:intro-done`). The flag lives at module scope, so a component mounted later, after navigating back to `/`, gets `true` immediately rather than waiting for an event that already fired.
