import { useEffect, useState } from 'react'
import { NavLink, useLocation } from 'react-router-dom'
import {
  ChevronDown, LayoutDashboard, KanbanSquare, Wallet, PieChart, Users, Truck,
  ClipboardCheck, Warehouse as WarehouseIcon, BadgeDollarSign, Trophy, X,
  BookOpen, Gauge, Wallet2, Clock, FileSignature, Banknote, Receipt, ClipboardList,
  Network, Boxes, Wallet as WalletIcon, ListChecks, MessagesSquare, PartyPopper, CalendarDays, Palette, UserCog,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { canSee } from '../lib/roles'
import { useT } from '../i18n'

const NAV = [
  { key: 'dashboard', to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { key: 'quotations', to: '/quotations', label: 'Quotations & MoU', icon: FileSignature },
  { key: 'projects', to: '/projects', label: 'Projects', icon: KanbanSquare },
  { key: 'workspace', to: '/workspace', label: 'Workspace & Tasks', icon: ListChecks },
  { key: 'chat', to: '/chat', label: 'Team Chat', icon: MessagesSquare },
  { key: 'finance', to: '/finance', label: 'Finance & Invoicing', icon: Wallet },
  { key: 'cash', to: '/cash', label: 'Total Cash', icon: Banknote, parent: 'finance' },
  { key: 'receivables', to: '/receivables', label: 'Accounts Receivable', icon: Receipt, parent: 'finance' },
  { key: 'payables', to: '/payables', label: 'Accounts Payable', icon: WalletIcon, parent: 'finance' },
  { key: 'pnl', to: '/pnl', label: 'Project P&L', icon: PieChart, parent: 'finance' },
  { key: 'accounting', to: '/accounting', label: 'Accounting', icon: BookOpen, parent: 'finance' },
  { key: 'coa', to: '/accounts', label: 'Chart of Accounts', icon: Network, parent: 'finance' },
  { key: 'fixedassets', to: '/fixed-assets', label: 'Fixed Assets', icon: Boxes, parent: 'finance' },
  { key: 'budgeting', to: '/budgeting', label: 'Budgeting', icon: Wallet2, parent: 'finance' },
  { key: 'simulator', to: '/simulator', label: 'Profit Simulator', icon: Gauge, parent: 'finance' },
  { key: 'events', to: '/events', label: 'Events & Invitations', icon: PartyPopper },
  { key: 'templates', to: '/events/templates', label: 'Invitation templates', icon: Palette, parent: 'events' },
  { key: 'crm', to: '/crm', label: 'CRM & Clients', icon: Users },
  { key: 'gcal', to: '/google-calendar', label: 'Google Calendar', icon: CalendarDays, parent: 'crm' },
  { key: 'cron', to: '/cron', label: 'Automated Cron', icon: Clock, parent: 'crm' },
  { key: 'vendors', to: '/vendors', label: 'Vendors', icon: Truck },
  { key: 'purchaseorders', to: '/purchase-orders', label: 'Purchase Orders', icon: ClipboardList, parent: 'vendors' },
  { key: 'procurement', to: '/procurement', label: 'Procurement', icon: ClipboardCheck },
  { key: 'warehouse', to: '/warehouse', label: 'Warehouse', icon: WarehouseIcon },
  { key: 'payroll', to: '/payroll', label: 'Crew & Incentives', icon: BadgeDollarSign },
  { key: 'sales', to: '/sales', label: 'Sales Report', icon: Trophy },
  // CEO only (the module list gives every other role no `users`).
  { key: 'users', to: '/users', label: 'Users', icon: UserCog },
]

// Which groups (a parent and its sub-pages) the viewer has folded or unfolded, kept per
// browser. Storage can be blocked (private windows): then the sidebar just forgets.
const FOLD_KEY = 'oscenia.sidebar.groups'
function readFolds() {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY)) || {} } catch { return {} }
}
function saveFolds(folds) {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify(folds)) } catch { /* not remembered */ }
}

