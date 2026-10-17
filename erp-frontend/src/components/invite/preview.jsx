// The phone / desktop switch and the framed, scrolling preview the editor and the gallery share.
import { Monitor, Smartphone } from 'lucide-react'
import { useT } from '../../i18n'

export function DeviceToggle({ device, setDevice }) {
  const t = useT()
  const btn = (key, Icon, label) => (
    <button onClick={() => setDevice(key)} className={`rounded-md p-1.5 ${device === key ? 'bg-gold/20 text-gold-light' : 'text-white/50'}`} aria-label={t(label)} aria-pressed={device === key}>
      <Icon size={15} />
    </button>
  )
  return <div className="flex rounded-lg border border-white/10 p-0.5">{btn('desktop', Monitor, 'Desktop')}{btn('phone', Smartphone, 'Phone')}</div>
}

export function PreviewFrame({ device, children, tall = 'max-h-[calc(100vh-14rem)]' }) {
  return (
    <div className={`mx-auto overflow-hidden rounded-2xl border border-white/10 shadow-2xl ${device === 'phone' ? 'max-w-[390px]' : ''}`}>
      <div className={`${tall} overflow-y-auto`}>{children}</div>
    </div>
  )
}
