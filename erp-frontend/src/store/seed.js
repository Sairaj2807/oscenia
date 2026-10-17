// Mock "database" for the prototype. All data derived from docs/PRD-ERP-Oscenia.md.
// Everything hangs off Project ID (format EVT-2026-GALA-01).

import { account, CASH_ACCOUNTS } from '../lib/accounts.js'
import { SEED_VOUCHER_SERIES, pickSeries, formatVoucher, counterKey } from '../lib/vouchers.js'

export const STAGES = [
  'DP Paid',
  'Design Uploaded',
  'Client Approval',
  'Vendor Dispatch',
  'Execution Event',
  'Post-Event Feedback',
  'Finished',
]

export const seedProjects = [
  {
    id: 'EVT-2026-GALA-01',
    name: 'Aurora Bank Annual Gala',
    client: 'Aurora Bank',
    stage: 'Execution Event',
    division: 'Field',
    contractValue: 480_000_000,
    realizedCost: 322_000_000,
    estimatedCost: 336_000_000,
    eventDate: '2026-08-14',
    pm: 'Dinda A.',
    stageSince: '2026-07-19',
  },
  {
    id: 'EVT-2026-WED-02',
    name: 'Wibowo–Sari Wedding',
    client: 'Keluarga Wibowo',
    stage: 'Client Approval',
    division: 'Design',
    contractValue: 265_000_000,
    // PO-3004 is approved but not yet invoiced by the vendor, so its
    // 116,700,000 is a commitment rather than a realized cost.
    realizedCost: 61_000_000,
    estimatedCost: 180_000_000,
    eventDate: '2026-09-05',
    pm: 'Dinda A.',
    stageSince: '2026-07-12',
  },
  {
    id: 'EVT-2026-CONF-03',
    name: 'TechNusa Developer Conference',
    client: 'TechNusa',
    stage: 'Design Uploaded',
    division: 'Design',
    contractValue: 720_000_000,
    // Includes PO-3003's bill (20,780,000).
    realizedCost: 108_780_000,
    estimatedCost: 505_000_000,
    eventDate: '2026-10-22',
    pm: 'R. Hartono',
    stageSince: '2026-07-22',
  },
  {
    id: 'EVT-2026-PROD-04',
    name: 'Meridian Product Launch',
    client: 'Meridian Cosmetics',
    stage: 'Finished',
    division: 'Field',
    contractValue: 390_000_000,
    realizedCost: 268_000_000,
    estimatedCost: 275_000_000,
    eventDate: '2026-06-30',
    pm: 'Dinda A.',
    stageSince: '2026-06-30',
  },
]

// A pending deal used to demonstrate the LIVE trigger (Confirm DP -> creates a project).
export const pendingDeal = {
  id: 'DEAL-GALA-02',
  client: 'Aurora Bank',
  name: 'Aurora Bank Investor Summit',
  contractValue: 610_000_000,
  dpAmount: 183_000_000, // 30%
  projectIdOnConfirm: 'EVT-2026-GALA-02',
  eventDate: '2026-11-18',
}

// LTV is now COMPUTED from actual spend (see lib/crm.js) — past events + live
// projects — so it always reconciles with the history shown on the Client 360.
export const seedClients = [
  {
    id: 'CL-01', name: 'Aurora Bank', contact: 'Ibu Ratna', email: 'ratna@aurorabank.co.id', phone: '+62 812-1100-2200',
    birthday: '28 Jul', anniversary: '01 Mar 2019', personalBrand: 'Premium · understated · gold-accented',
    prefEvents: ['Corporate Gala', 'Investor Summit'], favVendor: 'Lumina LED', satisfaction: 4.8,
  },
  {
    id: 'CL-02', name: 'TechNusa', contact: 'Pak Aditya', email: 'aditya@technusa.io', phone: '+62 811-3040-5060',
    birthday: '02 Aug', anniversary: '09 Nov 2021', personalBrand: 'Bold · energetic · developer-first',
    prefEvents: ['Conference', 'Product Launch'], favVendor: 'SoundForge', satisfaction: 4.5,
  },
  {
    id: 'CL-03', name: 'Meridian Cosmetics', contact: 'Ibu Clara', email: 'clara@meridian.com', phone: '+62 813-7788-9900',
    birthday: '15 Dec', anniversary: '20 May 2020', personalBrand: 'Elegant · feminine · rose-gold',
    prefEvents: ['Product Launch'], favVendor: 'StageWorks', satisfaction: 4.2,
  },
  {
    id: 'CL-04', name: 'Keluarga Wibowo', contact: 'Bpk. Wibowo', email: 'wibowo.family@gmail.com', phone: '+62 815-2233-4455',
    birthday: '30 Jul', anniversary: '—', personalBrand: 'Warm · traditional · intimate',
    prefEvents: ['Wedding'], favVendor: 'Bloom & Co', satisfaction: 5.0,
  },
]

// ---- Vendors ----
//
// Extended for the feedback deck (slide 6): NPWP, bank details, a per-vendor
// PPh 23 rate that overrides the company default, a PIC with a WhatsApp number,
// payment terms, and attachments. Previously a vendor was five fields with no
// way to actually pay one.
export const seedVendors = [
  {
    id: 'V-01', name: 'Lumina LED', category: 'LED / Visual',
    tags: ['corporate-gala', 'conference', 'product-launch', 'investor-summit', 'preferred-supplier'],
    baseline: 45_000_000, score: 4.7, delays: 0,
    npwp: '01.324.556.7-051.000',
    pph23Rate: 2,
    bank: { name: 'Bank Mandiri', account: '123-000-4567-890', holder: 'PT Lumina Visual Nusantara' },
    pic: { name: 'Pak Hendra', phone: '+62 811-2000-3001', email: 'hendra@luminaled.co.id' },
    terms: { dpPercent: 50, settlementDays: 14 },
    attachments: [
      { name: 'Pricelist 2026.pdf', kind: 'Pricelist', size: '1.2 MB' },
      { name: 'LED Catalogue.pdf', kind: 'Catalogue', size: '4.8 MB' },
      { name: 'Service Agreement (MoU).pdf', kind: 'Agreement', size: '340 KB' },
    ],
  },
  {
    id: 'V-02', name: 'SoundForge', category: 'Sound',
    tags: ['corporate-gala', 'conference', 'product-launch', 'wedding'],
    baseline: 38_000_000, score: 4.4, delays: 1,
    npwp: '02.778.112.4-014.000',
    pph23Rate: 2,
    bank: { name: 'BCA', account: '588-201-9944', holder: 'CV SoundForge Audio' },
    pic: { name: 'Bu Maya', phone: '+62 812-9100-4455', email: 'maya@soundforge.id' },
    terms: { dpPercent: 40, settlementDays: 21 },
    attachments: [
      { name: 'Audio Rental Pricelist.pdf', kind: 'Pricelist', size: '820 KB' },
      { name: 'Service Agreement (MoU).pdf', kind: 'Agreement', size: '298 KB' },
    ],
  },
  {
    id: 'V-03', name: 'StageWorks', category: 'Staging / Truss',
    tags: ['corporate-gala', 'conference', 'investor-summit', 'outdoor-capable'],
    baseline: 52_000_000, score: 4.1, delays: 2,
    npwp: '03.109.884.2-092.000',
    pph23Rate: 2,
    bank: { name: 'BNI', account: '007-4412-8890', holder: 'PT Stage Works Indonesia' },
    pic: { name: 'Pak Dedi', phone: '+62 813-4400-7788', email: 'dedi@stageworks.co.id' },
    terms: { dpPercent: 50, settlementDays: 30 },
    attachments: [
      { name: 'Staging Pricelist 2026.pdf', kind: 'Pricelist', size: '1.6 MB' },
      { name: 'Rigging Safety Cert.pdf', kind: 'Certificate', size: '512 KB' },
    ],
  },
  {
    id: 'V-04', name: 'Bloom & Co', category: 'Decor / Floral',
    tags: ['wedding', 'corporate-gala', 'preferred-supplier', 'rush-friendly'],
    baseline: 29_000_000, score: 4.9, delays: 0,
    npwp: '04.551.220.9-033.000',
    // Small supplier registered under a different withholding classification.
    pph23Rate: 1.5,
    bank: { name: 'Bank Mandiri', account: '900-771-2234', holder: 'Bloom & Co Florist' },
    pic: { name: 'Ibu Sinta', phone: '+62 815-7788-1200', email: 'sinta@bloomandco.id' },
    terms: { dpPercent: 30, settlementDays: 7 },
    attachments: [
      { name: 'Floral Lookbook 2026.pdf', kind: 'Catalogue', size: '6.1 MB' },
    ],
  },
  {
    id: 'V-05', name: 'BrightRig', category: 'Lighting',
    tags: ['corporate-gala', 'product-launch', 'wedding', 'outdoor-capable'],
    baseline: 41_000_000, score: 3.8, delays: 3,
    npwp: '05.660.331.5-071.000',
    pph23Rate: 2,
    bank: { name: 'CIMB Niaga', account: '445-8800-1177', holder: 'PT Bright Rig Lighting' },
    pic: { name: 'Pak Yusuf', phone: '+62 817-3300-9911', email: 'yusuf@brightrig.co.id' },
    terms: { dpPercent: 50, settlementDays: 14 },
    attachments: [
      { name: 'Lighting Pricelist.pdf', kind: 'Pricelist', size: '740 KB' },
    ],
  },
]

