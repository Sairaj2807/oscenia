// Shared presentational primitives for the ERP prototype.
import { Lock } from 'lucide-react'
import { useT } from '../i18n'
import { canDo, denialReason } from '../lib/roles'
import { useStore } from '../store/useStore'

// Formatting lives in lib/format.js now (money, money2, pct2, day counters).
// Re-exported from here so existing `import { money } from '../components/ui'`
// call sites keep working.
export { money, money2, num2, pct2, dayCounter, daysUntil, daysSince, formatDate, projectMargin, DEMO_TODAY, todayFor, appToday } from '../lib/format'

export function PageHeader({ eyebrow, title, subtitle, actions, translate = true }) {
  const t = useT()
  const tr = (s) => (translate ? t(s) : s)
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between mb-6">
      <div>
        {eyebrow && <div className="eyebrow mb-2">{tr(eyebrow)}</div>}
        <h1 className="font-display text-2xl sm:text-3xl text-white">{tr(title)}</h1>
        {subtitle && <p className="mt-1 text-sm text-white/50 max-w-2xl">{tr(subtitle)}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

export function Card({ children, className = '' }) {
  return <div className={`card p-5 ${className}`}>{children}</div>
}

export function StatCard({ label, value, delta, hint, flash }) {
  const t = useT()
  return (
    <div className={`card p-5 ${flash ? 'animate-flash' : ''}`}>
      <div className="text-[11px] uppercase tracking-wider text-white/40">{t(label)}</div>
      <div className="mt-2 font-display text-2xl sm:text-[26px] text-white tabular-nums">{value}</div>
      {(delta || hint) && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          {delta != null && (
            <span className={delta >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {delta >= 0 ? '▲' : '▼'} {Math.abs(delta)}%
            </span>
          )}
          {hint && <span className="text-white/40">{t(hint)}</span>}
        </div>
      )}
    </div>
  )
}

const STATUS_STYLES = {
  Paid: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Unpaid: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Draft: 'bg-white/10 text-white/60 border-white/20',
  Dispatched: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  Preparing: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Consumable: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'Fixed Asset': 'bg-gold/15 text-gold-light border-gold/30',
  Finished: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Available: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'Low Stock': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Booked: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Sent: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  Accepted: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Declined: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  // Procurement flow (the deck redefined this as 5 stages, not 4)
  Disbursed: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  Completed: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Rejected: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  // Warehouse item status
  'In Stock': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'In-Transit': 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  Maintenance: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'Written Off': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  // Delivery order lifecycle
  Received: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Reversed: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Adjustment: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  // Workspace task flow (two-stage approval: Division Leader, then PM)
  'To do': 'bg-white/10 text-white/60 border-white/20',
  'In progress': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  Blocked: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Submitted: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  'Leader approved': 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'PM approved': 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Overdue: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  // Events: RSVP and attendance
  Published: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  Attending: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  'No response': 'bg-white/10 text-white/60 border-white/20',
  'Checked in': 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'Walk-in': 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  'No-show': 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  Consented: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
}

export function Badge({ children }) {
  const t = useT()
  const cls = STATUS_STYLES[children] || 'bg-white/10 text-white/70 border-white/20'
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${cls}`}>
      {t(children)}
    </span>
  )
}

// Responsive table wrapper: horizontal scroll on small screens.
export function TableWrap({ children }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px]">{children}</table>
      </div>
    </div>
  )
}

export function Rating({ value, max = 5 }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className="text-gold-light">★</span>
      <span className="tabular-nums">{value.toFixed(1)}</span>
      <span className="text-white/30 text-xs">/ {max}</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Form + layout primitives used by the screens added for the feedback pass.
// ---------------------------------------------------------------------------

export function Field({ label, children, hint }) {
  const t = useT()
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1">{t(label)}</div>
      {children}
      {hint && <div className="text-[10px] text-white/30 mt-1">{hint}</div>}
    </div>
  )
}

const INPUT = 'w-full rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm text-white/85 focus:border-gold/50 outline-none'

export function TextInput({ className = '', ...props }) {
  return <input {...props} className={`${INPUT} ${className}`} />
}

export function NumberInput({ className = '', ...props }) {
  return <input type="number" {...props} className={`${INPUT} text-right tabular-nums ${className}`} />
}

export function Select({ className = '', children, ...props }) {
  return (
    <select {...props} className={`${INPUT} ${className}`}>
      {children}
    </select>
  )
}

export function SectionTitle({ icon: Icon, children, actions }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3 mt-6 first:mt-0">
      {Icon && <Icon size={16} className="text-gold/70" />}
      <h2 className="text-sm uppercase tracking-wider text-white/50">{children}</h2>
      {actions && <div className="ml-auto flex flex-wrap gap-2">{actions}</div>}
    </div>
  )
}

// Underlined tab strip. `tabs` = [{ key, label, count? }]; labels are translated.
export function Tabs({ tabs, active, onChange, className = '' }) {
  const t = useT()
  return (
    <div role="tablist" className={`flex gap-1 overflow-x-auto border-b border-white/10 mb-5 ${className}`}>
      {tabs.map((tab) => {
        const on = tab.key === active
        return (
          <button
            key={tab.key}
            role="tab"
            aria-selected={on}
            onClick={() => onChange(tab.key)}
            className={`-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm transition-colors ${
              on ? 'border-gold text-gold-light' : 'border-transparent text-white/50 hover:text-white'
            }`}
          >
            {t(tab.label)}
            {tab.count != null && (
              <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${on ? 'bg-gold/20 text-gold-light' : 'bg-white/10 text-white/50'}`}>
                {tab.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

export function FilterPill({ active, onClick, children }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full px-3 py-1 text-xs transition-colors ${
        active
          ? 'bg-gold/20 text-gold-light border border-gold/40'
          : 'border border-white/15 text-white/60 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

// Reads as a positive number in the account's natural direction; negatives are
// shown in parentheses the way a statement does.
export function Signed({ value, format }) {
  const fmt = format || ((v) => v)
  return (
    <span className={value < 0 ? 'text-rose-300' : 'text-white/80'}>
      {value < 0 ? `(${fmt(-value)})` : fmt(value)}
    </span>
  )
}

// A button that respects action-level permissions. When the role cannot perform
// the action it renders disabled with a tooltip naming who can — more useful
// than silently hiding the control, and it makes the PM restriction from
// slide 8 visible rather than mysterious.
export function ActionButton({ action, role, onClick, children, className = 'btn-gold', title, ...rest }) {
  const allowed = !action || canDo(role, action)
  const reason = allowed ? title : denialReason(role, action)
  const pushToast = useStore((s) => s.pushToast)

  // A refused action has to *say so*.
  //
  // This used to render `disabled` with the reason in a `title`. Native tooltips do not
  // appear on a disabled button in every browser and do not exist at all on touch, so a
  // Project Manager opening Purchase Orders saw two buttons that did nothing and no
  // explanation anywhere — which is exactly the "Settle Balance is unresponsive" report.
  //
  // So the button is no longer `disabled`: a disabled element fires no events, and firing
  // an event is the only way to explain itself. `aria-disabled` carries the same meaning to
  // assistive tech without swallowing the click, and clicking states the reason out loud.
  // Centralised here rather than at each call site, because there are dozens and the whole
  // failure was one of them being silent.
  if (!allowed) {
    // The caller's className carries `disabled:` Tailwind variants, which no longer apply
    // now that the button is not `disabled` — so the dimming is added explicitly here.
    // Without this the control would look perfectly usable, which is worse than before.
    return (
      <button
        {...rest}
        onClick={() =>
          pushToast({ title: 'Not permitted', body: reason || 'Your role cannot do this.', kind: 'redflag' })
        }
        aria-disabled="true"
        disabled={false}
        title={reason || undefined}
        className={`${className} opacity-40 cursor-not-allowed`}
      >
        <Lock size={12} className="opacity-70" />
        {children}
      </button>
    )
  }

  return (
    <button
      onClick={onClick}
      disabled={rest.disabled}
      title={reason || undefined}
      className={className}
      {...rest}
    >
      {children}
    </button>
  )
}