// Is `pathname` this nav item's page (or a page beneath it)?
const onPage = (n, pathname) => (n.end ? pathname === n.to : pathname === n.to || pathname.startsWith(`${n.to}/`))

export default function Sidebar({ open, onClose }) {
  const role = useStore((s) => s.role)
  const t = useT()
  const { pathname } = useLocation()
  // { [groupKey]: true (open) | false (closed) } — only groups the viewer has toggled. Read
  // after the first paint, never during render (the smoke test renders on the server).
  const [folds, setFolds] = useState({})
  useEffect(() => { setFolds(readFolds()) }, [])

  const items = NAV.filter((n) => canSee(role, n.key))
  const hasChildren = new Set(items.filter((n) => n.parent).map((n) => n.parent))
  // A group the viewer has not toggled starts closed, unless they are on one of its pages.
  const isOpen = (key) => folds[key] ?? items.some((n) => (n.key === key || n.parent === key) && onPage(n, pathname))
  const toggle = (key) => {
    const next = { ...folds, [key]: !isOpen(key) }
    setFolds(next)
    saveFolds(next)
  }

  return (
    <>
      {/* Mobile overlay */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-30 bg-black/60 backdrop-blur-sm lg:hidden transition-opacity ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <aside
        className={`fixed z-40 h-full w-72 border-r border-white/10 bg-navy-900/95 backdrop-blur
          transition-transform duration-300 lg:translate-x-0 lg:z-0
          ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center justify-between px-6 h-16 border-b border-white/10">
          <div>
            <div className="brand-mark text-base leading-none">OSCENIA</div>
            <div className="text-[9px] tracking-[0.3em] text-white/40 mt-1">{t('ERP · OPERATIONS')}</div>
          </div>
          <button onClick={onClose} className="lg:hidden text-white/60 hover:text-white">
            <X size={20} />
          </button>
        </div>

        <nav className="p-3 space-y-1 overflow-y-auto h-[calc(100%-4rem)]">
          {items.map((n) => {
            // A sub-page hides while its group is folded (and shows on its own if this role
            // cannot see the parent).
            if (n.parent && items.some((p) => p.key === n.parent) && !isOpen(n.parent)) return null
            const Icon = n.icon
            const indent = n.parent ? 'pl-11' : 'pl-3'
            const group = hasChildren.has(n.key)
            const link = (
              <NavLink
                key={n.key}
                to={n.to}
                end={n.end}
                onClick={onClose}
                className={({ isActive }) =>
                  `flex items-center gap-3 rounded-lg ${indent} ${group ? 'pr-10' : 'pr-3'} py-2.5 text-sm transition-colors ${
                    isActive
                      ? 'bg-gold/15 text-gold-light border border-gold/25'
                      : 'text-white/60 hover:text-white hover:bg-white/5 border border-transparent'
                  }`
                }
              >
                {!n.parent && <Icon size={17} className="shrink-0" />}
                <span>{t(n.label)}</span>
              </NavLink>
            )
            if (!group) return link
            const expanded = isOpen(n.key)
            return (
              <div key={n.key} className="relative">
                {link}
                <button
                  type="button"
                  onClick={() => toggle(n.key)}
                  aria-expanded={expanded}
                  aria-label={`${t(expanded ? 'Collapse' : 'Expand')} ${t(n.label)}`}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-white/45 hover:bg-white/10 hover:text-white"
                >
                  <ChevronDown size={15} className={`transition-transform ${expanded ? '' : '-rotate-90'}`} />
                </button>
              </div>
            )
          })}
          <div className="pt-4 mt-4 border-t border-white/10 px-3">
            <div className="text-[10px] text-white/30 leading-relaxed">
              {t('Every record hangs off a')} <span className="text-gold/70">Project ID</span>.{' '}
              {t('A status change in one module triggers the next automatically.')}
            </div>
          </div>
        </nav>
      </aside>
    </>
  )
}
