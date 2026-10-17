# Oscenia Website: Complete Guide

How the whole site works, how it is built, and how to rebuild it from nothing.

This guide has two companions:

- [COMPLETE-SOURCE-CODE.md](COMPLETE-SOURCE-CODE.md): every text file of the project, verbatim (58 files). Copy these and the site exists.
- The assets (images, films, audio): inventoried in [§9](#9-asset-inventory), with where each came from and how it was encoded.

Rebuilding means: this guide for understanding, the source file for the code, the asset inventory for the media.

> **Older docs.** `README.md`, `animation.md` and the other files in this folder were written earlier. Their Services and About sections describe an older design (a portfolio grid with a dialog; a self-opening-circles About page). This guide matches the code as it is now. Where they disagree, trust this guide, then the source.

## Contents

1. [What the site is](#1-what-the-site-is)
2. [Stack and setup from zero](#2-stack-and-setup-from-zero)
3. [Repository layout](#3-repository-layout)
4. [How the app boots and renders](#4-how-the-app-boots-and-renders)
5. [Design system](#5-design-system)
6. [Content model and languages](#6-content-model-and-languages)
7. [Pages, section by section](#7-pages-section-by-section)
8. [Components and hooks](#8-components-and-hooks)
9. [Asset inventory](#9-asset-inventory)
10. [Motion reference](#10-motion-reference)
11. [Accessibility, performance, browsers](#11-accessibility-performance-browsers)
12. [Deployment](#12-deployment)
13. [Rebuild procedure, step by step](#13-rebuild-procedure-step-by-step)
14. [Known issues and open items](#14-known-issues-and-open-items)

---

## 1. What the site is

The marketing site for **Oscenia Events**, a strategic events and immersive-experiences company (Jakarta, Bali, Singapore). It is bilingual (English and Bahasa Indonesia), film-led and heavily animated. There is no backend and no CMS.

| Route | What is there |
|---|---|
| (first load, any route) | **Intro** overlay: gold logo on navy velvet, click, logo zooms into the screen, company showreel with sound, then the site |
| `/` | Hero photo with a kinetic headline and client strip, "What we direct" (four tossed-in cards and a scroll-drawn gold thread), rotating testimonials, closing film with the footer on it |
| `/about` | One scroll-played film: blue satin opens, the name spelled phonetically, three pillars as champagne bubbles over a flute, the vision on a card drawn from an envelope, three values over two-colour satin |
| `/services` | Pinned stage: photographed theatre curtains part, a bead curtain swings with the pointer; then the heading and a six-tile portfolio that gathers from a scattered collage |
| `/services/:slug` | A case page for one project: hero (the tile's photo grows into it), write-up, a photo strip, a way back |
| `/contact` | Enquiry form (opens the visitor's mail app) and a dark-themed map |
| anything else | 404 |

On every page: a transparent header with an EN/ID toggle, a gold water ripple that follows the mouse, a floating liquid-glass WhatsApp button, inertia scrolling, ambient sound with a mute button (bottom left) and a click "pop".

---

## 2. Stack and setup from zero

| Layer | Choice | Version in `package.json` |
|---|---|---|
| UI | React | ^19.2.7 |
| Routing | React Router (`BrowserRouter`) | ^7.18.1 |
| Smooth scroll | Lenis | ^1.3.26 |
| Build and dev server | Vite with `@vitejs/plugin-react` | ^8.1.1 / ^6.0.3 |
| Styling | Tailwind CSS 3 + PostCSS + Autoprefixer | ^3.4.19 / ^8.5.22 / ^10.5.4 |
| Lint | oxlint | ^1.71.0 |
| Hosting | Vercel (static) | n/a |

No state library and no animation library. Motion is CSS, `requestAnimationFrame` loops, two canvas simulations (the cursor ripple and the bead curtain) and one DOM-driven physics scene (the champagne bubbles). Fonts come from Google Fonts.

```bash
mkdir oscenia-web && cd oscenia-web
# create the files from COMPLETE-SOURCE-CODE.md and add the assets (section 9)
npm install
npm run dev        # http://localhost:5173
npm run build      # dist/
npm run preview    # serve dist/
npm run lint       # oxlint
```

The Vite config is the default React one (`plugins: [react()]`). Tailwind scans `./index.html` and `./src/**/*.{js,jsx}`.

---

## 3. Repository layout

```
oscenia-web/
├── index.html              document shell, meta, Google Fonts links
├── package.json  vite.config.js  tailwind.config.js  postcss.config.js
├── vercel.json             SPA rewrites (plus /erp and /erp-guide)
├── docs/                   documentation (this file lives here)
├── brand-assets/           original brand pack, NOT served (377 MB)
├── public/                 served from the site root
│   ├── brand/              logo SVGs
│   ├── media/              hero still, intro films, home films, posters
│   ├── formats/            the four "What we direct" photos
│   ├── about/              About films, posters, bubbles, envelope, card
│   ├── services/           curtains, valance, velvet, six event photos, bead sprites
│   ├── sound/              ambience.mp3, pop.wav
│   ├── erp/                a built ERP prototype served at /erp (separate app)
│   └── favicon.svg
└── src/
    ├── main.jsx            entry: providers and router
    ├── App.jsx             Intro overlay plus the route table
    ├── index.css           global CSS, component classes, liquid glass
    ├── introReady.js       "intro finished" signal
    ├── i18n/               dict.js (all copy, en and id), LanguageContext.jsx
    ├── data/               site.js and the measured typography and motion tables
    ├── pages/              Home, About, Services, ServiceCase, Contact, NotFound
    └── components/         shared components and hooks
```

`src/components/LetterCurtain.jsx` is an obsolete file (the old letter curtain). Nothing imports it; it can be deleted. It is not in the source listing.

**Where to change things**

| To change | Edit |
|---|---|
| Any visible text, either language | `src/i18n/dict.js` |
| Contact details, clients, portfolio, image paths | `src/data/site.js` |
| A colour, font, keyframe | `tailwind.config.js` |
| Buttons, glass, backgrounds, global rules | `src/index.css` |
| A section's layout | the page file in `src/pages/` |
| Motion numbers | `src/data/*.js`, then the component |
| Sound levels | constants at the top of `components/Sound.jsx` |
| Bead curtain feel | constants at the top of `components/BeadCurtain.jsx` |

---

## 4. How the app boots and renders

```
main.jsx
 └─ StrictMode
     └─ LanguageProvider            chooses en or id, provides t
         └─ BrowserRouter
             └─ App
                 ├─ Intro            full-screen overlay (z-[100])
                 └─ Routes
                     └─ Layout       shell for every route
                         ├─ /            Home
                         ├─ /about       About
                         ├─ /services    Services
                         ├─ /services/:slug  ServiceCase
                         ├─ /contact     Contact
                         └─ *            NotFound
```

**The route mounts under the intro immediately**, so images and films load while the visitor watches the splash. The page is warm when the overlay lifts.

**Intro handshake.** When the intro ends (film end, Skip, Escape) it dispatches `window` event `oscenia:intro-done`. `introReady.js` listens once and sets a module-level flag; `useIntroReady()` returns it. The hero headline, hero CTA and the home ripple wait for it, so they do not finish unseen behind the overlay. Because the flag is module-level, returning to `/` later resolves to `true` immediately.

**Shell (`Layout`).** A `div.bg-oscenia.isolate.min-h-screen` containing, in order: `ScrollToTop`, `Ripple`, `Nav`, `<main><Outlet/></main>`, `QuickContact`, `Sound`, and `Footer` on every route except `/` (Home places its own footer over its closing film). It also calls `useSmoothScroll()`.

- `ScrollToTop` runs in a layout effect on path or hash change. It stops Lenis, jumps with `behavior: 'instant'` (to the top, or to the `#hash` element, as the case page's Back lands on `#portfolio`), then restarts and resizes Lenis.
- `isolate` makes the shell a stacking context. The ripple canvas has `-z-10`, so it sits above the shell background and below all content without anything else needing a z-index. Lifting content into a `z-10` wrapper instead would trap fixed overlays inside it.

**Layering (z-index)**

| z | Element |
|---|---|
| `z-[100]` | Intro overlay |
| `z-50` | Header (`Nav`) |
| `z-40` | WhatsApp bead (`QuickContact`) and sound button (`Sound`) |
| `z-10` | Home "What we direct" section, About "Why Oscenia", Services portfolio (they pull up over the previous pinned scene or draw tails past their foot) |
| `-z-10` | Ripple canvas |
| `-z-20` | Services velvet background (fixed) |

**Sticky film pattern.** Hero, closing and scene sections use `absolute inset-0 -z-10` inside an `isolate` section, holding a `sticky top-0 h-[100svh]` frame. The section itself must **not** use `overflow-hidden`, or it becomes the sticky element's scrollport and the film pins to the section instead of the screen. The sticky frame clips itself.

**Scroll-progress scenes.** `useScrollProgress('pin' | 'pass')` returns `[ref, p]` with `p` from 0 to 1. A tall runway section (for example `h-[240vh]`) holds a `sticky` child; `p` is how far through the runway the page has scrolled. Helpers `span(p, a, b)`, `easeOut`, `easeInOut`, `clamp01` carve one progress into separate beats. The About and Services scenes are all built this way, with styles computed from `p` and written in React.

---

## 5. Design system

**Character.** A darkened room lit in gold: near-black and navy grounds, a light high-contrast serif, gold used as light (hairlines, glows, rims) rather than fill, and full-bleed film between sections.

### Colours (`tailwind.config.js`)

| Token | Hex | Use |
|---|---|---|
| `navy-950` | `#04070f` | Page base, footer panel, drawer, scrims |
| `navy-900` | `#060b16` | Bottom of the page gradient |
| `navy-800` | `#0a1424` | Placeholders, select background |
| `navy-700` | `#0f1d33` | available |
| `navy-600` | `#16294a` | available |
| `navy-500` | `#1f3760` | Ripple trough colour |
| `gold` | `#c6a15b` | Hairlines, borders, `.btn-gold`, focus rings |
| `gold-light` | `#e0c789` | Headings, eyebrows, hover text |
| `gold-dark` | `#9c7c3f` | available |
| `paper` | `#f4f3ee` | Client strip (sampled from the showreel's light chapters) |
| `paper-dim` | `#e7e4da` | available |

Body text is white at reduced opacity (`text-white/75`, `/60`, `/45`) so it takes the colour of what is behind it. About uses cream `#efe3c4` for display text over satin.

### Type

| Family | Tailwind | Role |
|---|---|---|
| Fraunces (variable, opsz 9..144, weight 100..400, roman and italic) | `font-serif`, `font-display` | Headings, hero, captions, nav, buttons |
| Plus Jakarta Sans (300..700) | `font-sans` (default) | Body, forms, labels |
| Noto Serif italic 300, subset to two characters (ɒ, ɛ) | `font-phonetic` | The About page's `/ɒ.sɛ.ni.ə/` only |

Brand rule: only Fraunces Thin, Light, Regular and Italic. The font request is capped at weight 400. `index.css` sets `.font-display` to weight 300, `opsz` 144 and `.font-serif` to weight 300, `opsz` 72. Italic is a voice, not emphasis. The Google Fonts links, including the `text=%C9%92%C9%9B` subset URL, are in `index.html`.

Labels are wide-tracked: `.eyebrow` is `text-[11px] tracking-[0.4em] uppercase text-gold/80`; buttons use `text-xs tracking-[0.2em] uppercase`.

### Buttons and surfaces (`index.css`)

| Class | Look |
|---|---|
| `.btn-pill` | 1px `gold/70` outline, transparent; hover fills gold |
| `.btn-gold` | Solid gold, navy text; hover `gold-light` |
| `.btn-solid` | `bg-black/60`, 1px `white/20`; hover gold |
| `.liquid-glass` + `.btn-glass` | Refractive glass CTA (see below) |
| `.liquid-glass--bead` | Frostier navy-tinted round glass with a gold rim (WhatsApp and sound buttons) |
| `.bg-oscenia` | Navy radial glow at the top over a `#060b16` to `#04070f` gradient |
| `.bg-abyss` | `#000` to `#0d1a2a` vertical, for the testimonials |
| `.hairline` | 1px transparent to gold to transparent rule |

**Liquid glass.** `.liquid-glass` supplies blur, saturation, a faint tint, a specular rim (`::before`), a pointer highlight (`::after`) that follows `--lg-x`/`--lg-y` (registered with `@property`), a gold warm-up on hover and focus, and a spring "swell" on press. `useLiquidGlass()` writes the pointer variables and, in Chromium only, builds a per-element SVG displacement filter so the content behind the rim bends. `BEVEL = 0.3`, `PULL = 0.85`. Under `prefers-reduced-transparency` it becomes opaque; under reduced motion the scaling is removed.

**Shadows are gold light**, with negative spread so they read as glow behind an object (for example the format card halo `0 0 130px -24px rgba(198,161,91,0.95)`).

**Radii.** `rounded-full` for buttons and chips; `rounded-[3.25rem]` (mobile `2rem`) for the testimonial card; `rounded-[1.25rem]` for format photos. Services event photos use `EVENT_RADIUS` = `borderRadius: '5.87% / 9.24%'`, matching the designer's rounded-corner PNGs (46px on 783×498).

**Containers.** `max-w-content` is 1200px. Side padding `px-6` by default. Inner pages start at `pt-40`. Home sections use `svh` units so mobile toolbars do not resize them. Breakpoints are Tailwind defaults (640, 768, 1024, 1280).

**Reduced-motion and hover gating.** Hover-only effects are wrapped in `(hover: hover)`; touch devices see the hover state permanently where it carries information (Services tiles).

---

## 6. Content model and languages

All visible copy is in `src/i18n/dict.js`: one object `dict` with two same-shaped keys, `en` and `id`, plus `LANGS`. Components call `const { t, lang, setLang } = useI18n()` and read `t.hero`, `t.about`, etc. Nothing user-visible is hard-coded.

`LanguageContext.jsx`: initial language is `localStorage['oscenia-lang']`, else the browser language if it starts with `id`, else `en`. Changing it updates `<html lang>` and saves the choice.

Top-level keys of each language: `langName`, `nav`, `common`, `intro`, `hero` (`headline` as an array of lines of fragments, `tagline`, `subline`), `direct` (eyebrow, heading, four `items`), `testimonials`, `about` (`heroTitle`, `intro`, `name`, `standsFor`, `vision`, `why`, `value`), `services` (`eyebrow`, `heading` pair, `caseStudy`, `cases` keyed by slug), `contact` (labels, `eventTypes`, mail template, office), `footer`, `notFound`.

`src/data/site.js` holds language-independent data: `CONTACT` (phone, email, WhatsApp, address, map URLs, locations), `SOCIALS`, `FOLLOW`, `NAV` (paths and keys only), `CLIENTS` (seven blank placeholders), `FORMAT_IMAGES`, `EVENT_RADIUS`, and `PORTFOLIO`.

Each `PORTFOLIO` entry is `{ slug, client, logo, img, type, gallery }`. Six placeholders: `brand-a` to `brand-f`. `type` indexes `t.contact.eventTypes`. `img` is `/services/event-N.webp`; every case's `gallery` is all six.

**Lists that line up by position** (keep their order in sync): `FORMAT_IMAGES[i]` with `t.direct.items[i]`; `PORTFOLIO[i].type` with `t.contact.eventTypes`; a project's write-up is `t.services.cases[slug]`, falling back to `t.services.caseStudy`.

The hero headline is composed type tabled in `src/data/headline.js` (per-fragment size, italic, baseline nudge, per-line horizontal shift from 1280px up, line leading 0.75). Change the words in the dictionary; extra fragments fall back to a default style.

---

## 7. Pages, section by section

### Intro overlay (`components/Intro.jsx`)

Full-screen, `z-[100]`, every page load, over whichever route was opened.

1. **Splash.** The gold stacked logo centred on a looping navy-velvet film (`velvet.mp4`, with a navy scrim). "Click logo to start" pulses beneath. The logo is the only control and takes focus.
2. **Logo zoom (about 1.45 s).** On click the ink brightens gold, cream, white (80 to 260 ms), holds still (to 400 ms), then scales away from the viewer on an exponential curve until one stroke covers the viewport (to 1300 ms), still accelerating to 1450 ms. The mark is drawn from real SVG paths (`data/markGeometry.js`), not an `<img>`, so it stays sharp at huge scale. The emblem alone is kept once the scale passes about 4× to cut repaint.
3. **Showreel.** `showreel.mp4` plays once **with sound**, with a Skip button and a thin gold progress line. On portrait phones the film is letterboxed and the bars are painted live from the film's own top and bottom edges (a 16×9 sample per frame).
4. **Done.** On end, Skip or Escape the overlay unmounts and dispatches `oscenia:intro-done`. Under reduced motion a logo click goes straight to the site.

### Home (`pages/Home.jsx`)

1. **HeroFilm.** Sticky `hero-table.webp` with a 26 s Ken Burns zoom, brightness 1.18 and saturation 1.08, a 22% navy veil and a 30vh gradient foot. The `KineticHeadline` sets the sentence as ten differently sized fragments over three lines, landing 380 ms apart after the intro. `GlassCTA` ("Start your event") fades in 500 ms before the last word. Then the italic subline and the `LogoMarquee` paper strip (client slots are blank placeholders), then a 45vh spacer.
2. **Formats ("What we direct").** A 62svh/78svh film band (`champagne.mp4`, lazy) with eyebrow and heading bottom-left. Below, a 2×2 grid of four cards; the right column sits 28px lower. Each photo is **tossed** in from its own side (`useCardToss`), tilted, landing flat in about 2.27 s; scrolling back up plays the toss in reverse once the card's top passes 60% of the screen. Hover (real hover devices only) swells the card to 1.08×, floats it, blooms a gold halo and fades in a description. Three `GoldThread` boxes (hidden below 640px) draw one continuous hairline through the section as you scroll: thread one, a runtime-built link, and thread two, whose start is placed from the last caption's measured position. They are rendered before the cards so the cards paint over them. The section is `z-10` and `overflow-x-clip`.
3. **Testimonials.** Near-black lozenge card between two dot controls (44px hit areas), a blurred band of gold light sweeping across it (9 s), auto-advance every 4 s (paused on hover and focus, off under reduced motion), new quote fades in over 1.2 s. Placeholder quotes.
4. **Closing.** `celebration.mp4` sticky under a veil and a gradient to black, a scaling-in `GlassCTA`, and `<Footer overlay />` laid on the film.

### About (`pages/About.jsx`)

One continuous scroll-played film, black underneath.

1. **Hero.** A `h-[240vh]` runway with a sticky screen. Blue satin film (`fabric-blue.mp4`) fills the screen with "About Us". Scrolling folds the satin into a band across the top (covered share goes from 100% to 42%), scales the title down to 0.82, and writes the intro paragraph in word by word (`TypeOn` driven by progress). The film plays when the page rests at the top and **scrubs with the scroll** otherwise (4 s of film per pass), which needs a keyframe every 10 frames (see §9). Scrolling back reverses everything.
2. **Name meaning.** The phonetic name blooms open: letter-spacing opens from tight and faint to 0.3em as the line sharpens (the `.bloom` class and `@property --track`), replaying when it re-enters. Two paragraphs write themselves in, the second 1.7 s after the first.
3. **Stands for (glass scene).** Heading and intro (slide in from left and right), then a `h-[420vh]` pinned scene. The champagne flute film is drawn at `max(222vw, 150svh)` tall and travels down as you scroll (`pan = progress^1.8`). The three pillars (Scale, Flow, Memory) float as photographed bubbles (`GlassBubbles`): they wander, bob, drift from the pointer, bump each other with a jelly squash, can be dragged, and open a card on click. Then the bubbles drift off and the vision card is drawn up out of a blue envelope (`envelope.webp`, `card.webp`). Beat windows are in the `BEAT` constant. Reduced motion lays the same material out flat.
4. **Why Oscenia.** Pulled up a full screen (`-mt-[100svh]`) so it scrolls in over the glass scene's last pinned frame. "Why" with "Oscenia" set in beneath, two narrow paragraphs staggered.
5. **Our Value.** A pinned two-colour satin backdrop (`fabric-two.mp4`, cream above, blue below, drawn 135% tall) behind the whole section. "Our Value" scales in; each value is a black panel that scrolls over the satin, so the gaps between panels are windows onto it. Each panel: the title writes itself a letter at a time; the content arrives on the right (two questions, a six-item list, or the formula "Purpose → Experience → Emotion → Memory" writing itself in). Ends with a `GlassCTA`.

### Services (`pages/Services.jsx`, `ServiceCase.jsx`)

1. **Velvet.** A fixed `velvet.webp` ground with a 25% navy veil at `-z-20`, shared by the whole page so there is no seam.
2. **Stage.** A `h-[200vh]` runway with a sticky screen. Inside: the **bead curtain** (`BeadCurtain`) and over it the photographed **curtains** (`Curtains`). `lift = easeInOut(span(p, 0.05, 0.75))` raises the bead curtain off (translateY up to −110%) and fades it out between 0.55 and 0.75; `open = easeInOut(span(p, 0.08, 0.8))` draws the curtains off and lifts the valance.
   - **Curtains.** Two drapes and a valance, arriving closed, parting on their own after 450 ms over 2200 ms (`cubic-bezier(0.65, 0, 0.25, 1)`), settling to a framed strip (`--frame` 13vw, 17vw from `sm`). After that they track the scroll directly (no transition, or they would lag). Each drape is at least 51vw wide so "closed" is closed on a wide monitor.
   - **Bead curtain.** Columns of beads in the repeating order logo, big, small, big. Each column is a Verlet chain pinned at the top, pulled by gravity, with distance constraints, repelled by the pointer or a finger. Beads rotate with their strand. Full spec in §8.
3. **Portfolio.** Pulled up a full screen. The heading ("Corporate Events **&** Product Launches We've Directed.", ampersand large and gold) reveals; below, a grid (2 columns, 3 from `md`) of six tiles. The tiles **gather** from a scattered collage (`SCATTER` offsets in vw/vh, tilts, scales) as the grid scrolls in (`easeOut(span(p, 0.04, 0.42))`) and scatter again scrolling out. A tile is a greyscale photo (colour on hover, focus or touch) with a gold "Logo" disc and, on hover, the client and event type. A `GlassCTA` ends the page. The grid has `id="portfolio"`.
4. **Case page** (`/services/:slug`). Clicking a tile navigates inside a **view transition** (`useViewTransitionNavigate`): the photo carries `view-transition-name: case-<slug>` on both pages, so it grows into the case hero. The page shows the hero (brand, event type, logo disc), a centred intro and body, a looping photo strip (the gallery twice, translated −50% by the `marquee` animation, paused on hover, a native scroller under reduced motion), and a gold "« Back" link to `/services#portfolio`. Unknown slugs render `NotFound`.

### Contact (`pages/Contact.jsx`)

The WhatsApp bead is hidden here. Heading "Tell us what you're building." Left: intro, four social circles, WhatsApp number, mailto link. Right: the form (Name, Company, Phone, Event Type select of six, Estimated Guests, Estimated Date, Tell Us More). Submit builds a plain-text email from the fields in the current language and opens the visitor's mail client addressed to `CONTACT.email` (button reads "Opening your email…"). Below: a 380px Google Maps embed recoloured dark with `grayscale(0.35) invert(0.92) hue-rotate(180deg)`, the address and a "Location" button.

### 404 (`pages/NotFound.jsx`)

Centred "404", "Page not found", a line of explanation, and a "Back Home" pill.

### Present on every page

| Element | Component | Behaviour |
|---|---|---|
| Header | `Nav` | Transparent always. Logo left; Home / About Us / Service centred from 1024px; "Let's Talk Further" pill from 768px; EN/ID toggle always. Below 1024px a hamburger opens an opaque drawer (links, gold "Contact Us", "Chat with us"); it closes on navigation (state stores the path it opened on) and locks body scroll |
| Cursor ripple | `Ripple` | Gold-and-navy water wake behind content. Mouse and pen only; off under reduced motion; on Home waits for the intro |
| WhatsApp bead | `QuickContact` | Appears after 45% of a screen of scroll, hides within 420px of the page end, never on Contact. Mid-right on desktop, bottom-right on phones |
| Sound | `Sound` | Ambience, click pop, mute button bottom-left (see §8) |
| Footer | `Footer` | Logo, See More, Follow Along, Contact Us, legal line. `overlay` prop for Home |
| Smooth scroll | `useSmoothScroll` | Lenis, `lerp: 0.09`, wheel only; off under reduced motion and paused while the body is locked |

---

## 8. Components and hooks

All are in `src/components/` unless noted. Reduced motion is handled inside each component (it renders its final static state), and decorative layers are `aria-hidden`.

**Layout and navigation**
- `Layout`, `Nav`, `Footer`, `BrandMark` (`variant` horizontal or stacked, always from the SVG files), `Icon` (inline Instagram, LinkedIn, TikTok, WhatsApp, arrow; 24×24, 1.5 stroke, `currentColor`).

**Calls to action**
- `CTA` (plain pill; `variant` pill or solid; `to` default `/contact`; label is always `t.common.startEvent`; it ignores `children`).
- `GlassCTA` (`.liquid-glass .btn-glass` plus `useLiquidGlass`).
- `QuickContact` (`APPEAR_AFTER = 0.45`, `END_ZONE_PX = 420`, `.liquid-glass--bead`, links to `CONTACT.whatsapp`).
- `useLiquidGlass()` returns a callback ref (not a ref object, because the bead unmounts and remounts around `/contact`).

**Content blocks**
- `Reveal` slides children in from `up | down | left | right | scale | top-left | top-right | bottom-left | bottom-right`. Plays at 15% visible, resets at 0%; 1400 ms default, `cubic-bezier(0.33, 0, 0.15, 1)`; horizontal travel halved under 640px. Props `from`, `delay`, `duration`, `once`, `as`, `className`.
- `TypeOn` writes text in a word (70 ms) or character (38 ms) at a time; plays on view, or is driven by `active` or `progress`. The sentence is in the DOM once, whole, for screen readers.
- `Disclosure` opens itself 900 ms after its section is reached, with a `+` toggle (grid `0fr`→`1fr` height animation); stops auto-opening once used.
- `Media` (image or finished-looking placeholder), `BackdropVideo` (poster `<img>` until within 1.5 screens, then `<video autoplay muted loop playsinline>`; `eager` for the intro; stays a poster under reduced motion), `LogoMarquee` (list twice, −50% over 38 s).
- `KineticHeadline` (hero sentence; waits on `useIntroReady`).

**Scroll and motion helpers**
- `useScrollProgress(mode)` plus `span`, `easeOut`, `easeInOut`, `clamp01` (§4).
- `useCardToss(side)` returns `slot`, `photo`, `slide`, `rise` refs and writes styles directly to the DOM; timings in `TOSS` in `data/formatsMotion.js`; gentler on phones; nothing under reduced motion.
- `GoldThread` (`d`, `viewBox`, `from`, `to`, `pacing`, `width`): stroke `rgba(238,225,188,0.92)`, non-scaling stroke, dash length **measured in screen pixels** (not `getTotalLength()`, which would stop short under Chromium's non-scaling stroke), monotone-cubic pacing. Paths in `data/formatsMotion.js`.
- `useViewTransitionNavigate()` navigates inside `document.startViewTransition` with `flushSync`, falling back to plain navigation (and under reduced motion).
- `useSmoothScroll()` / `getLenis()` (Lenis at module scope so `ScrollToTop` can stop and restart it).
- `Ripple`: height-field wave equation on a coarse grid. `CELL 10` (px per cell), `DAMP 0.95`, `POKE 3`, `AMPLITUDE 0.1`, `GAIN 1.3`, `OPACITY 0.65`; crest gold-light, trough navy-500. Runs only while visible motion exists, restarts on mouse move, pauses on hidden tab.

**Scene components**
- `Intro` (constants `SPLASH_EXIT_MS 1450`, `PUSH_FROM_MS 400`, `COVER_MS 1300`, `INK_STOPS`; `playWithSound` plays unmuted and falls back to muted if refused).
- `GlassBubbles`: three bubble definitions (`DEFS`), `REPEL_RADIUS 150`, `REPEL_STRENGTH 0.55`, `WANDER_FORCE 0.01`, `DAMPING 0.972`, `MAX_SPEED 2.1`, `CLICK_MOVE 6`. Writes transforms directly each frame; runs only while `running` and on screen.
- `Curtains`: see §7 Services. `PART_MS 2200`, `PART_DELAY_MS 450`.
- `BeadCurtain`: below.
- `Sound`: below.

### `BeadCurtain` in detail

Canvas, sized to its container with a `ResizeObserver`, device-pixel-ratio capped at 2. Sprites loaded from `/services/bead-{logo,big,small}.png` with source sizes 66×45, 32×32 and 18×18, drawn at `TYPE_SCALE` 0.64, 0.58, 0.52.

| Constant | Value |
|---|---|
| `PATTERN` | `logo, big, small, big` repeating |
| `GAP` | logo 41, big 44, small 31; `GAP_AFTER_SMALL` 28 |
| `COL_SPACING` | 49 |
| `GRAVITY` / `DAMPING` / `ITERATIONS` / `MAX_SPEED` | 0.55 / 0.965 / 4 / 28 |
| `MOUSE_RADIUS` / `MOUSE_FORCE` | 70 / 2.2 |
| `WIDTH_SHARE` / `HEIGHT_SHARE` | 0.8 / 0.76 |

Build: the block is centred; columns are as many as fit `WIDTH_SHARE` of the width at `COL_SPACING`; each column starts with a pinned logo bead and adds beads, each `rest` distance below the last, until the block's height is used. Step: each unpinned point gets Verlet integration (velocity from the last position, damped and clamped, plus gravity), a pointer push if within `MOUSE_RADIUS`, then `ITERATIONS` passes of pairwise distance constraints toward each point's `rest`. Draw: each bead is rotated by `-atan2(dx, dy)` of the vector from the previous bead. The loop runs only while the canvas is on screen (`IntersectionObserver`); under reduced motion it draws one still frame. Listeners are on `window` (mouse and touch) and removed on unmount.

### `Sound` in detail

A single component mounted in `Layout`.

- Assets: `/sound/ambience.mp3` (loops) and `/sound/pop.wav`.
- Nothing plays on load (browsers block it). The first `pointerdown` or `keydown` starts the ambience, which is **on by default from then on**.
- Ambience: an `Audio` element, `loop`, volume faded to `AMBIENCE_VOLUME 0.2` over `FADE_MS 1500`; paused when the tab is hidden and resumed when visible.
- Pop: decoded once into an `AudioBuffer` through the Web Audio API for instant playback; `POP_VOLUME 0.5`; playback rate randomised between 0.94 and 1.06. One delegated capture-phase `pointerdown` listener plays it for any element matching `button, a[href], [role="button"], [data-sound]`, except those inside `[data-sound="off"]` and the toggle itself.
- Mute button: bottom-left (`fixed bottom-6 left-5 sm:bottom-8 sm:left-8 z-40`), a 44px `.liquid-glass` round button with a gold speaker icon (waves when on, a cross when muted), `aria-pressed` and an `aria-label`. The choice is saved in `localStorage['oscenia-sound-muted']` (`'1'` muted). Muting fades the ambience out; unmuting restarts it and plays a pop.

---

## 9. Asset inventory

Sizes are as served. All are in `public/`. The originals live in `brand-assets/` (see `brand-assets/README.md` for the full mapping).

**Brand (SVG)**: `brand/logo-horizontal.svg`, `logo-stacked.svg`, `mark-horizontal-gold.svg` (header, footer), `mark-stacked-gold.svg` (intro), `monogram.svg`, `monogram-light.svg`, `wordmark.svg`; `favicon.svg`. All are text and are in the source listing.

**Home and intro (`media/`)**

| File | Size | Notes |
|---|---|---|
| `hero-table.webp` | 74 KB | Home hero still: 16:9 crop of a laid-table photo |
| `showreel.mp4` + `showreel-poster.jpg` | 11 MB | Company film, 1920×1080, H.264, **keeps its soundtrack** |
| `velvet.mp4` + `velvet-poster.jpg` | 31 MB | Intro splash loop, navy fabric, 1440×2732 |
| `champagne.mp4` + `champagne-poster.jpg` | 25 MB | "What we direct" band, 4096×2160 |
| `celebration.mp4` + `celebration-poster.jpg` | 9 MB | Closing film, 1080×1920 |

**Formats (`formats/`)**: `corporate-events.webp`, `brand-experiences.webp`, `executive-gatherings.webp`, `experience-systems.webp` (3:2, about 55 to 70 KB each).

**About (`about/`)**

| File | Size | Notes |
|---|---|---|
| `fabric-blue.mp4` + poster | 21 MB | 1920×1080, **keyframe every 10 frames, no B-frames**, so the hero can scrub |
| `champagne.mp4` + poster | 3.7 MB | Flute loop, 720×1280 |
| `fabric-two.mp4` + poster | 28 MB | Two-colour satin, rotated 90° clockwise so cream is above and blue below |
| `bubble-1..3.webp` | 24 to 26 KB | The three pillar bubbles |
| `envelope.webp`, `card.webp` | 150 KB, 66 KB | The vision, trimmed, 1100 wide |

**Services (`services/`)**

| File | Notes |
|---|---|
| `velvet.webp` (111 KB) | Fixed page background |
| `curtain-left.webp`, `curtain-right.webp`, `valance.webp` | The photographed drapes (about 21 to 26 KB each) |
| `event-1..6.webp` | The six portfolio photos, 783×498 with rounded corners baked in |
| `bead-logo.png` (14 KB), `bead-big.png` (66 KB), `bead-small.png` (66 KB) | Bead sprites; `big` and `small` are the same image, drawn at different scales |

**Sound (`sound/`)**: `ambience.mp3` (3 MB), `pop.wav` (124 KB). Originals in `brand-assets/Sound - Ambience - SFX/`.

**Encoding recipes**

```sh
# a silent backdrop (add -vf transpose=1 for about/fabric-two)
ffmpeg -i "<source>.mp4" -an -pix_fmt yuv420p -c:v libx264 -profile:v high -crf 18 -preset slow -tune film -movflags +faststart public/<folder>/<name>.mp4

# About hero film: scrub-friendly keyframes
ffmpeg -i "<source>.mp4" -an -pix_fmt yuv420p -c:v libx264 -profile:v high -crf 18 -preset slow -tune film -g 10 -keyint_min 10 -sc_threshold 0 -bf 0 -movflags +faststart public/about/fabric-blue.mp4

# the intro film, keeping its audio
ffmpeg -i "Oscenia Company Profile Video.mp4" -map 0:v:0 -map 0:a:0 -pix_fmt yuv420p -c:v libx264 -profile:v high -crf 18 -preset slow -tune film -c:a copy -movflags +faststart public/media/showreel.mp4

# a poster: the frame a film opens on
ffmpeg -ss 0.3 -i public/<folder>/<name>.mp4 -frames:v 1 -q:v 3 public/<folder>/<name>-poster.jpg
```

H.264 is used because every browser plays it. The brand reel `story 5 - reels 2.mp4` is HEVC, which Chrome and Firefox do not decode, so the hero and format cards use stills cut from it.

If you do not have the originals, any stand-ins at the same paths and aspect ratios work: the code only needs the filenames to exist. A missing poster or film shows blank; a missing `Media` image shows a designed placeholder.

---

## 10. Motion reference

| Motion | Where | Numbers |
|---|---|---|
| Section entrance | `Reveal` | 1400 ms, `cubic-bezier(0.33, 0, 0.15, 1)`, from a named direction |
| Word landing | `.word-in` | 700 ms (hero words 1100 ms, 380 ms apart), `cubic-bezier(0.22, 1, 0.36, 1)`, rises 0.45em |
| Hero Ken Burns | tailwind `ken-burns` | 26 s alternate, scale 1 to 1.16 with a small drift |
| Logo marquee | tailwind `marquee` | 38 s linear, −50% |
| Testimonial sheen | tailwind `sheen` | 9 s alternate |
| Testimonial advance | `Home` | every 4 s, new quote fades in 1.2 s |
| Card toss | `useCardToss` | about 2.27 s in, mirrored out; hover swell 1.08× over 1.2 s then ±5 px float |
| Gold thread | `GoldThread` | drawn by scroll, un-drawn on the way back |
| Intro | `Intro` | see §7 |
| About hero | `About` | 240vh runway, fold 100% to 42%, 4 s film per pass |
| About glass scene | `About` | 420vh runway; `BEAT` windows pan [0, 0.8], bubblesIn [0, 0.1], bubblesOut [0.42, 0.52], envelopeIn [0.48, 0.57], cardOut [0.55, 0.64], visionOut [0.67, 0.75] |
| Phonetic bloom | `.bloom` | opens at 35% visible, closes at 0% |
| Curtains part | `Curtains` | 450 ms delay, 2200 ms, `cubic-bezier(0.65, 0, 0.25, 1)` |
| Services stage | `Services` | 200vh runway; lift [0.05, 0.75], open [0.08, 0.8], bead fade [0.55, 0.75] |
| Tiles gather | `Services` | [0.04, 0.42] of the grid's pass, `easeOut` |
| Case strip | tailwind `marquee` | same keyframes, paused on hover |
| Bead curtain | `BeadCurtain` | physics only; see §8 |
| Ambience fade | `Sound` | 1500 ms |

The deck-derived timings (`data/deckMotion.js`) come from the PowerPoint "HOME - ABOUT US.pptx" analysed in the repository's `docs/Deck-Transitions-Reference.md`. Every direction and duration on the site should come from there or from `data/formatsMotion.js` rather than being chosen by eye.

---

## 11. Accessibility, performance, browsers

**Reduced motion** (`prefers-reduced-motion: reduce`): reveals render in place; hero words land instantly; disclosures start open; films stay as posters; Ken Burns, marquee and sheen stop; testimonials do not auto-advance; gold threads draw complete; card toss and hover lift off; the ripple is off; the intro skips zoom and film; smooth scrolling is off; About and Services render flat, unpinned layouts; the bead curtain draws one still frame; curtains start parted. The one gap: **sound has no reduced-motion rule** (ambience still plays by default after first interaction).

**Reduced transparency**: liquid glass becomes opaque navy, no backdrop blur.

**Keyboard and screen readers**: real `<button>` and `<a>` everywhere; 1px gold `focus-visible` rings; the intro focuses its single control at each stage and closes on Escape; dialogs use `role="dialog"`; the drawer has `aria-expanded`/`aria-controls`; language chips use `aria-pressed`; decorative layers are `aria-hidden`; the kinetic headline, `TypeOn` and the logo marquee each carry one plain screen-reader copy; `<html lang>` follows the language; the sound button has `aria-pressed` and a label that flips.

**Touch**: hover-only effects are gated by `(hover: hover)`.

**Performance**
- Lazy background films (poster image until within 1.5 screens).
- Posters for every film; lazy images, with only the hero still `fetchPriority="high"`.
- Films encoded with `faststart`.
- Self-stopping loops (ripple, threads, intro); the bead curtain and bubbles run only while on screen.
- Coarse ripple grid (one cell per 10 px).
- Passive scroll listeners; thread updates batched to one per frame.
- Per-frame motion written straight to the DOM, not through React.
- The brand pack lives outside `public/` so it is not in every build.
- Fonts are preconnected with `display=swap`.

**Browsers**: all current browsers. Liquid-glass lensing is Chromium only (elsewhere: blur, tint, rim). `@property` gliding needs Chromium, Safari 16.4+, Firefox 128+. View transitions need Chromium or a recent Safari; elsewhere the case page simply opens. The showreel falls back to muted if sound is refused.

---

## 12. Deployment

Static site on **Vercel**. `npm run build` outputs `dist/`. `vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "rewrites": [
    { "source": "/erp-guide", "destination": "/erp-guide.html" },
    { "source": "/erp/(.*)", "destination": "/erp/index.html" },
    { "source": "/(.*)", "destination": "/index.html" }
  ]
}
```

The last rewrite is what lets deep links like `/services/brand-a` survive a refresh. The `/erp` and `/erp-guide` rewrites serve a separate prototype app built into `public/erp/`; a site without the ERP can drop those two lines. The ERP has its own documentation in the repository's `docs/` folder.

---

## 13. Rebuild procedure, step by step

1. **Scaffold.** Create the folder. Add `package.json`, `vite.config.js`, `tailwind.config.js`, `postcss.config.js`, `vercel.json` and `index.html` from the source listing. Run `npm install`.
2. **Assets.** Create `public/` with the folders in §3 and fill them per §9. Put the SVG files from the source listing in `public/brand/` and `public/favicon.svg`. For a quick start, stand-in images and silent films at the same paths are enough.
3. **Styles.** Add `src/index.css`. It must come in as `@tailwind base; components; utilities` followed by the custom classes. `src/main.jsx` imports it.
4. **Data and copy.** Add `src/data/*.js` and `src/i18n/*`, and `src/introReady.js`.
5. **Hooks and helpers first.** `useScrollProgress`, `useSmoothScroll`, `useViewTransitionNavigate`, `useLiquidGlass`, `useCardToss`.
6. **Small components.** `BrandMark`, `Icon`, `Media`, `BackdropVideo`, `Reveal`, `TypeOn`, `Disclosure`, `CTA`, `GlassCTA`, `LogoMarquee`, `KineticHeadline`, `GoldThread`.
7. **Scene components.** `Ripple`, `GlassBubbles`, `Curtains`, `BeadCurtain`, `Intro`, `Sound`, `QuickContact`, `Nav`, `Footer`, `Layout`.
8. **Pages.** `Home`, `About`, `Services`, `ServiceCase` (imports `LogoBadge` from `Services`), `Contact`, `NotFound`.
9. **Entry.** `App.jsx` and `main.jsx`.
10. **Run and check.** `npm run dev`. Verify, in this order: the intro plays and hands off; the headline lands after it; the ripple follows the mouse; Home's cards toss and the thread draws; About's hero scrubs; the bubbles drag; the Services curtains part and the beads swing; a tile opens its case page with the photo growing; the form opens a mail client; EN/ID switches every string; the sound starts on first click and the bottom-left button mutes it; `prefers-reduced-motion` gives flat, static pages.
11. **Build.** `npm run build`, then `npm run preview`.

The file order in the source listing is configs first, then `src/` alphabetically. Any file may be created in any order; only the imports must resolve before the dev server compiles.

---

## 14. Known issues and open items

| Item | Where | Note |
|---|---|---|
| Placeholder content | `site.js`, `dict.js` | Client names and logos, portfolio brands, case write-ups (`t.services.cases` is empty), testimonials, social links. Real content goes in the files named in §3 |
| Contact form uses `mailto:` | `Contact.jsx` | Needs a real endpoint before launch |
| The intro plays on every page load | `Intro.jsx` | `App.jsx` comments say "first visit of a session", but no session memory exists |
| `CTA` ignores `children` | `CTA.jsx` | Only matters if a different label is ever passed |
| Sound has no reduced-motion rule; the 124 KB WAV could be a smaller format | `Sound.jsx` | |
| Services-specific sound touches not built | n/a | Raising the ambience as the curtains part; a pop as tiles settle |
| Obsolete `LetterCurtain.jsx` | `components/` | Unused; safe to delete |
| Map pin is building-level only | `site.js` | Floor unconfirmed by the client |
| Large media | `public/` | About and intro films total over 100 MB; fine on Vercel, heavy on slow connections. Posters and lazy loading soften it |
