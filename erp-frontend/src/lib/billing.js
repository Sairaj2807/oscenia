// Phased down-payment schedules.
//
// The client asked that "Down Payment (DP) requests can be configured flexibly
// and in phases according to negotiation agreements with clients": standard
// 50% / 75% / 100% presets for speed, plus fully custom percentages or nominal
// figures, with the system then issuing "draft billing schedules for DP
// installments and final settlements in the Account Receivable (AR) module".
//
// A quotation used to carry a single `dpPercent` number and produce exactly one
// invoice. It now carries a list of STAGES, and the schedule those stages
// resolve to becomes the project's billing plan.
//
// Stage shape:
//   {
//     label:      'Down Payment' | 'Second Installment' | …
//     basis:      'percent' | 'amount'
//     value:      50            | 75_000_000
//     anchor:     'signing' | 'event'   — what the due date is measured from
//     offsetDays: 0 | -7 | 30           — negative is before the anchor
//   }

import { parseDate, isoDate, appToday } from './format.js'

const DAY_MS = 24 * 60 * 60 * 1000

export function addDays(iso, days) {
  const t = parseDate(iso)
  if (!t) return iso
  return isoDate(t.getTime() + (Number(days) || 0) * DAY_MS)
}

export const ANCHORS = [
  { key: 'signing', label: 'from signing' },
  { key: 'event', label: 'from the event date' },
]

// The presets the client named. Each is a complete schedule totalling 100% —
// a preset that left a hole would not be a shortcut, it would be a trap.
export const DP_PRESETS = [
  {
    key: '50',
    label: '50%',
    hint: 'Half on signing, half before the event',
    stages: [
      { label: 'Down Payment', basis: 'percent', value: 50, anchor: 'signing', offsetDays: 0 },
      { label: 'Final Settlement', basis: 'percent', value: 50, anchor: 'event', offsetDays: -7 },
    ],
  },
  {
    key: '75',
    label: '75%',
    hint: 'Three quarters up front, balance before the event',
    stages: [
      { label: 'Down Payment', basis: 'percent', value: 75, anchor: 'signing', offsetDays: 0 },
      { label: 'Final Settlement', basis: 'percent', value: 25, anchor: 'event', offsetDays: -7 },
    ],
  },
  {
    key: '100',
    label: '100%',
    hint: 'Paid in full on signing',
    stages: [
      { label: 'Full Payment', basis: 'percent', value: 100, anchor: 'signing', offsetDays: 0 },
    ],
  },
  {
    key: 'staged',
    label: '30 / 40 / 30',
    hint: 'Deposit, production milestone, settlement',
    stages: [
      { label: 'Down Payment', basis: 'percent', value: 30, anchor: 'signing', offsetDays: 0 },
      { label: 'Production Milestone', basis: 'percent', value: 40, anchor: 'event', offsetDays: -30 },
      { label: 'Final Settlement', basis: 'percent', value: 30, anchor: 'event', offsetDays: 7 },
    ],
  },
]

export function presetStages(key) {
  const preset = DP_PRESETS.find((p) => p.key === key)
  return preset ? preset.stages.map((st) => ({ ...st })) : null
}

// Which preset a stage list matches, or null for custom. Compared on the
// substance — labels are the user's to rename without leaving the preset.
export function matchPreset(stages) {
  const shape = (list) => (list || []).map((st) => `${st.basis}:${st.value}:${st.anchor}:${st.offsetDays}`).join('|')
  const mine = shape(stages)
  return DP_PRESETS.find((p) => shape(p.stages) === mine)?.key || null
}

// A quotation from before phased DP existed carries only `dpPercent`. Reading
// that as a two-stage schedule keeps every existing quote, and the seed data,
// working without a migration.
export function stagesFor(quotation) {
  if (quotation?.dpSchedule?.length) return quotation.dpSchedule
  const dp = quotation?.dpPercent ?? 30
  const stages = [{ label: 'Down Payment', basis: 'percent', value: dp, anchor: 'signing', offsetDays: 0 }]
  if (dp < 100) {
    stages.push({ label: 'Final Settlement', basis: 'percent', value: 100 - dp, anchor: 'event', offsetDays: -7 })
  }
  return stages
}

export function stageAmount(stage, contractValue) {
  if (!stage) return 0
  return stage.basis === 'amount'
    ? Math.round(Number(stage.value) || 0)
    : Math.round((contractValue * (Number(stage.value) || 0)) / 100)
}

export function stagePercent(stage, contractValue) {
  if (!contractValue) return 0
  return (stageAmount(stage, contractValue) / contractValue) * 100
}

export function scheduleTotal(stages, contractValue) {
  return (stages || []).reduce((a, st) => a + stageAmount(st, contractValue), 0)
}

// What is still unallocated. Zero means the schedule bills the whole contract;
// anything else is a hole in the billing plan and the editor says so.
export function scheduleBalance(stages, contractValue) {
  return contractValue - scheduleTotal(stages, contractValue)
}

// Turn stages into a dated, costed billing schedule.
//
// The final stage absorbs any rounding remainder, so the schedule always adds
// up to the contract value to the rupiah. Splitting 314,000,000 three ways
// otherwise loses a rupiah, and an invoice that is one rupiah short is an
// invoice someone has to write off by hand.
export function resolveSchedule(stages, contractValue, { signingDate = appToday(), eventDate } = {}) {
  const list = stages || []
  const rows = list.map((st, i) => {
    const anchor = st.anchor === 'event' && eventDate ? eventDate : signingDate
    return {
      index: i,
      label: st.label || `Stage ${i + 1}`,
      basis: st.basis,
      value: st.value,
      anchor: st.anchor,
      offsetDays: st.offsetDays || 0,
      amount: stageAmount(st, contractValue),
      due: addDays(anchor, st.offsetDays || 0),
    }
  })

  const total = rows.reduce((a, r) => a + r.amount, 0)
  const remainder = contractValue - total
  if (rows.length && Math.abs(remainder) > 0 && Math.abs(remainder) < list.length + 1) {
    rows[rows.length - 1].amount += remainder
  }

  return rows.map((r) => ({
    ...r,
    percent: contractValue ? (r.amount / contractValue) * 100 : 0,
  }))
}

// Returns an error string, or null when the schedule is safe to save.
export function validateSchedule(stages, contractValue) {
  const list = stages || []
  if (!list.length) return 'A quotation needs at least one payment stage.'
  if (list.some((st) => !(Number(st.value) > 0))) return 'Every stage needs an amount greater than zero.'
  if (!contractValue) return 'Add line items before setting the payment schedule.'
  const balance = scheduleBalance(list, contractValue)
  // A rupiah either way is rounding, and resolveSchedule absorbs it.
  if (Math.abs(balance) > list.length) {
    return balance > 0
      ? `The schedule bills less than the contract — ${balance.toLocaleString('en-US')} unallocated.`
      : `The schedule bills more than the contract by ${Math.abs(balance).toLocaleString('en-US')}.`
  }
  return null
}

// The type an invoice takes for a stage: the first is the down payment, the
// last a final settlement, anything between a progress bill. Drives which
// revenue account issueInvoice() posts to.
export function stageInvoiceType(index, count) {
  if (index === 0) return 'Down Payment'
  if (index === count - 1) return 'Final'
  return 'Progress'
}
