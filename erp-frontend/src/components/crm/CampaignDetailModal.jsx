import { Download, MessageCircle, Mail, Check } from 'lucide-react'
import Modal from '../Modal'
import { Badge } from '../ui'
import { useCampaigns } from '../../store/useCampaigns'
import { useStore } from '../../store/useStore'
import { canDo } from '../../lib/roles'
import { campaignSummary, downloadCampaignCsv, recipientStatusLabel } from '../../lib/campaignsApi'
import { shortDate } from '../workspace/parts'
import { useT } from '../../i18n'

// A campaign made on the server: who it was meant to reach, and who has been reached.
//
// Nothing is sent from here. Each person to be reached has a link that opens the message ready in WhatsApp
// or the mail app; you send it, then mark it done. Somebody who unsubscribed since, or whose guest record
// was erased, is shown as that and has no link: they are not to be messaged.

export default function CampaignDetailModal() {
  const t = useT()
  const campaign = useCampaigns((s) => s.open)
  const { closeCampaign, markSent, markAllSent } = useCampaigns.getState()
  const role = useStore((s) => s.role)
  if (!campaign) return null
  const may = canDo(role, 'manage_campaigns')
  const pending = campaign.recipients.filter((r) => r.status === 'pending').length

  return (
    <Modal
      title={`${campaign.no} · ${campaign.name}`}
      subtitle={`${campaign.channel === 'email' ? t('Email') : 'WhatsApp'} · ${campaignSummary(campaign)}`}
      onClose={closeCampaign}
      footer={
        <>
          <button className="btn-ghost" onClick={() => downloadCampaignCsv(campaign)}><Download size={14} /> {t('Download CSV')}</button>
          {may && pending > 0 && <button className="btn-ghost" onClick={() => markAllSent(campaign.id)}><Check size={14} /> {t('Mark all reached')}</button>}
          <button className="btn-gold" onClick={closeCampaign}>{t('Close')}</button>
        </>
      }
    >
      {campaign.message && (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] p-2.5 text-xs text-white/65 whitespace-pre-wrap">{campaign.message}</div>
      )}
      <p className="text-[11px] text-white/40">
        {t('Nothing is sent from here. Open the link for each person, send the message yourself, then mark them reached.')}
      </p>
      <div className="space-y-1.5">
        {campaign.recipients.map((r) => (
          <div key={r.id} data-testid="campaign-recipient" className="flex flex-wrap items-center gap-2 rounded-lg border border-white/5 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="text-sm text-white/85">{r.erased ? <span className="text-white/35">{t('Erased')}</span> : r.name}</div>
              <div className="text-[11px] text-white/40">
                {[r.phone, r.email].filter(Boolean).join(' · ')}
                {r.consentAt ? ` · ${t('agreed')} ${shortDate(r.consentAt.slice(0, 10))}${r.consentSource ? ` (${r.consentSource})` : ''}` : ''}
              </div>
            </div>
            <Badge>{t(recipientStatusLabel(r.status))}</Badge>
            {r.status === 'pending' && r.link && (
              <a href={r.link} target="_blank" rel="noopener noreferrer" className="btn-ghost !py-1 text-xs">
                {campaign.channel === 'email' ? <Mail size={13} /> : <MessageCircle size={13} />}
                {campaign.channel === 'email' ? t('Open email') : t('Open WhatsApp')}
              </a>
            )}
            {may && r.status === 'pending' && (
              <button className="btn-gold !py-1 text-xs" onClick={() => markSent(campaign.id, r.id)}>
                <Check size={13} /> {t('Mark reached')}
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  )
}
