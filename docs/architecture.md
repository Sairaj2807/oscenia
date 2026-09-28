# Architecture

How the website is put together: stack, file layout, how a page boots and renders, the layering model, performance and accessibility strategies, browser support, and deployment.

---

## Stack

| Layer | Choice | Version |
|---|---|---|
| UI | React | 19.2 |
| Routing | React Router (`BrowserRouter`) | 7.18 |
| Build / dev server | Vite, with `@vitejs/plugin-react` | 8.1 |
| Styling | Tailwind CSS (JIT) + PostCSS + Autoprefixer | 3.4 |
| Lint | oxlint | 1.71 |
| Hosting | Vercel (static) | — |

There's no backend, no CMS, no state library and no animation library. Motion is CSS, `requestAnimationFrame` loops and one canvas simulation. Fonts come from Google Fonts.

### Scripts

```bash
npm install
npm run dev       # Vite dev server, http://localhost:5173
npm run build     # production build to dist/
npm run preview   # serve dist/ locally
npm run lint      # oxlint over the project
```

---

## File layout

```
oscenia-web/
├── index.html              # document shell, meta description, Google Fonts
├── tailwind.config.js      # colour, font, keyframe and animation tokens
├── vercel.json             # SPA rewrites (+ /erp, /erp-guide)
├── animation.md            # every animation, in detail
├── docs/                   # this documentation
├── brand-assets/           # original brand pack: NOT served (see its README)
├── public/                 # served as-is from the site root
│   ├── brand/              # logo SVGs
│   ├── media/              # films, posters, hero still
│   ├── formats/            # "What we direct" photos
│   ├── portfolio/          # portfolio photos (placeholders)
│   ├── erp/                # the built ERP prototype (served at /erp)
│   └── erp-guide.html      # ERP guide (served at /erp-guide)
└── src/
    ├── main.jsx            # entry: providers + router
    ├── App.jsx             # Intro overlay + route table
    ├── index.css           # global CSS, component classes, liquid glass
    ├── introReady.js       # "intro finished" signal (useIntroReady)
    ├── i18n/
    │   ├── dict.js         # ALL visible copy, en + id, plus LANGS
    │   └── LanguageContext.jsx  # LanguageProvider, useI18n
    ├── data/
    │   ├── site.js         # language-independent content: contact, clients, images, portfolio
    │   ├── headline.js     # hero sentence typography tables
    │   ├── formatsMotion.js# gold thread paths, link builder, card-toss timings
    │   ├── deckMotion.js   # About-page motion, from the PowerPoint deck
    │   └── markGeometry.js # logo geometry for the intro zoom
    ├── pages/              # Home, About, Services, Contact, NotFound
    └── components/         # shared components and hooks (see components.md)
```

### Where to make a change

| To change… | Edit |
|---|---|
| Any visible text | `src/i18n/dict.js` (both languages) |
| Contact details, images, clients, projects | `src/data/site.js` |
| A colour, font or keyframe token | `tailwind.config.js` |
| Buttons, glass, backgrounds, global rules | `src/index.css` |
| A section's layout | the page file in `src/pages/` |
| Motion timing | `src/data/*.js` first, then the component (see [animation.md](../animation.md)) |

---

## How a page renders

### Boot

`main.jsx` mounts:

```
<StrictMode>
  <LanguageProvider>        ← chooses en/id, provides t
    <BrowserRouter>
      <App/>
```

`App` renders two siblings:

```
<Intro/>                     ← full-screen overlay, z-[100]
<Routes>
  <Route element={<Layout/>}>   ← shell for every page
    /          → Home
    /about     → About
    /services  → Services
    /contact   → Contact
    *          → NotFound
```

The **route renders underneath the intro immediately**, so images and films start loading while the visitor watches the splash and showreel. The page is ready the moment the overlay lifts.

### The intro handshake

Some home-page animations must not start until the overlay is gone, or they'd finish unseen behind it. The mechanism:

