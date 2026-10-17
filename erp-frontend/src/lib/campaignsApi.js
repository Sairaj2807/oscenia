// Marketing campaigns from the server (`/crm/contacts`, `/crm/campaigns`), in the shapes the CRM screens draw.
//
// Nothing is sent from the system. A campaign is a record: who was meant to be reached, with what, and who
// has been. Each recipient carries a link that opens the message ready in WhatsApp or the mail app; a person
// sends it, then marks it done. The offline demo keeps its simulated campaigns in the proto store.

import { request } from './api.js'

const STATUS_LABEL = { pending: 'To reach', sent: 'Reached', unsubscribed: 'Unsubscribed', erased: 'Erased' }
export const recipientStatusLabel = (status) => STATUS_LABEL[status] || status

/** A campaign list row. */
export function adaptCampaign(row) {
  return {
    id: row.id,
    no: row.campaignNo,
    name: row.name,
    channel: row.channel,
    message: row.message || '',
    at: row.createdAt,
    by: row.createdBy || null,
    requested: row.requestedCount ?? 0,
    skipped: row.skippedCount ?? 0,
    unreachable: row.unreachableCount ?? 0,
    count: row.recipientCount ?? 0,
    sent: row.sentCount ?? 0,
  }
}

/** A campaign with its recipients. */
export function adaptCampaignDetail(row) {
  return {
    ...adaptCampaign(row),
    recipients: (row.recipients || []).map((r) => ({
      id: r.id,
      position: r.position,
      name: r.name || '',
      phone: r.phone || '',
      email: r.email || '',
      consentAt: r.consentAt || null,
      consentSource: r.consentSource || null,
      sentAt: r.sentAt || null,
      unsubscribedAt: r.unsubscribedAt || null,
      erased: Boolean(r.erased),
      status: r.status,
      link: r.link || null,
    })),
  }
}

/** The summary line under a campaign: how many, and how many were left out and why. */
export function campaignSummary(c) {
  const parts = [`${c.count} recipients`]
  if (c.sent) parts.push(`${c.sent} reached`)
  if (c.skipped) parts.push(`${c.skipped} skipped (no consent)`)
  if (c.unreachable) parts.push(`${c.unreachable} no ${c.channel === 'email' ? 'email' : 'phone'}`)
  return parts.join(' · ')
}

/** Download a campaign's recipient list: fetched with the token, then handed to the browser as a file. */
export async function downloadCampaignCsv(campaign) {
  const response = await request(`/crm/campaigns/${campaign.id}/export`, { raw: true })
  const blob = await response.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${campaign.no}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}
