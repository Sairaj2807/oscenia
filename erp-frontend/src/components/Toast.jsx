import { CheckCircle2, GitBranch, Wallet, Bell, Star, BadgeDollarSign, AlertTriangle, Clock } from 'lucide-react'
import { useStore } from '../store/useStore'

const ICONS = {
  project: CheckCircle2,
  pipeline: GitBranch,
  finance: Wallet,
  feedback: Star,
  payroll: BadgeDollarSign,
  redflag: AlertTriangle,
  cron: Clock,
  default: Bell,
}

export default function ToastHost() {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)

  return (
    <div className="fixed bottom-4 right-4 left-4 sm:left-auto z-50 flex flex-col gap-2 sm:w-96">
      {toasts.map((t) => {
        const Icon = ICONS[t.kind] || ICONS.default
        const alarm = t.kind === 'redflag'
        return (
          <div
            key={t.id}
            onClick={() => dismiss(t.id)}
            className={`card cursor-pointer animate-pop p-4 flex items-start gap-3 ${
              alarm ? 'border-rose-500/50' : 'border-gold/30'
            }`}
          >
            <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg ${
              alarm ? 'bg-rose-500/15 text-rose-300' : 'bg-gold/15 text-gold-light'
            }`}>
              <Icon size={18} />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium text-white flex items-center gap-2">
                {t.title}
                <span className={`text-[9px] uppercase tracking-wider border rounded px-1.5 py-0.5 ${
                  alarm ? 'text-rose-300 border-rose-500/40' : 'text-gold/70 border-gold/30'
                }`}>
                  auto
                </span>
              </div>
              <div className="text-xs text-white/60 mt-0.5 truncate">{t.body}</div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
