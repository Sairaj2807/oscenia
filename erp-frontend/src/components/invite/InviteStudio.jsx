// The invitation workspace (Invitations v2), shared by Oscenia staff (Event → Invitation) and
// the client's private link (clientMode): the template gallery until a template is chosen —
// or while changing it — and the editor otherwise.
import { useState } from 'react'
import TemplateGallery from './TemplateGallery'
import InviteEditor from './InviteEditor'
import { useProto } from '../../store/chatProto'
import { useStore } from '../../store/useStore'
import { useT } from '../../i18n'

export default function InviteStudio({ event, clientMode = false }) {
  const t = useT()
  const [picking, setPicking] = useState(false)
  const current = event.invite.templateId

  const use = async (templateId) => {
    if ((await useProto.getState().chooseTemplate(event.id, templateId)) === false) return
    setPicking(false)
    if (current && current !== templateId) {
      useStore.getState().pushToast({ title: t('Template changed'), body: t('Your words, photos and video came with it.'), kind: 'project' })
    }
  }

  if (!current || picking) {
    return <TemplateGallery current={current} onUse={use} onBack={current ? () => setPicking(false) : null} />
  }
  return <InviteEditor event={event} clientMode={clientMode} onChangeTemplate={() => setPicking(true)} />
}
