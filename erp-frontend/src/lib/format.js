// Number / date formatting shared across the ERP.
//
// Two money formats on purpose:
//   money()  — compact (Rp 1.85 B). Headline stat cards and chart axes, where
//              the reader wants magnitude, not cents.
//   money2() — exact to 2 decimals (Rp 150,000,000.00). Journals, statements,
//              bonuses. Accounting cannot be done in "M".
//
// Both follow the active language. The feedback deck asked for 2-decimal
// precision written as "(,00)" — a decimal *comma*, which is the Indonesian
// convention. Precision alone was not the ask: 30.00% is not what an
// Indonesian finance team writes, 30,00% is.
//
//   en  ->  Rp 150,000,000.00   30.51%
//   id  ->  Rp 150.000.000,00   30,51%

const LOCALES = { en: 'en-US', id: 'id-ID' }

// The active locale is module state rather than a parameter because it would
// otherwise have to be threaded through ~150 call sites. It is set from the
// store's language action, which runs synchronously before React re-renders, so
// a component reading it during render always sees the current value.
let activeLocale = LOCALES.en

export function setNumberLocale(lang) {
  activeLocale = LOCALES[lang] || LOCALES.en
  return activeLocale
}

export function getNumberLocale() {
  return activeLocale
}

// Separators for the current locale, discovered from Intl rather than hardcoded.
function separators(locale = activeLocale) {
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 2 }).formatToParts(11111.11)
  return {
    decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.',
    group: parts.find((p) => p.type === 'group')?.value ?? ',',
  }
}

// Swap the decimal point in an already-rounded string for the locale's.
//
// Deliberately not toLocaleString: `(1.855).toFixed(2)` is "1.85" while Intl
// rounds it to "1.86". Rounding through toFixed keeps the compact figures
// byte-identical to what they were before localisation — Pipeline Value stays
// "Rp 1.85 B" and matches the client's own slide rather than drifting to 1.86.
function localiseDecimal(fixedString) {
  const { decimal } = separators()
  return decimal === '.' ? fixedString : fixedString.replace('.', decimal)
}

export function money(n) {
  if (n == null) return '—'
  if (Math.abs(n) >= 1_000_000_000) return `Rp ${localiseDecimal((n / 1_000_000_000).toFixed(2))} B`
  if (Math.abs(n) >= 1_000_000) return `Rp ${(n / 1_000_000).toFixed(0)} M`
  return `Rp ${n.toLocaleString(activeLocale)}`
}

