// Drives the PRODUCTION build served by the Caddy stack, in a real browser (Edge), as real users would.
// Run from erp-frontend/:   node scripts/stack-e2e.cjs
//
// Needs the stack up (see deploy/README.md) and three users made on it, all with the password below:
//   sdbangar2808@gmail.com (ceo), wh@test.co (warehouse), team@test.co (team)
// BASE is where the stack answers; a *.localhost name resolves to this machine in the browser.
// It exists because the Node suites cannot see browser-only failures: a relative API base once
// threw "Invalid URL" in `new URL` and no test noticed.
const { createRequire } = require('module')
const req = createRequire(__dirname + '/../package.json')
const { chromium } = req('playwright')

const BASE = process.env.STACK_URL || 'http://stage.localhost:8080'
const PW = 'correct-horse-battery-1'
let failures = 0
const check = (label, ok, detail = '') => {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

;(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true })

  async function session(email) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(e.message))
    await page.goto(`${BASE}/erp/`)
    await page.waitForSelector('input[type=email]')
    await page.fill('input[type=email]', email)
    await page.fill('input[type=password]', PW)
    await page.click('button[type=submit]')
    return { page, errors, ctx }
  }

  // 1. The login screen itself
  {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    await page.goto(`${BASE}/erp/`)
    await page.waitForSelector('input[type=email]')
    const text = await page.innerText('body')
    check('login screen has no demo accounts panel', !/Demo accounts/i.test(text))
    check('login screen does not advertise the demo password', !/oscenia-demo-2026/.test(text))
    check('email is not pre-filled', (await page.inputValue('input[type=email]')) === '')
    await page.fill('input[type=email]', 'rahmat@oscenia.co.id')
    await page.fill('input[type=password]', 'oscenia-demo-2026')
    await page.click('button[type=submit]')
    await page.waitForTimeout(1500)
    check('the published demo login is refused', await page.locator('input[type=email]').count() > 0)
    await ctx.close()
  }

  // 2. CEO
  {
    const { page, errors, ctx } = await session('sdbangar2808@gmail.com')
    await page.waitForSelector('text=Sairaj Bangar', { timeout: 20000 }).catch(() => {})
    const body = await page.innerText('body')
    check('CEO signs in and sees their own name', /Sairaj Bangar/.test(body))
    check('no "Prototype" / "Demo mode" badge', !/Demo mode|Prototype/i.test(body))
    check('no "demo data" warning', !/Showing demo data/i.test(body))
    await page.goto(`${BASE}/erp/accounting`)
    await page.waitForTimeout(2500)
    check('CEO can open Accounting', !/No access to this page/.test(await page.innerText('body')))
    check('no page errors for the CEO', errors.length === 0, errors[0] || '')
    await ctx.close()
  }

  // 3. Warehouse: data must load even though several collections are refused
  {
    const { page, errors, ctx } = await session('wh@test.co')
    await page.waitForTimeout(4000)
    const body = await page.innerText('body')
    check('warehouse login gets in (no "could not load" screen)', !/Could not load your data/.test(body), body.slice(0, 80).replace(/\n/g, ' '))
    check('warehouse sees their name, not a demo persona', /Wh Test/.test(body) && !/R\. Hartono/.test(body))
    await page.goto(`${BASE}/erp/accounting`)
    await page.waitForTimeout(1500)
    check('warehouse is stopped at /accounting', /No access to this page/.test(await page.innerText('body')))
    await page.goto(`${BASE}/erp/warehouse`)
    await page.waitForTimeout(2500)
    check('warehouse can open Warehouse', !/No access to this page/.test(await page.innerText('body')))
    check('no page errors for warehouse', errors.length === 0, errors[0] || '')
    await ctx.close()
  }

  // 4. Team member: chat/workspace only
  {
    const { page, errors, ctx } = await session('team@test.co')
    await page.waitForTimeout(4000)
    const body = await page.innerText('body')
    check('team login gets in', !/Could not load your data/.test(body))
    check('team lands outside the finance dashboard', /\/erp\/chat/.test(page.url()) || !/Total Cash/.test(body), page.url())
    await page.goto(`${BASE}/erp/finance`)
    await page.waitForTimeout(1500)
    check('team is stopped at /finance', /No access to this page/.test(await page.innerText('body')))
    check('no page errors for team', errors.length === 0, errors[0] || '')
    await ctx.close()
  }

  await browser.close()
  console.log(failures ? `\n${failures} CHECK(S) FAILED` : '\nALL BROWSER CHECKS PASSED')
  process.exit(failures ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(2) })
