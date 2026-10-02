# Oscenia Events — Website

The marketing site for **Oscenia Events**, a strategic events and immersive-experiences company in Jakarta, Bali and Singapore. It's bilingual (English and Bahasa Indonesia), film-led and heavily animated, built to match the "Landing Page Visual Direction" deck and the reference recordings in the repository root.

**Stack:** React 19 · Vite 8 · Tailwind CSS 3.4 · React Router 7 · hosted on Vercel. No backend, no CMS.

## Run it

```bash
cd oscenia-web
npm install
npm run dev       # http://localhost:5173
```

```bash
npm run build     # production build to dist/
npm run preview   # serve the production build
npm run lint      # oxlint
```

## Documentation

| Document | Read it to… |
|---|---|
| [docs/COMPLETE-WEBSITE-GUIDE.md](docs/COMPLETE-WEBSITE-GUIDE.md) | **Start here to rebuild the whole site.** How everything works, current as of the code, with a step-by-step rebuild procedure and asset inventory |
| [docs/COMPLETE-SOURCE-CODE.md](docs/COMPLETE-SOURCE-CODE.md) | Every source file, verbatim (58 files) |
| [docs/design-system.md](docs/design-system.md) | Understand the look: colours, typography, buttons, liquid glass, shadows, imagery, layout and breakpoints |
| [docs/pages.md](docs/pages.md) | See every page section by section: what's on it, where its content comes from, how it behaves |
| [docs/components.md](docs/components.md) | Use or change a shared component or hook: props, rules, internals |
| [docs/content-guide.md](docs/content-guide.md) | Change text in either language, contact details, images or films. **Includes the pre-launch checklist** |
| [docs/architecture.md](docs/architecture.md) | Understand how it fits together: rendering, layering, performance, accessibility, browser support, deployment, known issues |
| [animation.md](animation.md) | Look up any animation in detail: timings, curves, and how each was measured |
| [brand-assets/README.md](brand-assets/README.md) | Trace a served file back to the original brand pack |

## The site at a glance

| Route | What's there |
|---|---|
| (first load) | **Intro:** gold logo on navy velvet → click → the logo zooms into the screen → company showreel with sound → site |
| `/` | Hero sentence over a slowly zooming table photo, client strip · "What we direct" with four tossed-in format cards and a scroll-drawn golden thread · rotating testimonials · closing film with the footer on it |
| `/about` | Name meaning · three self-opening "Scale / Flow / Memory" circles · Vision · Why Oscenia · Our Value |
| `/services` | Portfolio grid (greyscale → colour on hover, opens a case-study dialog) · featured project |
| `/contact` | Enquiry form (opens the visitor's email app) · dark-themed office map |

On every page: a transparent header with an EN/ID toggle, a gold water ripple that follows the mouse, and a floating liquid-glass WhatsApp button.

## Where things live

```
src/i18n/dict.js     all visible text, English + Indonesian
src/data/site.js     contact details, clients, images, portfolio (language-independent)
tailwind.config.js   colour, font and animation tokens
src/index.css        buttons, liquid glass, backgrounds, global rules
src/pages/           one file per route
src/components/      shared components and hooks
src/data/*.js        measured typography and motion tables
public/              everything the site serves (images, films, logos, the ERP build)
brand-assets/        the original brand pack (not served)
```

**Brand fonts:** Fraunces (headings and display, weights 100–400 only, per the brand pack) and Plus Jakarta Sans (body). **Brand colours:** navy `#04070f`–`#1f3760`, gold `#c6a15b` / light `#e0c789`, paper `#f4f3ee`.

## Before launch

Several pieces of content are still placeholders: testimonials, portfolio photography and client marks, galleries, social profile links. The contact form still uses `mailto:`. See the [launch checklist](docs/content-guide.md#launch-checklist).
