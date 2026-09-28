# Design System

The visual language of the Oscenia Events website: colour, type, surfaces, controls, imagery and layout. Every value here is taken from the code. Where a token lives in a file, the file is named so you can change it at the source.

- Tokens: [`tailwind.config.js`](../tailwind.config.js)
- Global and component CSS: [`src/index.css`](../src/index.css)
- Motion: [`animation.md`](../animation.md) (every animation on the site, in detail)

---

## 1. Character

Oscenia sells atmosphere, so the site behaves like a darkened room lit in gold: near-black and deep navy grounds, a light high-contrast serif, gold used sparingly as light rather than as fill, and full-bleed film between sections. Three rules follow from that and explain most decisions below.

1. **Gold is light, not paint.** It appears as hairlines, text, glows, rims and sheens. At rest it's a solid fill in only two places: the active language chip and the `.btn-gold` button. Gold fills otherwise appear only as a hover response (nav links, `.btn-pill`, `.btn-solid`).
2. **Type is set light.** The serif defaults to weight 300 everywhere. Heavier weights are not part of the brand.
3. **Nothing arrives all at once.** Sections slide in from a direction, headlines land word by word, lines draw themselves. See [animation.md](../animation.md).

---

## 2. Colour

### 2.1 Palette tokens

Defined in `tailwind.config.js` under `theme.extend.colors`, so each is available as `bg-*`, `text-*`, `border-*`, `from-*` and so on, with Tailwind opacity modifiers (`text-white/80`, `bg-navy-950/75`).

**Navy**: the grounds.

| Token | Hex | Used for |
|---|---|---|
| `navy-950` | `#04070f` | Page base (`body`), footer panel, mobile drawer, dark scrims |
| `navy-900` | `#060b16` | Bottom of the shared page gradient |
| `navy-800` | `#0a1424` | Image placeholders, form select background |
| `navy-700` | `#0f1d33` | (available; not currently used directly) |
| `navy-600` | `#16294a` | "Stands for" circle, resting centre |
| `navy-500` | `#1f3760` | "Stands for" circle, open centre; ripple trough colour |

**Gold**: the light.

| Token | Hex | Used for |
|---|---|---|
| `gold` (DEFAULT) | `#c6a15b` | Hairlines, borders, bullets, `+` toggles, `.btn-gold`, card halo, focus rings |
| `gold-light` | `#e0c789` | Page headings, eyebrows on dark, active nav chip, hover text, headline ampersand |
| `gold-dark` | `#9c7c3f` | (available; reserved for pressed or deep gold) |

**Paper**: the warm off-white of the company film.

| Token | Hex | Used for |
|---|---|---|
| `paper` (DEFAULT) | `#f4f3ee` | Client logo strip across the hero; "Let's Talk Further" text |
| `paper-dim` | `#e7e4da` | (available) |

Paper is not white on purpose: it was sampled from the showreel's own light chapters so the client strip and the film read as one material.

### 2.2 White as a tint

Body text is white at reduced opacity rather than a grey token, so it takes on the colour of whatever it sits over. The working scale:

| Class | Role |
|---|---|
| `text-white` | Headings on dark, active states |
| `text-white/90`, `/95` | Primary copy, testimonial quote, footer links (`/85`) |
| `text-white/75`, `/80` | Paragraph copy |
| `text-white/60`, `/70` | Secondary copy, form labels, intros |
| `text-white/45`, `/50` | Tertiary: notes, "label:" prefixes, card descriptions |
| `text-white/40` | Footer legal line |
| `text-white/25` | Placeholder labels inside empty image frames |

Borders follow the same idea: `border-white/5` (footer rule), `/10` (cards, dividers, image frames), `/15` (form select, social circles), `/20` (form underlines, hamburger).

### 2.3 Named one-off colours

These appear inline and are deliberate, not drift:

