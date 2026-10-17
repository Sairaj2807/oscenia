import { create } from 'zustand'
import { api } from '../lib/api'
import { useStore } from './useStore'
import { adaptCampaign, adaptCampaignDetail } from '../lib/campaignsApi'

// Signed in, the contact list across events and the campaigns made from it live on the server. This store
// holds what was read and does the writes; `GuestContacts` chooses between it and the demo's simulated
// copy by whether anyone is signed in.
//
// Writes go through `useStore.mutate`, so a refusal shows the server's own words ("Nobody would receive
// this campaign: ..."), and nothing on screen changes that was not saved.

export const useCampaigns = create((set, get) => ({
  contacts: [],
  contactsLoaded: false,
  campaigns: [],
  campaignsLoaded: false,
  /** The campaign being looked at, with its recipients. */
  open: null,

  loadContacts: async () => {
    try {
      const rows = await api.get('/crm/contacts')
      set({ contacts: rows, contactsLoaded: true })
    } catch {
      set({ contacts: [], contactsLoaded: true })
    }
  },

  loadCampaigns: async () => {
    try {
      const rows = await api.get('/crm/campaigns')
      set({ campaigns: rows.map(adaptCampaign), campaignsLoaded: true })
    } catch {
      set({ campaigns: [], campaignsLoaded: true })
    }
  },

  openCampaign: async (id) => {
    try {
      set({ open: adaptCampaignDetail(await api.get(`/crm/campaigns/${id}`)) })
    } catch {
      set({ open: null })
    }
  },
  closeCampaign: () => set({ open: null }),

  /** Make a campaign. The server works out the audience from the keys alone. Resolves the campaign or null. */
  create: async ({ name, channel, message, keys }) => {
    let made = null
    const result = await useStore.getState().mutate({
      label: 'campaign:new',
      call: async () => {
        made = adaptCampaignDetail(await api.post('/crm/campaigns', { name, channel, message, keys }))
        return made
      },
      refresh: [],
      toast: { title: 'Campaign prepared', body: name, kind: 'cron' },
    })
    if (!result?.ok) return null
    set({ open: made })
    await get().loadCampaigns()
    return made
  },

  markSent: async (campaignId, recipientId) => {
    const result = await useStore.getState().mutate({
      label: `campaign:${campaignId}:${recipientId}`,
      call: () => api.post(`/crm/campaigns/${campaignId}/recipients/${recipientId}/mark-sent`),
      refresh: [],
      toast: null,
    })
    if (result?.ok) await Promise.all([get().openCampaign(campaignId), get().loadCampaigns()])
    return result
  },

  markAllSent: async (campaignId) => {
    const result = await useStore.getState().mutate({
      label: `campaign:${campaignId}:all`,
      call: () => api.post(`/crm/campaigns/${campaignId}/mark-sent`),
      refresh: [],
      toast: { title: 'Marked as reached', body: 'everyone still to be reached', kind: 'cron' },
    })
    if (result?.ok) await Promise.all([get().openCampaign(campaignId), get().loadCampaigns()])
    return result
  },

  unsubscribe: async (key, name) => {
    const result = await useStore.getState().mutate({
      label: `contact:unsubscribe:${key}`,
      call: () => api.post('/crm/contacts/unsubscribe', { key }),
      refresh: [],
      toast: { title: 'Unsubscribed', body: name, kind: 'cron' },
    })
    if (result?.ok) await Promise.all([get().loadContacts(), get().loadCampaigns()])
    return result
  },
}))