1. When the intro ends (film end, Skip, or Escape), `Intro` dispatches `window` event `oscenia:intro-done`.
2. `src/introReady.js` listens once and flips a module-level `done` flag.
3. `useIntroReady()` returns that flag as React state. `KineticHeadline`, the hero CTA and `Ripple` (on `/`) wait for it.
4. Because the flag is module-level, returning to `/` later resolves to `true` immediately.

### The shell (`Layout`)

`bg-oscenia isolate min-h-screen` → `ScrollToTop`, `Ripple`, `Nav`, `<main>`, `QuickContact`, then `Footer` on every route except `/`. Home renders `<Footer overlay/>` itself, on top of its closing film.

### Content flow

```
dict.js ──► useI18n().t ──► components (text)
site.js ──► imported directly ──► components (links, images, data)
```

Several lists pair by index across the two files (portfolio titles ↔ `PORTFOLIO`, format items ↔ `FORMAT_IMAGES`, `eventTypes` ↔ `PORTFOLIO[i].type`). See [content-guide.md §1.3](content-guide.md#13-lists-that-line-up-by-position).

---

## Layering

| z-index | Element | Why |
|---|---|---|
| `z-[100]` | Intro overlay | Above everything, including the header |
| `z-50` | Header (`Nav`), case-study dialog | The dialog is `fixed` inside `<main>`, so it competes with the header at the root level and covers it |
| `z-40` | WhatsApp bead | Below the header and dialogs |
| `z-10` | Home "What we direct" section | Thread two's tail runs past the section's foot and must draw over the testimonials' background |
| — | Page content | Normal flow |
| `-z-10` | Ripple canvas (`fixed`) | Behind content, above the page background |

**The key trick** is `isolate` on the `Layout` wrapper. It makes the shell its own stacking context, so the ripple's negative z-index lands between the shell's background and its content. The alternative, lifting all content into a `z-10` wrapper, would have trapped the case-study dialog's `z-50` inside that wrapper and let the header float over an open dialog.

Inside sections, background films use `absolute inset-0 -z-10` inside an `isolate` section, with a `sticky top-0 h-[100svh]` frame. Hero and closing sections therefore **don't use `overflow-hidden`** on the section itself: that would make the section the sticky element's scroll container and pin the film to the section instead of the screen. The sticky frame clips itself.

In the "What we direct" grid, the three `GoldThread` boxes are rendered **before** the card list, so the cards paint over the thread. That's how the thread passes "under" photos.

---

## Performance

| Technique | Where | Effect |
|---|---|---|
| Lazy background films | `BackdropVideo` | Poster `<img>` until the section is within 1.5 screens, then the `<video>`. About 5 MB no longer downloads on page load |
| Posters for every film | `public/media/*-poster.jpg` | No blank rectangles while a film loads |
| Lazy images | `Media`, format cards, logos | `loading="lazy"`; the hero still is `fetchPriority="high"` |
| Films encoded for streaming | `public/media/*.mp4` | H.264 with faststart; playback starts before the download completes |
| Self-stopping animation loops | `Ripple`, `GoldThread`, intro | rAF loops run only while something is moving. The ripple stops when the surface is calm and restarts on the next mouse move |
| Coarse simulation grid | `Ripple` | One cell per 10px, upscaled: about 100× cheaper than full resolution, and softer |
| Scroll handlers batched | `GoldThread`, `QuickContact` | Passive listeners; thread drawing is coalesced to one update per frame |
| Direct style writes | `useCardToss`, intro zoom, gold thread | Per-frame motion writes to the DOM directly, not through React re-renders |
| Tiny frame sampling | Intro portrait letterbox | Reads the showreel at 16×9 pixels per frame to colour the bars |
| Brand pack outside `public/` | `brand-assets/` | 377 MB of source material is kept out of every build |
| Fonts preconnected | `index.html` | `preconnect` to Google Fonts; `display=swap` |

---

## Accessibility

**Motion preferences.** With `prefers-reduced-motion: reduce`:

| Feature | Behaviour |
|---|---|
| Section reveals (`Reveal`) | Rendered in place, no transition |
| Hero words | Land instantly |
| Self-opening copy (`Disclosure`, "Stands for" circles) | Start open; no timers |
| Background films | Stay as posters |
| Ken Burns, marquee, testimonial sheen | Stopped |
| Testimonial carousel | No auto-advance (arrows still work) |
| Gold threads | Drawn complete, not scroll-driven |
| Card toss, hover lift | Off |
| Cursor ripple | Off entirely |
| Intro | Logo click goes straight to the site; no zoom, no showreel |
| Smooth scrolling | Off |

**Transparency preference.** With `prefers-reduced-transparency: reduce`, liquid glass becomes opaque navy with no backdrop blur.

**Keyboard and screen readers.**
- Every control is a real `<button>` or `<a>`; custom focus rings are 1px gold (`focus-visible`).
- The intro moves focus to its one control at each stage (the logo, then Skip), so Tab doesn't wander into the page behind it. Escape ends the intro.
- Dialogs (intro, case study) use `role="dialog"` and `aria-modal`; the case study closes on Escape.
- The mobile drawer button carries `aria-expanded` / `aria-controls`; disclosures and circles carry `aria-expanded`; the language chips carry `aria-pressed`.
- Decorative layers (films, threads, ripple, icons) are `aria-hidden`. The kinetic headline and the logo marquee each provide one screen-reader-only plain copy.
- The WhatsApp bead is removed from the tab order while hidden.
- `<html lang>` follows the chosen language.
- Carousel dots are visually 10px but sit in 44px buttons.

**Touch devices.** Hover-only effects are gated by `(hover: hover)`, so a tap never leaves a card glowing. Portfolio tiles mirror their hover state under `(hover: none)`, so they're always in colour and titled on phones.

---

## Browser support

The site works in all current browsers. A few effects degrade gracefully:

| Feature | Full effect | Elsewhere |
|---|---|---|
| Liquid-glass lensing (SVG filter in `backdrop-filter`) | Chromium (Chrome, Edge, Opera, Android) | Blur, tint, rim and highlight only |
| Gliding glass highlight and rim fade (`@property`) | Chromium, Safari 16.4+, Firefox 128+ | Highlight jumps instead of gliding |
| Showreel with sound | All, after the logo click (a user gesture) | Falls back to muted if a browser refuses |
| Portrait letterbox fade (`mask-image`) | All current (with `-webkit-` prefix for Safari) | — |
| `svh` units | All current | — |

---

## Deployment

Hosted on **Vercel** as a static site. `npm run build` outputs `dist/`.

`vercel.json` rewrites, in order:

| Request | Served | Why |
|---|---|---|
| `/erp-guide` | `/erp-guide.html` | Standalone ERP guide page |
| `/erp/…` | `/erp/index.html` | The ERP prototype's own SPA |
| everything else | `/index.html` | The website SPA, so deep links like `/about` work on refresh |

**The ERP prototype** is a separate Vite app in `../erp-prototype/`, built with `base: '/erp/'` in production. Its build output is placed in `public/erp/`, so it ships with the website and is served under `/erp`. After changing the ERP, rebuild it and replace `public/erp/`. The ERP has its own documentation in the repository's `docs/` folder.

---

## Known issues

| Issue | Where | Notes |
|---|---|---|
| `CTA` ignores its `children`, so "Explore More" would render as "Start your event" | `components/CTA.jsx`, used in `Services.jsx` | Invisible today, because "Explore More" is hidden until `EXPLORE_MORE_TO` is set. Fix `CTA` to render `children ?? t.common.startEvent` before enabling it |
| The intro plays on every page load | `components/Intro.jsx` | A comment in `App.jsx` says "first visit of a session", but no session memory is implemented |
| The contact form hands off to `mailto:` | `pages/Contact.jsx` | Needs a real endpoint before launch |
| The Skip button (black pill) is hard to see on the showreel's black scenes | `components/Intro.jsx` | Consider an outline or glass treatment |

See also the [launch checklist](content-guide.md#launch-checklist) for placeholder content.