| Where | Value | Why |
|---|---|---|
| Testimonial card | `#050505` | A near-black a step off the section, so the card reads as glass |
| Client names on paper | `#1a1c20` at 80% | Ink on paper, not black |
| Card halo on hover | `rgba(198,161,91,0.95)` | `gold` as a shadow colour |
| Intro ink ramp | `(201,167,99)` → `(249,241,228)` → white → `(241,239,236)` | Measured from the reference; the last stop is the showreel's first frame |

### 2.4 Background recipes

Three named backgrounds in `src/index.css`:

| Class | Definition | Used by |
|---|---|---|
| `.bg-oscenia` | Radial navy glow at the top (`#12233f`) over a vertical `#060b16` → `#04070f` gradient | The whole site shell (`Layout`); what inner pages sit on |
| `.bg-abyss` | `#000` → `#05090c` → `#0a1220` → `#0d1a2a` top to bottom | Home testimonials section: black between films, lifting to navy at its foot |
| `.hairline` | 1px high, `transparent → gold/60% → transparent` horizontal gradient | Decorative divider rules (About) |

### 2.5 Scrims over imagery

Film and photo backgrounds always carry a scrim so type stays legible anywhere on the frame. The pattern is two layers: an even veil, plus a gradient foot that closes into the next section's colour.

| Section | Veil | Foot |
|---|---|---|
| Home hero | `bg-navy-950/22` | `h-[30vh]`, transparent → `navy-950/80` |
| "What we direct" film | `bg-black/25` | (none; the band ends in a hard edge to black) |
| Home closing film | `bg-black/25` | `h-2/3`, transparent → `black/35` → `black/80` |
| About Vision band | `bg-navy-950/75` | none |
| Services featured, case study hero | none | `bg-gradient-to-t from-navy-950 via-navy-950/30 to-transparent` |

### 2.6 Text selection

`::selection` is gold at 35% (`rgba(198,161,91,0.35)`), so a selection glows rather than turning system blue.

---

## 3. Typography

### 3.1 Families

The brand pack ships exactly two faces, loaded from Google Fonts in [`index.html`](../index.html):

| Family | Tailwind class | Role |
|---|---|---|
| **Fraunces** (variable: optical size 9–144, weight 100–400, roman and italic) | `font-serif`, `font-display` | Every heading, the hero sentence, captions, nav labels, buttons like "Start your event", footer columns |
| **Plus Jakarta Sans** (weight 300–700, roman and italic) | `font-sans` (the body default) | Body paragraphs, form fields, labels, eyebrows, testimonial quote |

Fallbacks: Fraunces → Georgia → serif; Plus Jakarta Sans → system-ui → sans-serif.

**Brand rule:** only Fraunces Thin, Light, Regular and Italic may be used. The font request is therefore capped at weight 400, so a bolder Fraunces cannot render even by accident.

### 3.2 How the serif is tuned

In `src/index.css` (`@layer components`):

```css
.font-display { font-weight: 300; font-variation-settings: 'opsz' 144; }
.font-serif   { font-weight: 300; font-variation-settings: 'opsz' 72; }
```

- **Weight 300 by default.** The layouts were designed around a light, high-contrast serif; Fraunces at its default weight sets noticeably heavier. Because the rule is in `@layer components`, an explicit utility such as `font-normal` still wins if a heading ever needs it.
- **Optical size.** `opsz` 144 gives the high-contrast display cut; `opsz` 72 a slightly sturdier cut for mid-size text. This is what lets one family serve both headlines and running text.
- **Italic is a voice, not emphasis.** Italic Fraunces carries stylised words: "OS · CEN · IA", "Our Value", the Vision statement, the italic fragments of the hero sentence, the stylised "Oscenia" inside headings.

### 3.3 Type scale

The site uses Tailwind's scale for fixed sizes and fluid `clamp()` sizes where type must track the viewport.

**Page headings (inner pages)**

