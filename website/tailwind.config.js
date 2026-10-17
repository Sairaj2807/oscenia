/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          950: '#04070f',
          900: '#060b16',
          800: '#0a1424',
          700: '#0f1d33',
          600: '#16294a',
          500: '#1f3760',
        },
        gold: {
          DEFAULT: '#c6a15b',
          light: '#e0c789',
          dark: '#9c7c3f',
        },
        // The intro's light chapters and the client strip are not white — they
        // are the warm paper the company film is set on. Sampled from the
        // reference recording (#f4f3ee).
        paper: {
          DEFAULT: '#f4f3ee',
          dim: '#e7e4da',
        },
      },
      // The brand pack ships exactly two faces, so both serif roles are the same
      // family: Fraunces carries display and headings, Plus Jakarta Sans carries
      // body. Fraunces is requested as a variable font capped at weight 400,
      // because the pack is explicit that only Thin, Light, Regular and Italic
      // are to be used — see index.html.
      fontFamily: {
        display: ['Fraunces', 'Georgia', 'serif'],
        serif: ['Fraunces', 'Georgia', 'serif'],
        sans: ['"Plus Jakarta Sans"', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        brand: '0.35em',
      },
      maxWidth: {
        content: '1200px',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        // Gentler than Tailwind's built-in pulse, which dips to 0.5 and reads
        // as a flash on a quiet splash screen.
        'pulse-soft': {
          '0%, 100%': { opacity: '0.8' },
          '50%': { opacity: '0.35' },
        },
        // The hero backdrop never sits still in the reference: it is a slow,
        // continuous push into the table setting. Alternate direction so the
        // loop never snaps back.
        'ken-burns': {
          '0%': { transform: 'scale(1) translate3d(0, 0, 0)' },
          '100%': { transform: 'scale(1.16) translate3d(-2%, -1.2%, 0)' },
        },
        // Client strip. The track holds two identical runs, so translating by
        // exactly half its width loops without a seam.
        marquee: {
          '0%': { transform: 'translateX(0)' },
          '100%': { transform: 'translateX(-50%)' },
        },
        // Gold light drifting across the testimonial card. It rocks rather than
        // sweeps past: the reference always has warm light somewhere on the
        // card, where a full traverse leaves it flat black most of the cycle.
        sheen: {
          '0%': { transform: 'translateX(-8%) rotate(18deg)' },
          '100%': { transform: 'translateX(58%) rotate(18deg)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 1.2s ease-out both',
        'pulse-soft': 'pulse-soft 2.6s ease-in-out infinite',
        'ken-burns': 'ken-burns 26s ease-in-out infinite alternate',
        marquee: 'marquee 38s linear infinite',
        sheen: 'sheen 9s ease-in-out infinite alternate',
      },
    },
  },
  plugins: [],
}
