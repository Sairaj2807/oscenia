// Serves the production build for the browser checks (mobile-check, popover-check).
//   - Refuses to go on if its own server did not start: with --strictPort a port already taken
//     (say, by a checkout in another folder) would otherwise test somebody else's build.
//   - stop() ends the whole process tree: on Windows, killing the `npx` shell leaves Vite running.
// The port can be moved with PREVIEW_PORT when two checkouts run their checks at once.
import { spawn, spawnSync } from 'node:child_process'

export async function startPreview(defaultPort) {
  const port = Number(process.env.PREVIEW_PORT) || defaultPort
  const server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort'], { shell: true, stdio: 'pipe' })
  let log = ''
  const ready = await new Promise((resolve) => {
    // Vite colours its output, so the codes are stripped before looking for the address.
    const onData = (d) => { log += d; if (log.replace(/\x1b\[[0-9;]*m/g, '').includes(`localhost:${port}/`)) resolve(true) }
    server.stdout.on('data', onData)
    server.stderr.on('data', (d) => { log += d })
    server.on('exit', () => resolve(false))
    setTimeout(() => resolve(false), 15000)
  })
  const stop = () => {
    if (server.exitCode !== null) return
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
    else server.kill()
  }
  if (!ready) {
    stop()
    console.error(`Could not start the preview server on port ${port} (in use? set PREVIEW_PORT).\n${log.trim()}`)
    process.exit(2)
  }
  return { port, stop }
}