| Element | Classes |
|---|---|
| Page title (About, Services, Contact h1) | `font-serif text-5xl sm:text-6xl` (Contact: `sm:text-7xl`), `text-gold-light` |
| Section heading | `font-serif text-4xl sm:text-5xl` to `sm:text-6xl`; "Why Oscenia" up to `md:text-7xl` |
| Sub-heading (value rows) | `font-serif text-2xl italic text-gold-light` |
| Intro paragraph | `font-serif text-xl leading-relaxed text-white/80` |
| Body | `text-lg leading-relaxed text-white/75` (sans) |

**Home (fluid)**

| Element | Size |
|---|---|
| Hero sentence | Ten fragments, each with its own `clamp()` size. See §3.5 |
| "What we direct" eyebrow | `clamp(1rem, 1.65vw, 1.75rem)`, tracking `0.12em`, `text-gold-light/90` |
| "Formats we shape…" heading | `clamp(1.9rem, 4.2vw, 3.6rem)` |
| Format card captions | `clamp(1.5rem, 3.4vw, 3.4rem)` |
| Testimonials heading | `clamp(1.4rem, 2.05vw, 2.1rem)` |
| Testimonial quote | `text-sm` → `sm:text-[1.05rem]`, sans |
| Footer column title / links | `clamp(1.1rem, 1.7vw, 1.75rem)` / `clamp(1rem, 1.35vw, 1.4rem)`, serif |

### 3.4 Labels and letter-spacing

Small uppercase labels are spaced wide; that tracking is part of the brand look.

| Pattern | Classes |
|---|---|
| `.eyebrow` (section label) | `text-[11px] tracking-[0.4em] uppercase text-gold/80` |
| Buttons (`.btn-pill`, `.btn-solid`) | `text-xs tracking-[0.2em] uppercase` |
| `.btn-gold` | `text-xs tracking-[0.18em] uppercase` |
| Form labels | `text-xs uppercase tracking-[0.18em] text-white/60` |
| Event-type tag, "Close" | `text-[10px]`–`text-[11px]`, tracking `0.18em`–`0.25em` |
| Brand token | `tracking-brand` = `0.35em` (available for wordmark-style lines) |

### 3.5 The hero sentence

The home headline is composed type, not a heading. It's ten fragments across three lines, each with its own size, italic and baseline, landing one at a time. All of it is tabled in [`src/data/headline.js`](../src/data/headline.js):

- `WORD_STYLES`: a size and italic setting per fragment. The ampersand is `gold-light` at `clamp(2.1rem, 5.94vw, 6.2rem)`, the largest fragment; "transform" and "into" are the smallest (~1.8vw).
- `WORD_NUDGE`: per-fragment baseline shifts in em. Small words ride up against the cap height of big ones.
- `LINE_SHIFT`: each line hangs off-centre by its own amount (−7.84%, +4.26%, −1.59%). Applied only from 1280px up; narrower screens centre every line.
- `LINE_LEADING` `0.75`: tight enough that the ampersand's swash crosses its line box, on purpose.
- `WORD_GAP`: `clamp(0.35rem, 1.3vw, 1.6rem)`.

The sizes were measured off the reference design, not chosen, so they aren't a tidy ramp. Change the words in the dictionary, not here. A translation with more or fewer fragments still works, because extra fragments fall back to `WORD_STYLE_FALLBACK`.

---

## 4. Controls

### 4.1 Button family

All buttons are fully rounded pills. Defined in `src/index.css` (`@layer components`):

| Class | Look | Hover | Used for |
|---|---|---|---|
| `.btn-pill` | 1px `gold/70` outline, transparent, `text-white/90`, `px-8 py-3` | Fills solid gold, text turns `navy-950` | "Start your event" on inner pages, 404 "Back Home", mobile "Chat with us" |
| `.btn-solid` | `bg-black/60`, 1px `white/20` border, white text | Fills gold, text `navy-950` | Contact form submit, "Location", "Explore More" |
| `.btn-gold` | Solid `gold` fill, `navy-950` text, `px-6 py-2.5` | Lightens to `gold-light` | Primary action: "Contact Us" in the mobile drawer |
| `.liquid-glass .btn-glass` | Clear refractive glass, Fraunces `text-lg` → `sm:text-[1.35rem]`, 230×88 at 1600px wide | Warms gold, gains a gold halo, grows to 1.05×; press grows to 1.08× | Home "Start your event" (hero and closing). Component: `GlassCTA` |

