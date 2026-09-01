# Oscenia Events — Website

Marketing site for **Oscenia Events**, a strategic events & immersive-experiences company (Jakarta · Bali · Singapore). Built to match the "Landing Page Visual Direction" deck.

## Stack

- **React 19** + **Vite**
- **Tailwind CSS v3** (custom navy/gold luxury theme)
- **React Router** (multi-page: Home · About · Services · Contact)

## Run locally

```bash
cd oscenia-web
npm install
npm run dev      # http://localhost:5173
```

Other scripts:

```bash
npm run build    # production build to /dist
npm run preview  # serve the production build
```

## Project structure

```
src/
  components/     # Nav, Footer, Layout, Wordmark, CTA, Media, Icon, Reveal
  data/site.js    # ALL copy + content lives here (single source of truth)
  pages/          # Home, About, Services, Contact, NotFound
  index.css       # theme tokens, buttons, backgrounds
tailwind.config.js  # colors (navy/gold), fonts (Cinzel/Cormorant/Inter)
```

## Swapping in real images

The site currently renders elegant **labeled placeholders** wherever a photo goes.
To use real photography/logos:

1. Drop image files into `public/` (e.g. `public/portfolio/lamborghini.jpg`).
2. Set the matching `img:` / `src` field in **`src/data/site.js`** (or the page's `<Media src="…">`), e.g.

   ```js
   { title: 'Lamborghini Car Launch', client: 'Lamborghini', img: '/portfolio/lamborghini.jpg', featured: true }
   ```

Any `<Media>` with an empty `src` shows the placeholder; any with a real path shows the image.

### Content to update before launch
- Hero cover photo, "What We Direct" tiles, Vision image, Portfolio grid + Lamborghini gallery
- Client logo strip (`CLIENTS` in `site.js`)
- Real phone number, social links, testimonials, and map link (`CONTACT` / `SOCIALS` / `TESTIMONIALS`)
- The contact form currently opens the visitor's email client (`mailto:`). Wire it to a form service (Formspree, Resend, etc.) or an API endpoint for production.
