// Popovers and pop-ups in a real browser, at laptop and phone width: the notification panel
// and role menu close on an outside click, on Escape and on their own button; a pop-up opened
// on a scrolled page lands on the screen. Serves the production build (run `vite build` first).
//
// Run: node scripts/popover-check.mjs
import { chromium } from 'playwright'
import { startPreview } from './preview-server.mjs'

const SESSION = JSON.stringify({ id: 'o', role: 'ceo', name: 'R', actions: [], offline: true })

const server = await startPreview(4618)
const U = `http://localhost:${server.port}/erp`

let fails = 0
const ok = (c, m) => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) fails++ }
const browser = await chromium.launch()
try {
  for (const [w, h] of [[1366, 800], [390, 844]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } })
    await ctx.addInitScript((s) => sessionStorage.setItem('oscenia.offlineUser', s), SESSION)
    const p = await ctx.newPage()
    await p.goto(`${U}/workspace`, { waitUntil: 'networkidle' })
    // Outside the panel and harmless: the page title on a laptop; on a phone the panel covers
    // the page, so an empty stretch of the top bar.
    const outside = () => (w < 640 ? p.mouse.click(Math.round(w * 0.4), 32) : p.locator('h1').first().click({ force: true }))
    const bell = p.locator('button[aria-label^="Notifications"]')
    const panel = p.getByText('Mark all read')

    await bell.click(); ok(await panel.isVisible(), `${w}px: bell opens`)
    await p.getByText('For Agus P.').click(); ok(await panel.isVisible(), `${w}px: clicking inside the panel keeps it open`)
    await p.keyboard.press('Escape'); await p.waitForTimeout(150)
    ok(!(await panel.isVisible()), `${w}px: Escape closes it`)
    await bell.click(); await outside(); await p.waitForTimeout(150)
    ok(!(await panel.isVisible()), `${w}px: clicking outside the panel closes it`)
    await bell.click(); await bell.click(); await p.waitForTimeout(150)
    ok(!(await panel.isVisible()), `${w}px: clicking the bell again closes it`)
    if (w >= 640) {
      await bell.click(); await p.getByRole('tab', { name: /My tasks/ }).click({ force: true }); await p.waitForTimeout(150)
      ok(!(await panel.isVisible()) && await p.getByText('Waiting for my approval').isVisible(), `${w}px: clicking a tab closes it and opens the tab`)
    }
    await bell.click(); await p.getByText('Needs your approval').first().click(); await p.waitForTimeout(300)
    ok(!(await panel.isVisible()) && p.url().includes('?task='), `${w}px: clicking a notification opens it and closes the panel`)

    await p.goto(`${U}/workspace`, { waitUntil: 'networkidle' })
    const role = p.getByText('Signed in as')
    const roleBtn = p.locator('header button:has-text("RH")')
    await roleBtn.click(); ok(await role.isVisible(), `${w}px: role menu opens`)
    await bell.click(); await p.waitForTimeout(150)
    ok(!(await role.isVisible()) && await panel.isVisible(), `${w}px: opening the bell closes the role menu`)
    await p.keyboard.press('Escape')
    await roleBtn.click(); await outside(); await p.waitForTimeout(150)
    ok(!(await role.isVisible()), `${w}px: role menu closes on an outside click`)

    await p.goto(`${U}/crm?tab=contacts`, { waitUntil: 'networkidle' })
    // A campaign goes to ticked contacts (C1): tick everyone shown first.
    await p.check('input[aria-label="Select all shown"]', { force: true })
    await p.mouse.wheel(0, 900); await p.waitForTimeout(300)
    await p.click('button:has-text("Compose campaign")', { force: true }); await p.waitForTimeout(600)
    const box = await p.getByText('Campaign name').boundingBox()
    ok(box && box.y >= 0 && box.y < h, `${w}px: a pop-up opened on a scrolled page lands on screen`)
    await ctx.close()
  }
} finally {
  await browser.close()
  server.stop()
}
console.log(fails ? `\n${fails} POPOVER CHECK(S) FAILED` : '\nALL POPOVER CHECKS PASSED')
process.exit(fails ? 1 : 0)
