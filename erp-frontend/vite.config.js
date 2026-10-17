import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Served under /erp on the production site (same link as the marketing site);
// stays at root for local dev.
export default defineConfig(({ mode }) => ({
  base: mode === 'production' ? '/erp/' : '/',
  plugins: [react()],
  server: { port: 5273, open: true },
}))