All transitions run 300ms unless noted.

**Header controls** (in `Nav.jsx`, not classes):
- **Nav links:** `text-[0.95rem]`, `rounded-full px-5 py-2`; hover fills `gold-light` with `navy-950` text. The active page is full white, others `white/80`.
- **"Let's Talk Further":** `bg-black/70` pill, serif 11px, `text-paper/85`, followed by a `•••` glyph; hover goes solid black with `gold-light` text.
- **Language toggle:** a `bg-black/70` track holding EN / ID chips. The active chip is `gold-light` with `navy-950` text and a softer squircle corner (`rounded-[0.7rem]`) than the track.
- **Hamburger:** 40px circle, `border-white/20 bg-black/40`, three 1px lines that morph into an ×. Below 1024px only.

### 4.2 Liquid glass

A material, not a button style. `.liquid-glass` (in `index.css`) plus the `useLiquidGlass` hook imitates Apple's Liquid Glass:

| Layer | What it does |
|---|---|
| Backdrop | `blur(2.5px) saturate(170%) brightness(1.06)`, with a 5% white tint and a faint top-to-bottom sheen |
| Lensing (Chromium only) | An SVG displacement filter, built per element by the hook, bends the content behind the rim. Other browsers keep the blur and tint |
| Specular rim (`::before`) | A gradient ring, brightest top-left and returning faintly bottom-right |
| Caustic | Inset shadows: light pooled inside the bottom edge, softer glow along the top |
| Pointer highlight (`::after`) | A radial highlight that glides after the pointer via the registered properties `--lg-x` / `--lg-y` |
| Hover / focus | Rim, tint and caustic warm to gold (`--lg-rim: #f0dca8`); a 60px gold halo appears. This is also the keyboard focus indicator |
| Press | Swells to 1.035× with an overshooting spring (`cubic-bezier(0.34,1.56,0.64,1)`, 560ms), like gel under a finger |

**Variant `.liquid-glass--bead`:** frostier (`blur 10px`, `saturate 180%`), tinted navy (`rgb(8 14 26 / 0.34)`), with a gold rim and a soft gold halo even at rest. It's for the floating WhatsApp button, which sits over arbitrary content and must stay legible anywhere.

Custom properties you can set per element: `--lg-blur`, `--lg-sat`, `--lg-rim` (colour), `--lg-rim-w` (rim width).

**Accessibility fallbacks:** with *reduce transparency* on, the glass becomes opaque (`rgb(12 18 30 / 0.94)`), with no backdrop. With *reduce motion* on, the press and hover scaling are removed.

### 4.3 Forms

On the Contact page, fields are underlines rather than boxes: `border-b border-white/20`, transparent background, and the underline turns `gold` on focus. The one exception is the event-type `<select>`, a bordered box (`rounded-md border-white/15 bg-navy-800/60`) because native dropdowns need a visible hit area. Labels sit above in the uppercase label style (§3.4).

### 4.4 Focus

Custom controls replace the browser outline with a 1px gold ring: `focus-visible:ring-1 focus-visible:ring-gold` or `ring-gold-light`. Glass controls use their gold hover state as the focus state. Portfolio tiles show focus by switching to full colour and a `gold` border, the same as hover.

---

## 5. Surfaces, shape and depth

### 5.1 Corner radii

| Radius | Used for |
|---|---|
| `rounded-full` | Every button, the nav chips, carousel dots, social circles, the WhatsApp bead |
| `rounded-[3.25rem]` (`2rem` on mobile) | Testimonial card, large enough to read as a lozenge |
| `rounded-[1.25rem]` | "What we direct" format card photos |
| `rounded-lg` | Services featured image, case-study hero, contact map |
| `rounded-md` | Portfolio tiles, gallery thumbnails, form select |