// Catalogue hierarchy. The deck asked for a "catalog drill-down ensuring search
// results match precise event categories" — the old flat table had no category
// at all, so nothing could be matched to an event type.
export const CATALOG_CATEGORIES = [
  { key: 'visual', label: 'Visual & LED', subcategories: ['LED Wall', 'Projection'] },
  { key: 'audio', label: 'Audio', subcategories: ['Speakers', 'Microphones'] },
  { key: 'lighting', label: 'Lighting', subcategories: ['Moving Head', 'Spot & Wash'] },
  { key: 'staging', label: 'Staging & Truss', subcategories: ['Truss', 'Deck'] },
  { key: 'decor', label: 'Decor & Floral', subcategories: ['Backdrop', 'Floral'] },
]

// Tags.
//
// This replaces a hardcoded EVENT_TYPES array. Tags are a single vocabulary
// that can be created by the user and applied to both vendors and catalogue
// items, so "which vendors can do an outdoor wedding" becomes a question the
// system can answer. Seeded with the event types that were hardcoded before,
// plus a few capability and commercial tags to show the vocabulary is not
// limited to event categories.
//
// Deliberately flat: the point is that the user invents their own vocabulary,
// and a fixed set of groups would just be the old hardcoded list again.
export const seedTags = [
  { id: 'corporate-gala', label: 'Corporate Gala' },
  { id: 'conference', label: 'Conference' },
  { id: 'product-launch', label: 'Product Launch' },
  { id: 'wedding', label: 'Wedding' },
  { id: 'investor-summit', label: 'Investor Summit' },
  { id: 'outdoor-capable', label: 'Outdoor Capable' },
  { id: 'preferred-supplier', label: 'Preferred Supplier' },
  { id: 'rush-friendly', label: 'Rush Friendly' },
]

