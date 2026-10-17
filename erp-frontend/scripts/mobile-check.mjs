// Phone-width check for the prototype screens: serves the production build, opens each page
// at 390 × 844 (iPhone 12–15 size) in a headless browser, and reports
//   · anything that runs off the right edge (outside areas meant to scroll sideways),
//   · JavaScript errors,
// and saves a screenshot per page to look at.
//
// Run: npm run build && node scripts/mobile-check.mjs [screenshot-dir]
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { startPreview } from './preview-server.mjs'

const OUT = process.argv[2] || 'mobile-shots'
mkdirSync(OUT, { recursive: true })

const PAGES = [
  ['signin', '/', { signedOut: true }],
  ['workspace', '/workspace'],
  ['workspace-bell', '/workspace', { click: 'button[aria-label^="Notifications"]' }],
  ['workspace-stuck', '/workspace', { click: 'button[role="tab"]:nth-child(3)' }],
  ['project-board', '/workspace/EVT-2026-GALA-01'],
  ['task-drawer', '/workspace/EVT-2026-GALA-01?task=T-102'],
  ['chat', '/chat/ch-gala-general'],
  // Threads are gone (round 3): the former thread reply now shows in the stream as a quote.
  ['chat-quoted-reply', '/chat/ch-devconf-design'],
  ['chat-meeting', '/chat/ch-gala-general?meeting=MTG-1'],
  ['chat-settings', '/chat/ch-gala-general?settings=ch-gala-general'],
  ['chat-drawer', '/chat/ch-gala-general', { click: 'button[aria-label="Open channel list"]' }],
  ['vendors-pipeline', '/vendors?view=pipeline'],
  ['vendors-po-pipeline', '/vendors?view=po'],
  ['po-pipeline', '/purchase-orders?view=pipeline'],
  // Round 4: the journal entry pop-up before a down payment posts, and the editable lines in
  // Receive Payment.
  ['posting-popup', '/finance', { click: 'role=button[name="Confirm Down Payment"s] >> nth=0' }],
  ['posting-receive', '/receivables', { click: 'role=button[name="Receive"s] >> nth=0' }],
  ['vendor-detail', '/vendors/V-05'],
  ['events', '/events'],
  ['event-invitation', '/events/EV-01?tab=invitation'],
  ['event-guests', '/events/EV-01?tab=guests'],
  ['event-reminders', '/events/EV-01?tab=reminders'],
  ['event-checkin', '/events/EV-01?tab=checkin'],
  ['event-report', '/events/EV-02?tab=report'],
  ['event-send', '/events/EV-01?tab=send'],
  // Invitations v2: the gallery (staff and client), its live preview, the editor, the client's
  // Send invitations tab, and the guest page — the cover gate with a guest's name, then opened.
  ['event-gallery', '/events/EV-03?tab=invitation'],
  ['gallery-preview', '/events/EV-03?tab=invitation', { click: 'role=button[name="Live preview"s] >> nth=0' }],
  ['invite-gallery', '/invite/EV-03/edit?key=wibowo-5h2m'],
  ['invite-public', '/invite/EV-01'],
  ['invite-cover-name', '/invite/EV-01?g=7wdrqp'],
  ['invite-opened', '/invite/EV-01?g=7wdrqp', { click: 'role=button[name="Open invitation"s]', full: true }],
  ['invite-edit', '/invite/EV-01/edit?key=aurora-7f2k'],
  ['invite-edit-send', '/invite/EV-01/edit?key=aurora-7f2k&tab=send', { full: true }],
  ['walkin-public', '/walkin/EV-01'],
  // Round 3: the Template Studio list, and the editor (a fresh browser has no studio template,
  // so duplicate a built-in to open one).
  ['template-studio', '/events/templates'],
  ['template-editor', '/events/templates', { click: 'role=button[name="Duplicate Gala"s]', full: true }],
  ['crm-clients', '/crm'],
  ['crm-contacts', '/crm?tab=contacts'],
  ['crm-calendar', '/crm?tab=calendar'],
  ['google-calendar', '/google-calendar'],
  ['client-360', '/crm/CL-01'],
]

const SESSION = JSON.stringify({ id: 'offline-ceo', email: 'rahmat@oscenia.co.id', role: 'ceo', name: 'R. Hartono', actions: [], offline: true })

// Everything that sticks out past the right edge, unless an ancestor scrolls or clips it.
function overflowReport() {
  const vw = window.innerWidth
  const clipped = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX
      if (ox === 'auto' || ox === 'scroll' || ox === 'hidden') return true
    }
    return false
  }
  const out = []
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.right <= vw + 1 || clipped(el)) continue
    const cls = (el.getAttribute('class') || '').split(' ').slice(0, 4).join(' ')
    out.push(`${el.tagName.toLowerCase()}.${cls} → right ${Math.round(r.right)}px`)
  }
  return { pageWidth: document.documentElement.scrollWidth, vw, offenders: out.slice(0, 6), total: out.length }
}

const server = await startPreview(4611)
const BASE = `http://localhost:${server.port}/erp`

const browser = await chromium.launch()
let problems = 0
try {
  for (const [name, path, opts = {}] of PAGES) {
    // isMobile is left off on purpose: a mobile browser zooms a too-wide page out to fit, which
    // hides the overflow instead of showing it. The page must fit 390px as it is.
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true })
    if (!opts.signedOut) await ctx.addInitScript((s) => sessionStorage.setItem('oscenia.offlineUser', s), SESSION)
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle' })
    if (opts.click) await page.click(opts.click, { timeout: 5000 }).catch((e) => errors.push(`click failed: ${e.message.split('\n')[0]}`))
    await page.waitForTimeout(900) // let open animations finish before the screenshot
    const r = await page.evaluate(overflowReport)
    await page.screenshot({ path: join(OUT, `${name}.png`), fullPage: Boolean(opts.full) })
    const bad = r.total > 0 || errors.length > 0 || r.pageWidth > 390
    if (bad) problems++
    console.log(`${bad ? 'FAIL' : 'PASS'}  ${name.padEnd(18)} page ${r.pageWidth}px / ${r.vw}px${r.total ? ` · ${r.total} overflowing` : ''}${errors.length ? ` · errors: ${errors.join(' | ')}` : ''}`)
    for (const o of r.offenders) console.log(`        ${o}`)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.stop()
}
console.log(problems ? `\n${problems} PAGE(S) WITH PHONE-WIDTH PROBLEMS` : '\nALL PAGES FIT A PHONE SCREEN')
process.exit(problems ? 1 : 0)