### 5.2 Glows and shadows

Shadows on this site are almost always gold light, not dark drop shadows.

| Element | Shadow |
|---|---|
| Format card, hover only | `0 0 130px -24px rgba(198,161,91,0.95)`; at rest the same shadow at 0% so it fades in over 700ms. Only on devices that genuinely hover |
| "Stands for" circle | Resting `0 0 60px -20px gold/40%`; open `0 0 80px -16px gold/65%` |
| Glass button hover | `0 0 60px -2px rgb(198 161 91 / 0.75)` |
| WhatsApp bead | `0 0 30px -8px` gold-light/45% at rest, stronger on hover |
| Portfolio logos | `drop-shadow(0 1px 4px rgba(0,0,0,0.65))` so a white mark survives a bright photo |

The **negative spread** in these (for example `-24px`) is what keeps them soft. The shadow is pulled inside the element's edge before it's blurred, so it reads as light behind the object rather than a rim around it.

### 5.3 Layering (z-index)

| Layer | z-index |
|---|---|
| Intro overlay | `z-[100]` |
| Header, case-study dialog | `z-50` |
| Floating WhatsApp bead | `z-40` |
| Home "What we direct" section | `z-10` (so thread two's tail draws over the testimonials) |
| Page content | normal flow |
| Cursor ripple canvas | `-z-10` inside the isolated `Layout` shell |

Full reasoning is in [architecture.md](architecture.md#layering).

---

## 6. Imagery and media

### 6.1 Brand marks

Two gold lockups from the brand pack, used verbatim as SVG files in `public/brand/`:

| File | Used in |
|---|---|
| `mark-horizontal-gold.svg` | Header (`h-8` → `sm:h-10` → `lg:h-11`), footer (`h-7` → `sm:h-9`) |
| `mark-stacked-gold.svg` | Intro splash (`h-40` → `sm:h-52`), and as the source geometry for the intro zoom |
| `monogram-light.svg` | Placeholder client mark on portfolio tiles |

Render marks through the `BrandMark` component, never as re-typed text.

### 6.2 Film

Full-bleed video is part of the look. Each film has a matching poster JPEG that stands in until the video loads, so a section is never blank:

| File | Where | Behaviour |
|---|---|---|
| `velvet.mp4` | Intro splash background | Loads immediately, loops, muted |
| `showreel.mp4` | Intro, after the logo click | Plays once, **with sound**; letterboxed on portrait screens |
| `champagne.mp4` | Home "What we direct" band | Lazy, loops, muted |
| `celebration.mp4` | Home closing section | Lazy, loops, muted |
| `hero-table.webp` (still) | Home hero | Slow Ken Burns zoom, brightness 1.18× and saturation 1.08× |

The hero and closing backdrops are **sticky**: the frame stays fixed to the screen while the section scrolls over it, so a hero and the client strip read as lit by one frame.

### 6.3 Photographs

| Set | Aspect | Treatment |
|---|---|---|
| Format cards (`public/formats/*.webp`) | 3:2 | Rounded 1.25rem; zoom to 1.05× on hover |
| Portfolio tiles | 4:3 | **Greyscale with a 45% navy veil at rest**; on hover, colour returns, the veil lifts and the photo zooms 1.04× over 700ms. Touch devices show full colour |
| Gallery thumbnails | 4:3 | Rounded, `border-white/10` |

### 6.4 Placeholders

Any `Media` without a `src` renders a finished-looking placeholder: a navy diagonal gradient (`#0d1b31` → `#0a1424` → `#060b16`) with faint gold diagonal lines every 23px and an italic label at `white/25`. Layouts therefore read as designed before photography exists.

### 6.5 Icons

`Icon.jsx` holds a small inline set (Instagram, LinkedIn, TikTok, WhatsApp, arrow). They are drawn on a 24×24 grid, 1.5 stroke, round caps and joins, and use `currentColor` so they take the text colour. There's no icon library dependency.

### 6.6 Map

The office map is a Google Maps embed recoloured to the dark theme with CSS filters: `grayscale(0.35) invert(0.92) hue-rotate(180deg)`. This inverts it to a dark map while keeping water blue.

---

## 7. Layout

### 7.1 Containers

| Container | Width | Used for |
|---|---|---|
| `max-w-content` | 1200px | Inner-page sections, testimonials |
| `max-w-[82rem]` | 1312px | Home "What we direct" card grid |
| `max-w-[68rem]` | 1088px | Hero sentence box |
| `max-w-[100rem]` | 1600px | Footer |
| `max-w-4xl` | 896px | Case-study dialog |
| `max-w-[41rem]` | 656px | Testimonial card |

Side padding is `px-6` (24px) by default, with the header at `px-5` → `sm:px-8` → `lg:px-9` and the footer at `px-6` → `sm:px-10` → `lg:px-14`.

### 7.2 Vertical rhythm

- Inner pages start at `pt-40` (160px) to clear the fixed header.
- Standard sections use `py-16` to `py-24`.
- Home sections are sized to the screen with `svh` units, which stay stable as the mobile browser toolbar shows and hides: hero `min-h-[100svh]`, testimonials `min-h-[112svh]`, closing `min-h-[85svh]`.

### 7.3 Grids

| Grid | Columns |
|---|---|
| Home format cards | 1 → 2 at `sm`; `gap-x-12` (48px); the right-hand card sits 28px lower (`sm:mt-7`) |
| Portfolio and galleries | 2 → 3 at `md`; `gap-3` → `sm:gap-4` |
| About two-column sections | 1 → 2 at `md` |
| "Stands for" circles | 1 → 3 at `sm` |
| Contact | 1 → `1fr 1.4fr` at `md` |
| Footer | 1 → `1.2fr 1fr 1.05fr 1.25fr` at `md` |

### 7.4 Breakpoints

Tailwind defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px. Behaviours that switch at a breakpoint:

| Breakpoint | Change |
|---|---|
| < 640px | Gold threads hidden; format cards single-column with a gentler toss; the WhatsApp bead sits bottom-right instead of higher up |
| ≥ 768px (`md`) | "Let's Talk Further" pill appears in the header |
| ≥ 1024px (`lg`) | Header links appear, centred on the viewport; hamburger and drawer disappear |
| ≥ 1280px (`xl`) | Hero lines take their individual off-centre shifts |

Plus three non-width media conditions:
- `(hover: hover)`: format card halo, lift and float only on real hover devices. Portfolio tiles mirror their hover state under `(hover: none)`, so on a phone they are always in colour and titled.
- `(orientation: portrait)`: intro showreel letterboxed with colour-matched bars.
- `prefers-reduced-motion` / `prefers-reduced-transparency`: see [architecture.md](architecture.md#accessibility).

---

## 8. Motion at a glance

Motion has its own full reference, [animation.md](../animation.md). The shared vocabulary:

| Token / helper | Value | Where |
|---|---|---|
| Section entrance | 1400ms, `cubic-bezier(0.33, 0, 0.15, 1)`, slides in from a named direction | `Reveal` |
| Deck morph (source) | 2000ms | `data/deckMotion.js` |
| Word landing | 700ms (hero words: 1100ms, 380ms apart), `cubic-bezier(0.22, 1, 0.36, 1)`, rises 0.45em | `.word-in` |
| Self-opening copy | opens 900ms after the section is reached, siblings 650ms apart | `Disclosure`, "Stands for" |
| Hover lift | card scales 1.08× over 1200ms, then floats ±5px about once a second | `.format-card-lift` |
| Quote change | every 4s; the new quote fades in over 1.2s | Home testimonials |
| Background loops | Ken Burns 26s, logo marquee 38s, testimonial sheen 9s | `tailwind.config.js` |

Every animation has a reduced-motion behaviour: it's either removed or shown in its final state.