// Tag ids are slugs derived from the label, so the same tag typed twice
// resolves to one tag rather than two that merely look alike.
export function slugifyTag(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

// vendor_inventories — third-party equipment with rental pricing.
//
// `bookings` is what makes availability date-aware. The old `available` number
// was static, so the same truss could be promised to two events on the same
// weekend. Availability is now computed for a date range (see lib/vendors.js).
export const vendorInventories = [
  {
    id: 'VI-01', item: 'LED Video Wall (per m²)', vendor: 'Lumina LED', vendorId: 'V-01',
    category: 'visual', subcategory: 'LED Wall', unitPrice: 2_400_000, stock: 320, unit: 'm²',
    tags: ['corporate-gala', 'conference', 'product-launch', 'investor-summit'],
    bookings: [{ from: '2026-08-10', to: '2026-08-16', projectId: 'EVT-2026-GALA-01', qty: 120, poId: 'PO-3001' }],
  },
  {
    id: 'VI-02', item: 'Line Array Speaker', vendor: 'SoundForge', vendorId: 'V-02',
    category: 'audio', subcategory: 'Speakers', unitPrice: 1_800_000, stock: 24, unit: 'unit',
    tags: ['corporate-gala', 'conference', 'product-launch', 'wedding'],
    bookings: [{ from: '2026-10-18', to: '2026-10-24', projectId: 'EVT-2026-CONF-03', qty: 8, poId: 'PO-3003' }],
  },
  {
    id: 'VI-03', item: 'Moving Head Light', vendor: 'BrightRig', vendorId: 'V-05',
    category: 'lighting', subcategory: 'Moving Head', unitPrice: 650_000, stock: 40, unit: 'unit',
    tags: ['corporate-gala', 'product-launch', 'wedding'],
    // No poId: these are holds placed by the production team ahead of a PO
    // being raised, so cancelling a PO must not release them.
    bookings: [
      { from: '2026-08-12', to: '2026-08-15', projectId: 'EVT-2026-GALA-01', qty: 34 },
      { from: '2026-09-03', to: '2026-09-07', projectId: 'EVT-2026-WED-02', qty: 12 },
    ],
  },
  {
    id: 'VI-04', item: 'Truss 3m Segment', vendor: 'StageWorks', vendorId: 'V-03',
    category: 'staging', subcategory: 'Truss', unitPrice: 480_000, stock: 200, unit: 'unit',
    tags: ['corporate-gala', 'conference', 'product-launch', 'investor-summit'],
    bookings: [{ from: '2026-08-08', to: '2026-08-18', projectId: 'EVT-2026-GALA-01', qty: 200, poId: 'PO-3002' }],
  },
  {
    id: 'VI-05', item: 'Stage Deck 2×1m', vendor: 'StageWorks', vendorId: 'V-03',
    category: 'staging', subcategory: 'Deck', unitPrice: 350_000, stock: 120, unit: 'unit',
    tags: ['corporate-gala', 'conference', 'wedding', 'investor-summit'],
    bookings: [],
  },
  {
    id: 'VI-06', item: 'Floral Backdrop (per m)', vendor: 'Bloom & Co', vendorId: 'V-04',
    category: 'decor', subcategory: 'Backdrop', unitPrice: 1_200_000, stock: 60, unit: 'm',
    tags: ['wedding', 'corporate-gala'],
    bookings: [{ from: '2026-09-02', to: '2026-09-08', projectId: 'EVT-2026-WED-02', qty: 45, poId: 'PO-3004' }],
  },
  {
    id: 'VI-07', item: 'Wireless Microphone', vendor: 'SoundForge', vendorId: 'V-02',
    category: 'audio', subcategory: 'Microphones', unitPrice: 220_000, stock: 32, unit: 'unit',
    tags: ['corporate-gala', 'conference', 'product-launch', 'wedding', 'investor-summit'],
    bookings: [{ from: '2026-10-20', to: '2026-10-23', projectId: 'EVT-2026-CONF-03', qty: 29, poId: 'PO-3003' }],
  },
  {
    id: 'VI-08', item: 'Follow Spot', vendor: 'BrightRig', vendorId: 'V-05',
    category: 'lighting', subcategory: 'Spot & Wash', unitPrice: 900_000, stock: 12, unit: 'unit',
    tags: ['corporate-gala', 'wedding', 'investor-summit'],
    bookings: [{ from: '2026-08-13', to: '2026-08-15', projectId: 'EVT-2026-GALA-01', qty: 12, poId: 'PO-3005' }],
  },
  {
    id: 'VI-09', item: 'Projector 20K Lumen', vendor: 'Lumina LED', vendorId: 'V-01',
    category: 'visual', subcategory: 'Projection', unitPrice: 3_100_000, stock: 8, unit: 'unit',
    tags: ['conference', 'product-launch', 'investor-summit'],
    bookings: [],
  },
  {
    id: 'VI-10', item: 'Table Centrepiece', vendor: 'Bloom & Co', vendorId: 'V-04',
    category: 'decor', subcategory: 'Floral', unitPrice: 285_000, stock: 400, unit: 'pcs',
    tags: ['wedding', 'corporate-gala', 'investor-summit'],
    bookings: [{ from: '2026-09-04', to: '2026-09-06', projectId: 'EVT-2026-WED-02', qty: 220, poId: 'PO-3004' }],
  },
]

// ---- Purchase Orders ----
//
// New entity. The deck asked for "Select & Create PO" plus DP / final
// settlement terms; there was no PO concept anywhere in the system before.
//
// Lifecycle: Draft -> Approved -> DP Paid -> Settled (or Cancelled).
// Approval is a commitment and posts nothing. Paying the DP and settling the
// balance each post to the ledger, withholding PPh 23 at the vendor's own rate,
// tagged to the Project ID so the cost lands on that project's P&L.
export const PO_STATUSES = ['Draft', 'Approved', 'DP Paid', 'Settled', 'Cancelled']

export const seedPurchaseOrders = [
  {
    id: 'PO-3001', vendorId: 'V-01', project: 'EVT-2026-GALA-01',
    status: 'Settled', date: '2026-06-12', eventDate: '2026-08-14',
    terms: { dpPercent: 50, settlementDays: 14 },
    lines: [{ itemId: 'VI-01', item: 'LED Video Wall (per m²)', qty: 17.5, unitPrice: 2_400_000 }],
    dpPaidAt: '2026-06-15', settledAt: '2026-06-18',
  },
  {
    id: 'PO-3002', vendorId: 'V-03', project: 'EVT-2026-GALA-01',
    status: 'Settled', date: '2026-07-02', eventDate: '2026-08-14',
    terms: { dpPercent: 50, settlementDays: 30 },
    lines: [
      { itemId: 'VI-04', item: 'Truss 3m Segment', qty: 150, unitPrice: 480_000 },
      { itemId: 'VI-05', item: 'Stage Deck 2×1m', qty: 68, unitPrice: 350_000 },
    ],
    dpPaidAt: '2026-07-05', settledAt: '2026-07-10',
  },
  {
    id: 'PO-3003', vendorId: 'V-02', project: 'EVT-2026-CONF-03',
    status: 'DP Paid', date: '2026-07-15', eventDate: '2026-10-22',
    terms: { dpPercent: 40, settlementDays: 21 },
    lines: [
      { itemId: 'VI-02', item: 'Line Array Speaker', qty: 8, unitPrice: 1_800_000 },
      { itemId: 'VI-07', item: 'Wireless Microphone', qty: 29, unitPrice: 220_000 },
    ],
    dpPaidAt: '2026-07-16', settledAt: null,
  },
  {
    id: 'PO-3004', vendorId: 'V-04', project: 'EVT-2026-WED-02',
    status: 'Approved', date: '2026-07-24', eventDate: '2026-09-05',
    terms: { dpPercent: 30, settlementDays: 7 },
    lines: [
      { itemId: 'VI-06', item: 'Floral Backdrop (per m)', qty: 45, unitPrice: 1_200_000 },
      { itemId: 'VI-10', item: 'Table Centrepiece', qty: 220, unitPrice: 285_000 },
    ],
    dpPaidAt: null, settledAt: null,
  },
  {
    id: 'PO-3005', vendorId: 'V-05', project: 'EVT-2026-GALA-01',
    status: 'Draft', date: '2026-07-25', eventDate: '2026-08-14',
    terms: { dpPercent: 50, settlementDays: 14 },
    lines: [{ itemId: 'VI-08', item: 'Follow Spot', qty: 12, unitPrice: 900_000 }],
    dpPaidAt: null, settledAt: null,
  },
]

// Invoices reconcile with the ledger: the unpaid ones sum to Accounts
// Receivable (1201) = Rp 465,000,000, and each paid one has a matching receipt
// entry in seedJournal. Due dates are real dates so the AR ageing buckets and
// the DP countdown on Finance have something to measure against DEMO_TODAY.
// `paid` is what has actually been collected against the invoice, at GROSS —
// PPh 23 withheld by the client still settles the receivable, it just arrives
// as a tax credit instead of as cash. Tracking it separately from `amount` is
// what makes partial settlement expressible and lets the AR ageing measure what
// is still outstanding rather than the face value of the invoice.
export const seedInvoices = [
  { id: 'INV-0041', project: 'EVT-2026-GALA-01', type: 'Down Payment', amount: 144_000_000, paid: 144_000_000, status: 'Paid', due: '2026-05-10' },
  { id: 'INV-0042', project: 'EVT-2026-GALA-01', type: 'Progress', amount: 192_000_000, paid: 0, status: 'Unpaid', due: '2026-07-30' },
  { id: 'INV-0039', project: 'EVT-2026-CONF-03', type: 'Down Payment', amount: 216_000_000, paid: 216_000_000, status: 'Paid', due: '2026-06-01' },
  { id: 'INV-0044', project: 'EVT-2026-WED-02', type: 'Down Payment', amount: 79_500_000, paid: 79_500_000, status: 'Paid', due: '2026-06-20' },
  { id: 'INV-0038', project: 'EVT-2026-PROD-04', type: 'Down Payment', amount: 117_000_000, paid: 117_000_000, status: 'Paid', due: '2026-04-05' },
  { id: 'INV-0040', project: 'EVT-2026-PROD-04', type: 'Final', amount: 273_000_000, paid: 273_000_000, status: 'Paid', due: '2026-07-15' },
]

// Requests carry a date so the Project ID / Status / Date filters the deck
// asked for all have something to filter on. PR-101 and PR-102 are Disbursed
// (not the old 'Paid') because the deck redefined the flow with Disbursed and
// Completed as separate stages — Completed only once the expense report lands.
export const seedProcurement = [
  { id: 'PR-101', project: 'EVT-2026-GALA-01', category: 'Field Cash Advance', amount: 8_500_000, status: 'Disbursed', by: 'Bagus S.', proof: true, date: '2026-07-05' },
  { id: 'PR-102', project: 'EVT-2026-GALA-01', category: 'Petty Cash — Crew Meals', amount: 3_200_000, status: 'Completed', by: 'Bagus S.', proof: true, date: '2026-07-06', actual: 3_200_000, variance: 0 },
  { id: 'PR-103', project: 'EVT-2026-CONF-03', category: 'Vendor — Sound', amount: 38_000_000, status: 'Pending', by: 'Dinda A.', proof: false, date: '2026-07-21' },
  { id: 'PR-104', project: 'EVT-2026-WED-02', category: 'Decor / Floral', amount: 29_000_000, status: 'Draft', by: 'Dinda A.', proof: false, date: '2026-07-24' },
]

// Operational petty-cash float; Paid petty-cash/cash-advance requests deduct from it.
export const pettyCashStart = 40_000_000

// Warehouse stock.
//
// `status` is explicit rather than encoded in a free-text location string.
// The old code detected in-transit items with /in-transit/i against
// 'In-Transit → Aurora Gala', which meant the project link was untyped and
// unqueryable. Now: in_stock | in_transit | maintenance | written_off, with a
// real projectId + eventDate on anything out on a job.
//
// `unitValue` is new and load-bearing: a Lost / Total Damage check-in posts an
// Asset Loss Expense journal entry at unitValue x qty, so the figure has to be
// real. Fixed-asset value totals 640,000,000 = ledger account 1302.
export const seedInventory = [
  { id: 'IT-01', item: 'Duct Tape (roll)', type: 'Consumable', qty: 240, unit: 'pcs', unitValue: 35_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-02', item: 'Cable Ties (pack)', type: 'Consumable', qty: 180, unit: 'pack', unitValue: 45_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-03', item: 'Microphone Batteries', type: 'Consumable', qty: 96, unit: 'pcs', unitValue: 58_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-04', item: 'VIP Sofa (gold)', type: 'Fixed Asset', qty: 12, unit: 'unit', unitValue: 8_000_000, status: 'in_transit', projectId: 'EVT-2026-GALA-01', eventDate: '2026-08-14' },
  { id: 'IT-05', item: 'Truss 3m Segment', type: 'Fixed Asset', qty: 40, unit: 'unit', unitValue: 2_600_000, status: 'in_transit', projectId: 'EVT-2026-GALA-01', eventDate: '2026-08-14' },
  { id: 'IT-06', item: 'Moving Head Light', type: 'Fixed Asset', qty: 24, unit: 'unit', unitValue: 6_500_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-07', item: 'LED Panel 500x500', type: 'Fixed Asset', qty: 36, unit: 'unit', unitValue: 4_400_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-08', item: 'Line Array Speaker', type: 'Fixed Asset', qty: 16, unit: 'unit', unitValue: 4_100_000, status: 'in_stock', projectId: null, eventDate: null },
  { id: 'IT-09', item: 'Stage Deck 2x1m', type: 'Fixed Asset', qty: 60, unit: 'unit', unitValue: 1_000_000, status: 'in_stock', projectId: null, eventDate: null },
]

export const INVENTORY_STATUS = {
  in_stock: { label: 'In Stock', tone: 'ok' },
  in_transit: { label: 'In-Transit', tone: 'warn' },
  maintenance: { label: 'Maintenance', tone: 'warn' },
  written_off: { label: 'Written Off', tone: 'bad' },
}

// Condition options offered when a fixed asset is checked back in after an
// event, and where each one sends the item. Straight from the feedback deck
// (slide 9): Good -> Main Stock, Damaged -> Maintenance, Lost -> Write-off.
export const RETURN_CONDITIONS = [
  { key: 'good', label: 'Good / Intact', destination: 'in_stock', tone: 'ok', hint: 'Returns to main stock' },
  { key: 'damaged', label: 'Damaged / Repair', destination: 'maintenance', tone: 'warn', hint: 'Routed to maintenance' },
  { key: 'lost', label: 'Lost / Total Damage', destination: 'written_off', tone: 'bad', hint: 'Posts Asset Loss Expense' },
]

// Delivery Orders now carry line items and move Draft -> Dispatched -> Received,
// so the DO flow the deck asked for is a real lifecycle rather than a label.
export const seedDeliveryOrders = [
  {
    id: 'DO-2201', project: 'EVT-2026-GALA-01', status: 'Dispatched', signed: true,
    date: '2026-07-24', eventDate: '2026-08-14',
    lines: [
      { itemId: 'IT-04', item: 'VIP Sofa (gold)', qty: 12 },
      { itemId: 'IT-05', item: 'Truss 3m Segment', qty: 40 },
    ],
  },
  {
    id: 'DO-2202', project: 'EVT-2026-CONF-03', status: 'Draft', signed: false,
    date: '2026-07-25', eventDate: '2026-10-22',
    lines: [
      { itemId: 'IT-07', item: 'LED Panel 500x500', qty: 24 },
      { itemId: 'IT-08', item: 'Line Array Speaker', qty: 8 },
    ],
  },
]

export const seedCrew = [
  { id: 'CR-01', name: 'Agus P.', role: 'Field Lead', baseRate: 5_000_000, lastRating: 9.2 },
  { id: 'CR-02', name: 'Rina M.', role: 'Stage Manager', baseRate: 4_500_000, lastRating: 8.6 },
  { id: 'CR-03', name: 'Yoga K.', role: 'Rigging Tech', baseRate: 4_000_000, lastRating: 7.8 },
  { id: 'CR-04', name: 'Sela D.', role: 'Lighting Op', baseRate: 4_200_000, lastRating: 9.6 },
]

export const seedSales = [
  { id: 'SP-01', name: 'Dinda A.', closedWon: 3, contractTotal: 1_135_000_000, commissionPct: 2.5 },
  { id: 'SP-02', name: 'R. Hartono', closedWon: 1, contractTotal: 720_000_000, commissionPct: 2.0 },
  { id: 'SP-03', name: 'Fajar N.', closedWon: 2, contractTotal: 430_000_000, commissionPct: 2.5 },
]

// Threaded discussion + versioned assets for the project detail screen.
export const seedThreads = {
  'EVT-2026-GALA-01': [
    { by: 'Dinda A.', at: '2 days ago', text: 'Client confirmed the stage layout. @Bagus S. please dispatch the LED wall.' },
    { by: 'Bagus S.', at: '1 day ago', text: 'Noted. DO-2201 dispatched, truss + VIP sofas in transit.' },
    { by: 'Agus P.', at: '6 hours ago', text: 'On-site load-in complete. Rehearsal at 18:00.' },
  ],
}

export const seedAssets = {
  'EVT-2026-GALA-01': [
    { name: 'Stage_Layout_v3.pdf', version: 'v3', status: 'Approved', by: 'Design', at: '3 days ago' },
    { name: 'Lighting_Plot_v2.dwg', version: 'v2', status: 'Approved', by: 'Design', at: '4 days ago' },
    { name: '3D_Render_Main.png', version: 'v1', status: 'Approved', by: 'Design', at: '6 days ago' },
  ],
}

// ---- Accounting: double-entry journal ----
//
// Multi-line double-entry. The client's feedback deck (slide 5) drew a stacked
// journal entry with three lines — bank debit, PPh 23 withholding credit,
// revenue credit — which the old one-debit-one-credit-per-row shape could not
// represent. Account codes follow lib/accounts.js.
//
// The Income Statement and Balance Sheet are DERIVED from these entries (see
// lib/ledger.js), so this data is now load-bearing: every entry must balance,
// and the opening-balance entry is what makes Assets = Liabilities + Equity.
// Verified: assets Rp 1,258,640,000 = liabilities + equity.

const PPH23 = 0.02

// A client down payment, in TWO linked entries.
//
// Round 2 corrected the tax treatment here. The first version posted the whole
// DP as one entry — cash in at gross, PPh 23 credited to 2105 Payable, revenue
// recognised net. That is the shape for money Oscenia PAYS OUT while
// withholding on a vendor's behalf (see vendorPayment below), and it is wrong
// for money coming IN: the client is the one who withholds, so Oscenia receives
// net cash and holds a creditable ASSET, not a liability. Recognising revenue
// net also understated it by the tax.
//
// The corrected shape, which is what the client's proposal spells out:
//
//   1. Recognition   Dr 1201 AR (gross)     Cr 4101 Revenue (gross)
//   2. Receipt       Dr 1101 Cash (net)
//                    Dr 1401 Prepaid PPh 23 Cr 1201 AR (gross)
//
// Two entries rather than one because a receivable has to exist before it can
// be settled — which is also what gives the Applied Payment picker something to
// work with, and what puts a real document chain in the ledger.
function dpReceipt(recognitionId, receiptId, date, project, memo, gross, ref) {
  const tax = Math.round(gross * PPH23)
  const base = { date, project, appliedTo: [], reversalOf: null, reversedBy: null }
  return [
    {
      ...base,
      id: recognitionId,
      memo: `${memo} — invoiced`,
      source: { kind: 'invoice', ref },
      lines: [
        { account: '1201', debit: gross, credit: 0, note: 'Receivable raised on DP invoice' },
        { account: '4101', debit: 0, credit: gross, note: 'Quotation contract down payment' },
      ],
    },
    {
      ...base,
      id: receiptId,
      memo,
      source: { kind: 'payment', ref: recognitionId },
      appliedTo: [recognitionId],
      lines: [
        { account: '1101', debit: gross - tax, credit: 0, note: 'Net cash received from client' },
        { account: '1401', debit: tax, credit: 0, note: `PPh 23 withheld by client @ ${PPH23 * 100}%` },
        { account: '1201', debit: 0, credit: gross, note: 'Receivable cleared at gross' },
      ],
    },
  ]
}

// A vendor bill: the cost is incurred and the debt is recognised. Nothing has
// been paid yet, so this is what makes 2102 Vendor Payables a real balance
// rather than an account the purchase-order flow never touched.
function vendorBill(id, date, project, memo, gross, ref, due, vendor) {
  return {
    id, date, memo, project,
    // `due` and `vendor` ride on the source so the Payables screen can age a
    // bill without having to find a purchase order behind it — an overhead
    // invoice has no PO, and it is still a debt with a payment date.
    source: { kind: 'po', ref, due, vendor },
    lines: [
      { account: '5101', debit: gross, credit: 0, note: 'Vendor cost — event COGS' },
      { account: '2102', debit: 0, credit: gross, note: 'Vendor payable raised' },
    ],
    appliedTo: [],
    reversalOf: null,
    reversedBy: null,
  }
}

// Settling a vendor bill. Oscenia withholds PPh 23 on the vendor's behalf, so
// the payable clears at GROSS while cash leaves NET and the withheld tax stays
// as a liability to the tax office — the mirror image of a client receipt,
// where Oscenia is the one withheld FROM (see dpReceipt above).
//
// Round 2 split this from a single entry. It used to debit COGS straight
// against cash, which meant a purchase order never created a debt and there was
// nothing for "settlement confirmation" to confirm.
function vendorPayment(billId, payId, date, project, memo, gross, ref, portion) {
  const paid = portion == null ? gross : portion
  const tax = Math.round(paid * PPH23)
  return [
    vendorBill(billId, date, project, `${memo} — billed`, gross, ref, date, ref),
    {
      id: payId, date, memo, project,
      source: { kind: 'payment', ref: billId },
      appliedTo: [billId],
      lines: [
        { account: '2102', debit: paid, credit: 0, note: 'Vendor payable settled at gross' },
        { account: '2105', debit: 0, credit: tax, note: `PPh 23 withheld @ ${PPH23 * 100}%` },
        { account: '1101', debit: 0, credit: paid - tax, note: 'Net paid to vendor' },
      ],
      reversalOf: null,
      reversedBy: null,
    },
  ]
}

function simple(id, date, project, memo, lines, source, appliedTo = []) {
  return {
    id, date, memo, project,
    source: source || { kind: 'manual', ref: null },
    lines,
    // Inter-document linking: which earlier entry this one settles.
    appliedTo,
    reversalOf: null,
    reversedBy: null,
  }
}

export const seedJournal = [
  // Opening position at the start of the financial year.
  simple('JE-0001', '2026-01-01', null, 'Opening balances — FY2026', [
    { account: '1101', debit: 420_000_000, credit: 0, note: 'Bank opening balance' },
    { account: '1103', debit: 40_000_000, credit: 0, note: 'Petty cash float' },
    { account: '1301', debit: 28_200_000, credit: 0, note: 'Consumables on hand' },
    { account: '1302', debit: 640_000_000, credit: 0, note: 'Event equipment at cost' },
    { account: '3102', debit: 0, credit: 200_000_000, note: 'Paid-in capital' },
    { account: '3101', debit: 0, credit: 928_200_000, note: 'Retained earnings brought forward' },
  ], { kind: 'opening', ref: 'FY2026' }),

  // --- Client receipts ---
  dpReceipt('JE-1001', 'JE-1051', '2026-04-05', 'EVT-2026-PROD-04', 'DP received — Meridian Launch', 117_000_000, 'INV-0038'),
  dpReceipt('JE-1002', 'JE-1052', '2026-05-10', 'EVT-2026-GALA-01', 'DP received — Aurora Gala', 144_000_000, 'INV-0041'),
  dpReceipt('JE-1003', 'JE-1053', '2026-06-01', 'EVT-2026-CONF-03', 'DP received — TechNusa Conf', 216_000_000, 'INV-0039'),
  dpReceipt('JE-1004', 'JE-1054', '2026-06-20', 'EVT-2026-WED-02', 'DP received — Wibowo Wedding', 79_500_000, 'INV-0044'),

  // --- Invoiced revenue (open receivables) ---
  simple('JE-1005', '2026-06-30', 'EVT-2026-PROD-04', 'Final invoice — Meridian Launch', [
    { account: '1201', debit: 273_000_000, credit: 0, note: 'Receivable raised' },
    { account: '4102', debit: 0, credit: 273_000_000, note: 'Event revenue on delivery' },
  ], { kind: 'invoice', ref: 'INV-0040' }),
  simple('JE-1006', '2026-07-22', 'EVT-2026-GALA-01', 'Progress invoice — Aurora Gala', [
    { account: '1201', debit: 192_000_000, credit: 0, note: 'Receivable raised' },
    { account: '4102', debit: 0, credit: 192_000_000, note: 'Progress billing' },
  ], { kind: 'invoice', ref: 'INV-0042' }),

  // Collection of the Meridian final invoice. Without this the receivable
  // would sit open forever on a project that closed in June.
  //
  // The `appliedTo` link is what closes JE-1005 as a DOCUMENT, not merely as a
  // balance: the Applied Payment picker lists open items, and an unlinked
  // receipt would leave the paid invoice sitting there looking collectable.
  simple('JE-1023', '2026-07-14', 'EVT-2026-PROD-04', 'Final payment received \u2014 Meridian Launch', [
    { account: '1101', debit: 267_540_000, credit: 0, note: 'Net cash received from client' },
    { account: '1401', debit: 5_460_000, credit: 0, note: 'PPh 23 withheld by client @ 2%' },
    { account: '1201', debit: 0, credit: 273_000_000, note: 'Receivable cleared at gross' },
  ], { kind: 'payment', ref: 'JE-1005' }, ['JE-1005']),

  // --- Aurora Gala costs (realized 322,000,000) ---
  vendorPayment('JE-1007', 'JE-1057', '2026-06-18', 'EVT-2026-GALA-01', 'LED vendor payment (Lumina)', 42_000_000, 'V-01'),
  simple('JE-1008', '2026-06-28', 'EVT-2026-GALA-01', 'Consumables released to Gala', [
    { account: '5104', debit: 6_200_000, credit: 0, note: 'Consumables issued to site' },
    { account: '1301', debit: 0, credit: 6_200_000, note: 'Stock permanently reduced' },
  ], { kind: 'warehouse', ref: 'DO-2201' }),
  simple('JE-1009', '2026-07-05', 'EVT-2026-GALA-01', 'Field cash advance settled', [
    { account: '5103', debit: 8_500_000, credit: 0, note: 'Field logistics spend' },
    { account: '1103', debit: 0, credit: 8_500_000, note: 'Paid from petty cash' },
  ], { kind: 'pettycash', ref: 'PR-101' }),
  simple('JE-1010', '2026-07-06', 'EVT-2026-GALA-01', 'Petty cash — crew meals', [
    { account: '5102', debit: 3_200_000, credit: 0, note: 'Crew subsistence' },
    { account: '1103', debit: 0, credit: 3_200_000, note: 'Paid from petty cash' },
  ], { kind: 'pettycash', ref: 'PR-102' }),
  vendorPayment('JE-1011', 'JE-1061', '2026-07-10', 'EVT-2026-GALA-01', 'Staging & truss (StageWorks)', 96_000_000, 'V-03'),
  vendorPayment('JE-1012', 'JE-1062', '2026-07-12', 'EVT-2026-GALA-01', 'Sound & AV (SoundForge)', 74_000_000, 'V-02'),
  simple('JE-1013', '2026-07-18', 'EVT-2026-GALA-01', 'Crew payroll — Aurora Gala', [
    { account: '5102', debit: 52_600_000, credit: 0, note: 'Field crew payroll' },
    { account: '1101', debit: 0, credit: 52_600_000, note: 'Bank transfer' },
  ], { kind: 'payroll', ref: 'PAY-2607' }),
  simple('JE-1014', '2026-07-20', 'EVT-2026-GALA-01', 'Logistics & trucking — Aurora Gala', [
    { account: '5103', debit: 39_500_000, credit: 0, note: 'Trucking and load-in' },
    { account: '1101', debit: 0, credit: 39_500_000, note: 'Bank transfer' },
  ], { kind: 'po', ref: 'LOG-441' }),

  // --- TechNusa Conference costs (realized 88,000,000) ---
  vendorPayment('JE-1015', 'JE-1065', '2026-07-15', 'EVT-2026-CONF-03', 'Staging deposit (StageWorks)', 88_000_000, 'V-03'),

  // --- Wibowo Wedding costs (realized 61,000,000) ---
  vendorPayment('JE-1016', 'JE-1066', '2026-07-14', 'EVT-2026-WED-02', 'Decor & floral (Bloom & Co)', 29_000_000, 'V-04'),

  // Open vendor debt, so Accounts Payable has something real to age.
  //
  // PO-3003 is 'DP Paid', so the vendor has invoiced: the whole bill is
  // recognised and 40% has been settled, leaving 12,468,000 outstanding.
  // PO-3004 is merely 'Approved' — a commitment, not yet a debt — so it has no
  // bill here and does not appear in Accounts Payable.
  vendorBill('JE-1070', '2026-07-15', 'EVT-2026-CONF-03', 'Sound & AV package (SoundForge) — billed', 20_780_000, 'PO-3003', '2026-08-05', 'SoundForge Audio'),
  simple('JE-1071', '2026-07-16', 'EVT-2026-CONF-03', 'Vendor DP — PO-3003', [
    { account: '2102', debit: 8_312_000, credit: 0, note: 'Vendor payable settled at gross' },
    { account: '2105', debit: 0, credit: 166_240, note: 'PPh 23 withheld @ 2%' },
    { account: '1101', debit: 0, credit: 8_145_760, note: 'Net paid to vendor' },
  ], { kind: 'payment', ref: 'JE-1070' }, ['JE-1070']),

  // An overhead bill that has slipped: no purchase order behind it, 45 days
  // past its terms. Without something genuinely overdue the AP ageing buckets
  // would all read zero and the screen would prove nothing.
  simple('JE-1073', '2026-05-28', null, 'Office equipment servicing (Meridian Tech)', [
    { account: '6101', debit: 18_500_000, credit: 0, note: 'Annual servicing contract' },
    { account: '2102', debit: 0, credit: 18_500_000, note: 'Vendor payable raised' },
  ], { kind: 'po', ref: 'BILL-0012', due: '2026-06-11', vendor: 'Meridian Tech' }),
  simple('JE-1017', '2026-07-16', 'EVT-2026-WED-02', 'Crew & logistics — Wibowo', [
    { account: '5102', debit: 18_000_000, credit: 0, note: 'Crew payroll' },
    { account: '5103', debit: 14_000_000, credit: 0, note: 'Transport and setup' },
    { account: '1101', debit: 0, credit: 32_000_000, note: 'Bank transfer' },
  ], { kind: 'payroll', ref: 'PAY-2606' }),

  // --- Meridian Launch costs (realized 268,000,000) ---
  vendorPayment('JE-1018', 'JE-1068', '2026-06-10', 'EVT-2026-PROD-04', 'Vendor package — Meridian Launch', 168_000_000, 'V-01'),
  simple('JE-1019', '2026-06-25', 'EVT-2026-PROD-04', 'Logistics & consumables — Meridian', [
    { account: '5103', debit: 26_200_000, credit: 0, note: 'Trucking and rigging' },
    { account: '5104', debit: 15_800_000, credit: 0, note: 'Consumables purchased' },
    { account: '1101', debit: 0, credit: 42_000_000, note: 'Bank transfer' },
  ], { kind: 'po', ref: 'LOG-402' }),
  simple('JE-1020', '2026-07-02', 'EVT-2026-PROD-04', 'Crew payroll — Meridian', [
    { account: '5102', debit: 58_000_000, credit: 0, note: 'Field crew payroll' },
    { account: '1101', debit: 0, credit: 58_000_000, note: 'Bank transfer' },
  ], { kind: 'payroll', ref: 'PAY-2605' }),

  // --- Overheads (not project-tagged) ---
  simple('JE-1021', '2026-06-30', null, 'Office overhead — H1', [
    { account: '6101', debit: 74_000_000, credit: 0, note: 'Rent, utilities, admin' },
    { account: '1101', debit: 0, credit: 74_000_000, note: 'Bank transfer' },
  ], { kind: 'manual', ref: 'OH-H1' }),
  simple('JE-1022', '2026-06-30', null, 'Salaries (non-event) — H1', [
    { account: '6102', debit: 88_000_000, credit: 0, note: 'Office payroll' },
    { account: '1101', debit: 0, credit: 88_000_000, note: 'Bank transfer' },
  ], { kind: 'payroll', ref: 'PAY-OFFICE-H1' }),
// dpReceipt() returns a linked PAIR of entries, so the list is flattened.
].flat()

// ---- Fixed-asset register (round 2) ----------------------------------------
//
// Seeded to reconcile with ledger account 1302, which opens the year at
// 640,000,000: every row here is one of the warehouse's fixed-asset lines
// valued at qty x unitValue, and the six of them add up to exactly that.
//
// They are all acquired on 2026-01-01 — the date of the opening balance — with
// NOTHING posted yet. That is deliberate: the client's complaint is "the risk
// of missing monthly fixed asset depreciation bookkeeping", so the register
// opens showing seven months of unrecorded depreciation in red. The feature
// then clears it in one action, which demonstrates the problem before the fix.
export const seedFixedAssets = [
  {
    id: 'FA-001', name: 'VIP Sofa (gold)', category: 'Furniture', inventoryId: 'IT-04',
    acquiredOn: '2026-01-01', cost: 96_000_000, salvage: 9_600_000,
    usefulLifeMonths: 60, method: 'straight-line', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
  {
    id: 'FA-002', name: 'Truss 3m Segment', category: 'Staging', inventoryId: 'IT-05',
    acquiredOn: '2026-01-01', cost: 104_000_000, salvage: 10_400_000,
    usefulLifeMonths: 96, method: 'straight-line', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
  {
    id: 'FA-003', name: 'Moving Head Light', category: 'Lighting', inventoryId: 'IT-06',
    acquiredOn: '2026-01-01', cost: 156_000_000, salvage: 15_600_000,
    usefulLifeMonths: 48, method: 'declining', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
  {
    id: 'FA-004', name: 'LED Panel 500x500', category: 'Video', inventoryId: 'IT-07',
    acquiredOn: '2026-01-01', cost: 158_400_000, salvage: 15_840_000,
    usefulLifeMonths: 48, method: 'straight-line', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
  {
    id: 'FA-005', name: 'Line Array Speaker', category: 'Audio', inventoryId: 'IT-08',
    acquiredOn: '2026-01-01', cost: 65_600_000, salvage: 6_560_000,
    usefulLifeMonths: 60, method: 'straight-line', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
  {
    id: 'FA-006', name: 'Stage Deck 2x1m', category: 'Staging', inventoryId: 'IT-09',
    acquiredOn: '2026-01-01', cost: 60_000_000, salvage: 6_000_000,
    usefulLifeMonths: 120, method: 'straight-line', status: 'active', postedThrough: null, postedAccumulated: 0,
  },
]

// ---- Voucher numbering -----------------------------------------------------
//
// Seed entries carry voucher numbers too, otherwise the column the client asked
// for would be empty on every record they already recognise. Numbers are
// assigned oldest-first so the sequences ascend with the date, and the counters
// that result become the store's opening counter state — so the first entry a
// user posts continues the run instead of restarting at 001.

export const seedVoucherSeries = SEED_VOUCHER_SERIES

export const seedVoucherCounters = {}

{
  const seriesByKey = Object.fromEntries(seedVoucherSeries.map((x) => [x.key, x]))
  const chronological = [...seedJournal].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  chronological.forEach((entry) => {
    const key = pickSeries(entry, { accountOf: account, cashAccounts: CASH_ACCOUNTS })
    const series = seriesByKey[key]
    const ck = counterKey(series, entry.date)
    const seq = (seedVoucherCounters[ck] || 0) + 1
    seedVoucherCounters[ck] = seq
    // Mutating the entry in place: `chronological` holds the same objects as
    // seedJournal, so this stamps the exported array.
    entry.series = key
    entry.voucherNo = formatVoucher(series, entry.date, seq)
  })
}

// Tax configuration. Editable from the Accounting screen — the deck asked for
// "fully customizable withholding/collected tax rates & manual override options
// prior to displaying Tax Expense & Net Profit".
export const seedTaxConfig = {
  pph23: { label: 'PPh 23 — Service withholding', rate: 2, active: true, account: '2105' },
  pph21: { label: 'PPh 21 — Employee withholding', rate: 5, active: false, account: '2107' },
  ppn: { label: 'PPN — Value Added Tax', rate: 11, active: false, account: '2106' },
  corporate: { label: 'Corporate Income Tax', rate: 22, active: true, account: null },
}

// ---- Budgeting: category ceilings vs realized (slides 7 & 10) ----
export const seedBudget = {
  project: 'EVT-2026-GALA-01',
  categories: [
    { key: 'vendors', label: 'Vendors', ceiling: 150_000_000, realized: 138_000_000 },
    { key: 'crew', label: 'Crew Payroll', ceiling: 80_000_000, realized: 71_000_000 },
    { key: 'logistics', label: 'Logistics', ceiling: 55_000_000, realized: 49_000_000 },
    { key: 'consumables', label: 'Consumables', ceiling: 25_000_000, realized: 18_000_000 },
    { key: 'contingency', label: 'Contingency', ceiling: 30_000_000, realized: 12_000_000 },
  ],
}

// ---- Quotations / MoU (slide 14 — Sales creates quotations & contracts) ----
// A quote flows Draft -> Sent -> Accepted. On acceptance it generates an MoU
// and becomes the pending deal that Finance confirms (Automation #1).
export const seedQuotations = [
  {
    id: 'QT-1001', template: 'corporate', client: 'Aurora Bank', eventType: 'Investor Summit', eventDate: '2026-11-18',
    status: 'Accepted', createdBy: 'Dinda A.', projectId: 'EVT-2026-GALA-02',
    dpPercent: 30,
    lineItems: [
      { label: 'Venue & Staging', amount: 210_000_000, estCost: 147_000_000 },
      { label: 'AV & LED (vendors)', amount: 185_000_000, estCost: 130_000_000 },
      { label: 'Crew & Production', amount: 120_000_000, estCost: 84_000_000 },
      { label: 'Decor & Branding', amount: 95_000_000, estCost: 66_000_000 },
    ],
  },
  {
    id: 'QT-1002', template: 'corporate', client: 'Nimbus Retail', eventType: 'Store Launch', eventDate: '2026-12-06',
    status: 'Sent', createdBy: 'Fajar N.', projectId: 'EVT-2026-NIMB-01',
    dpPercent: 40,
    lineItems: [
      { label: 'Venue & Staging', amount: 140_000_000, estCost: 98_000_000 },
      { label: 'AV & Sound', amount: 96_000_000, estCost: 67_000_000 },
      { label: 'Crew & Production', amount: 78_000_000, estCost: 55_000_000 },
    ],
  },
  {
    id: 'QT-1003', template: 'wedding', client: 'Nadia & Reza', eventType: 'Wedding', eventDate: '2027-01-24',
    status: 'Draft', createdBy: 'Dinda A.', projectId: 'EVT-2027-WED-05',
    dpPercent: 25,
    lineItems: [
      { label: 'Venue & Decor', amount: 165_000_000, estCost: 115_000_000 },
      { label: 'Catering coordination', amount: 88_000_000, estCost: 62_000_000 },
      { label: 'Crew & Production', amount: 57_000_000, estCost: 40_000_000 },
    ],
  },
]

// Proposal / MoU templates. The deck asked for the "ability to switch
// proposal/MoU templates based on request" — different clauses and payment
// language for corporate work, weddings and government tenders.
export const seedMouTemplates = [
  {
    id: 'corporate',
    label: 'Corporate',
    heading: 'MEMORANDUM OF UNDERSTANDING',
    validity: 'Quotation valid for 30 days from issue.',
    clauses: [
      'Scope covers production, crew and vendor coordination as itemised above.',
      'Down payment is due on signing; the balance falls due 14 days post-event.',
      'Postponement inside 14 days of the event date is charged at 50% of contract value.',
      'PPh 23 withholding is deducted at source in accordance with prevailing regulation.',
    ],
    signatory: 'Authorised Signatory',
  },
  {
    id: 'wedding',
    label: 'Wedding',
    heading: 'EVENT AGREEMENT',
    validity: 'Quotation valid for 14 days from issue.',
    clauses: [
      'Scope covers decor, floral, staging and coordination as itemised above.',
      'Down payment secures the date and is non-refundable once vendors are booked.',
      'Final headcount and layout to be confirmed 21 days before the event.',
      'Rescheduling is permitted once, subject to venue and vendor availability.',
    ],
    signatory: 'Client / Family Representative',
  },
  {
    id: 'government',
    label: 'Government / Tender',
    heading: 'CONTRACT AGREEMENT',
    validity: 'Quotation valid for 60 days from issue.',
    clauses: [
      'Scope and specification per the tender document referenced above.',
      'Payment terms follow the issuing agency’s standard disbursement schedule.',
      'All equipment carries valid safety certification, available on request.',
      'PPh 23 and PPN are applied per prevailing regulation; NPWP on file.',
      'Progress reporting supplied at each production milestone.',
    ],
    signatory: 'Authorised Officer',
  },
]

export const DEFAULT_TEMPLATE = 'corporate'

// Resolve a template id against a list, falling back to the default and then to
// whatever exists. A quotation must always render with *some* template, even if
// the one it referenced has since been deleted.
export function resolveTemplate(templates, id) {
  const list = templates || []
  return list.find((t) => t.id === id)
    || list.find((t) => t.id === DEFAULT_TEMPLATE)
    || list[0]
    || null
}

// ---- CRM: per-client interaction history (slide 4) ----
// Interaction log + past-event records (vendors used + satisfaction per event).
export const clientHistory = {
  'CL-01': {
    interactions: [
      { date: '2026-07-20', type: 'Meeting', by: 'Dinda A.', note: 'Scoped Investor Summit — 600 pax, Nov 2026.' },
      { date: '2026-07-05', type: 'Quote sent', by: 'Dinda A.', note: 'Proposal Rp 610M sent for review.' },
      { date: '2026-05-14', type: 'Event closed', by: 'System', note: 'Annual Gala delivered · rated 4.8/5.' },
      { date: '2026-03-01', type: 'Anniversary', by: 'Cron', note: 'Company anniversary greeting sent (WhatsApp).' },
    ],
    events: [
      { name: 'Investor Day', date: '2025-09', value: 360_000_000, vendors: ['Lumina LED', 'BrightRig'], satisfaction: 4.6 },
      { name: 'Town Hall', date: '2024-11', value: 220_000_000, vendors: ['SoundForge'], satisfaction: 4.4 },
    ],
  },
  'CL-02': {
    interactions: [
      { date: '2026-07-10', type: 'Call', by: 'R. Hartono', note: 'Confirmed stage + streaming scope for Dev Conf.' },
      { date: '2026-06-01', type: 'Event closed', by: 'System', note: 'Down payment received — project EVT-2026-CONF-03 created.' },
      { date: '2025-10-22', type: 'Event closed', by: 'System', note: 'Developer Conference 2025 delivered · rated 4.5/5.' },
    ],
    events: [
      { name: 'Developer Conference', date: '2025-10', value: 640_000_000, vendors: ['SoundForge', 'StageWorks', 'BrightRig'], satisfaction: 4.5 },
      { name: 'Product Launch', date: '2024-08', value: 340_000_000, vendors: ['Lumina LED', 'SoundForge'], satisfaction: 4.3 },
    ],
  },
  'CL-03': {
    interactions: [
      { date: '2026-06-30', type: 'Event closed', by: 'System', note: 'Product Launch delivered · final invoice paid.' },
      { date: '2026-06-12', type: 'Meeting', by: 'Dinda A.', note: 'Reviewed booth + lighting concept.' },
    ],
    events: [
      { name: 'Press Preview', date: '2025-05', value: 150_000_000, vendors: ['Bloom & Co'], satisfaction: 4.0 },
    ],
  },
  'CL-04': {
    interactions: [
      { date: '2026-07-02', type: 'Meeting', by: 'Dinda A.', note: 'Wedding décor + floral direction agreed.' },
      { date: '2026-06-20', type: 'Quote sent', by: 'Dinda A.', note: 'Down payment invoiced — Rp 79.5M.' },
    ],
    events: [],
  },
}

// ---- Cron jobs (slide 4) ----
export const seedCronJobs = [
  { id: 'CJ-1', name: 'Daily birthday & milestone scan', schedule: 'Every day · 07:00', lastRun: 'Today 07:00', status: 'Active' },
  { id: 'CJ-2', name: 'Overdue invoice sweep (AR)', schedule: 'Every day · 08:00', lastRun: 'Today 08:00', status: 'Active' },
  { id: 'CJ-3', name: 'Weekly LTV recompute', schedule: 'Mondays · 06:00', lastRun: '2 days ago', status: 'Active' },
  { id: 'CJ-4', name: 'In-transit asset return check', schedule: 'Every day · 20:00', lastRun: 'Yesterday 20:00', status: 'Active' },
  // The client's "the system periodically generates draft journal entries for
  // upcoming periods" — the register schedules them, and this is the run that
  // posts whatever has fallen due.
  { id: 'CJ-5', name: 'Month-end depreciation run', schedule: 'Last day of month · 23:00', lastRun: 'Not yet run', status: 'Active' },
]
