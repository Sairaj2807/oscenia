// Vite config for the render check only: renders against live store state (see zustand-live.js).
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'

export default {
  plugins: [react()],
  resolve: {
    alias: [{ find: /^zustand$/, replacement: fileURLToPath(new URL('./zustand-live.js', import.meta.url)) }],
  },
}
