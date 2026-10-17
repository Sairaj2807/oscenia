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
      },
      fontFamily: {
        display: ['Cinzel', 'serif'],
        serif: ['"Cormorant Garamond"', 'Georgia', 'serif'],
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
      letterSpacing: {
        brand: '0.35em',
      },
      keyframes: {
        'fade-up': {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        'pop': {
          '0%': { opacity: '0', transform: 'scale(0.96)' },
          '60%': { transform: 'scale(1.02)' },
          '100%': { opacity: '1', transform: 'scale(1)' },
        },
        'flash': {
          '0%,100%': { boxShadow: '0 0 0 0 rgba(198,161,91,0)' },
          '30%': { boxShadow: '0 0 0 3px rgba(198,161,91,0.7)' },
        },
      },
      animation: {
        'fade-up': 'fade-up 0.5s ease-out both',
        'pop': 'pop 0.45s ease-out both',
        'flash': 'flash 1.6s ease-out',
      },
    },
  },
  plugins: [],
}