export function money2(n) {
  if (n == null) return '—'
  return `Rp ${n.toLocaleString(activeLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Bare 2-decimal number, no currency prefix — for table columns that already
// carry a currency header.
export function num2(n) {
  if (n == null) return '—'
  return n.toLocaleString(activeLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function pct2(n) {
  if (n == null || Number.isNaN(n)) return '—'
  return `${localiseDecimal(n.toFixed(2))}%`
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

// The demo's "today". Deliberately fixed rather than new Date(): the seed
// narrative assumes late July 2026 (the cron reminder says a birthday on
// 28 Jul is "in 2 days"), and a live clock would drift the countdowns
// negative and make the demo inconsistent between sessions.
export const DEMO_TODAY = '2026-07-26'

/** The real date (local, ISO). The signed-out demo keeps its frozen clock; a real login uses this. */
export const realToday = () => new Date().toLocaleDateString('en-CA')
export const todayFor = (live) => (live ? realToday() : DEMO_TODAY)

// The app's "today": the real date once a real login has loaded the server's data, the demo's
// frozen date otherwise. The store flips it as `hydrated` changes (see the end of useStore.js), so
// every page, posting date and ageing report agrees without each one asking.
let liveClock = false
export const setLiveClock = (live) => { liveClock = Boolean(live) }
export const appToday = () => (liveClock ? realToday() : DEMO_TODAY)

const DAY_MS = 24 * 60 * 60 * 1000

// Parsed as UTC on purpose. These are date-only values, and mixing local-midnight
// parsing with UTC output (toISOString) shifted every derived date by a day
// outside UTC — the previous-period window came back a day early, and vendor
// availability windows opened a day too soon.
export function parseDate(d) {
  if (!d) return null
  const t = new Date(`${d}T00:00:00Z`)
  return Number.isNaN(t.getTime()) ? null : t
}

// Milliseconds back to a date-only ISO string, in UTC to match parseDate.
export function isoDate(ms) {
  return new Date(ms).toISOString().slice(0, 10)
}

// Whole days from DEMO_TODAY to `date`. Positive = future, negative = past.
export function daysUntil(date, from = appToday()) {
  const a = parseDate(from)
  const b = parseDate(date)
  if (!a || !b) return null
  return Math.round((b - a) / DAY_MS)
}

export function daysSince(date, from = appToday()) {
  const d = daysUntil(date, from)
  return d == null ? null : -d
}

// "D-42" / "D-day" / "D+10" — the project day counter the deck asked for.
export function dayCounter(date) {
  const d = daysUntil(date)
  if (d == null) return null
  if (d === 0) return 'D-day'
  return d > 0 ? `D-${d}` : `D+${Math.abs(d)}`
}

// First day of the calendar quarter containing `iso`.
//
// Previously the Accounting screen hardcoded the quarter start as July, which
// was only correct because DEMO_TODAY happened to fall in Q3. Moving the demo
// date into another quarter would have left "This Quarter" pointing at a
// period that had not started yet.
export function quarterStart(iso = appToday()) {
  const [y, m] = String(iso).split('-').map(Number)
  if (!y || !m) return iso
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1
  return `${y}-${String(startMonth).padStart(2, '0')}-01`
}

export function monthStart(iso = appToday()) {
  return `${String(iso).slice(0, 7)}-01`
}

export function yearStart(iso = appToday()) {
  return `${String(iso).slice(0, 4)}-01-01`
}

// Shift an ISO date by whole years. Used for year-over-year comparison, where
// the question is "the same window, one year earlier".
export function shiftYears(iso, years) {
  if (!iso) return iso
  const [y, ...rest] = String(iso).split('-')
  return [Number(y) + years, ...rest].join('-')
}

// Shift a { from, to } window by whole years, keeping its length.
export function shiftPeriodYears(period, years) {
  if (!period?.from || !period?.to) return null
  return { from: shiftYears(period.from, years), to: shiftYears(period.to, years) }
}

// Calendar-month helpers. Month-on-month has to mean the *previous calendar
// month*, not "31 days earlier" — day arithmetic on a 31-day window lands on
// 30 May, which is neither June nor useful.
export function previousMonthKey(key) {
  const [y, m] = String(key).split('-').map(Number)
  if (!y || !m) return key
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}

// Inclusive first/last day of a YYYY-MM key, so February and 30-day months are
// handled without a lookup table.
export function monthRange(key) {
  const [y, m] = String(key).split('-').map(Number)
  if (!y || !m) return null
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const mm = String(m).padStart(2, '0')
  return { from: `${y}-${mm}-01`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` }
}

// The window immediately before this one, of the same length. Correct for an
// arbitrary custom range; use monthRange/previousMonthKey for months.
export function previousPeriod(period) {
  if (!period?.from || !period?.to) return null
  const from = parseDate(period.from)
  const to = parseDate(period.to)
  if (!from || !to) return null
  const days = Math.max(1, Math.round((to - from) / DAY_MS) + 1)
  return {
    from: isoDate(from.getTime() - days * DAY_MS),
    to: isoDate(from.getTime() - DAY_MS),
  }
}

// Month names follow the language: "22 Oct 2026" in English, "22 Okt 2026" in
// Bahasa Indonesia.
export function formatDate(d) {
  const t = parseDate(d)
  if (!t) return d ?? '—'
  return t.toLocaleDateString(activeLocale === 'id-ID' ? 'id-ID' : 'en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

// ---------------------------------------------------------------------------
// Project margin
// ---------------------------------------------------------------------------

// Forecast margin for work in progress, actual margin once finished.
//
// This replaces the old (contractValue - realizedCost) / contractValue used on
// the dashboard. That formula reported ~60% company margin because a project
// at "Client Approval" has barely spent anything yet — it was measuring
// "how little have we spent so far", not profitability. Comparing against
// estimated cost until the project closes is the honest read, and lands the
// company average at ~30% as the client expects.
export function projectMargin(p) {
  if (!p?.contractValue) return 0
  const cost = p.stage === 'Finished' ? p.realizedCost : Math.max(p.estimatedCost ?? 0, p.realizedCost ?? 0)
  return ((p.contractValue - cost) / p.contractValue) * 100
}

export function projectCostBasis(p) {
  if (!p) return 0
  return p.stage === 'Finished' ? p.realizedCost : Math.max(p.estimatedCost ?? 0, p.realizedCost ?? 0)
}
