import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Menu, ChevronDown, Search, X, KanbanSquare, Users, Wallet, FileSignature, BookOpen, Truck,
  ShoppingCart, Boxes, HardHat, Building2, Coins, MessageSquare, CheckSquare, CalendarDays, Paperclip,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { useAuth, DEMO_MODE } from '../store/useAuth'
import { ROLES } from '../lib/roles'
import { MIN_QUERY, SEARCH_KINDS } from '../lib/search'
import { money } from './ui'
import { useT } from '../i18n'
import NotificationBell from './NotificationBell'
import { useDismiss } from './useDismiss'
import Modal from './Modal'
import ChangePasswordForm from './ChangePasswordForm'

// The icon per kind. Labels and routes live in lib/search.js, with the search itself, so
// the store and this component cannot disagree about where a hit goes.
const ICONS = {
  project: KanbanSquare,
  client: Users,
  quotation: FileSignature,
  invoice: Wallet,
  purchase_order: ShoppingCart,
  vendor: Truck,
  journal: BookOpen,
  procurement: Coins,
  inventory: Boxes,
  fixed_asset: Building2,
  crew: HardHat,
  chat_message: MessageSquare,
  task: CheckSquare,
  event: CalendarDays,
  file: Paperclip,
}

// Long enough that the box does not fire on every keystroke, short enough that it feels
// live. The request is abandoned rather than cancelled if a newer one starts.
const DEBOUNCE_MS = 200

export default function Topbar({ onMenu }) {
  const role = useStore((s) => s.role)
  // Switching role now *signs in as* that person rather than toggling a string. The
  // difference is the whole point: a Project Manager cannot approve a PO because the server
  // refuses it, not because this menu hid the button.
  const switchRole = useAuth((s) => s.switchRole)
  const signOut = useAuth((s) => s.signOut)
  const signOutEverywhere = useAuth((s) => s.signOutEverywhere)
  const pushToast = useStore((s) => s.pushToast)
  const offline = useAuth((s) => !!s.user?.offline)
  const [switching, setSwitching] = useState(null)
  const lang = useStore((s) => s.lang)
  const toggleLang = useStore((s) => s.toggleLang)
  const saveLanguage = useAuth((s) => s.saveLanguage)
  const [changingPassword, setChangingPassword] = useState(false)
  // The six collections this used to subscribe to are gone with the search that read them.
  // Subscribing to the journal from the top bar also meant every posting anywhere in the app
  // re-rendered the search box.
  const searchEverything = useStore((s) => s.searchEverything)
  const hydrated = useStore((s) => s.hydrated)
  const t = useT()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  // The role menu closes on a click anywhere else (see useDismiss for why not a backdrop).
  const roleMenu = useRef(null)
  const closeRoleMenu = useCallback(() => setOpen(false), [])
  useDismiss(roleMenu, open, closeRoleMenu)
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState(false)
  const [groups, setGroups] = useState([])
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const inputRef = useRef(null)
  const account = useAuth((s) => s.user)
  // A real build shows the person who is actually signed in. The canned role cards
  // (R. Hartono, Lina W. ...) belong to demo mode only.
  const current = DEMO_MODE || !account
    ? ROLES[role]
    : { initials: account.initials, name: account.fullName, label: account.roleLabel || ROLES[role]?.label || '' }

  // Debounced, and a stale answer is thrown away rather than rendered: at one request per
  // keystroke the answer to "AUR" can arrive after the answer to "AURORA".
  useEffect(() => {
    const q = query.trim()
    if (q.length < MIN_QUERY) {
      setGroups([])
      setSearchError(null)
      setSearching(false)
      return undefined
    }

    let live = true
    setSearching(true)
    const timer = setTimeout(() => {
      Promise.resolve(searchEverything(q))
        .then((found) => {
          if (!live) return
          setGroups(found)
          setSearchError(null)
        })
        .catch((err) => {
          // Said out loud on purpose. A search that quietly returns nothing when the request
          // failed is indistinguishable from "that record does not exist".
          if (!live) return
          setGroups([])
          setSearchError(err?.message || 'The search request failed.')
        })
        .finally(() => {
          if (live) setSearching(false)
        })
    }, DEBOUNCE_MS)

    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, searchEverything, hydrated])

  // Flat, for the keyboard: Enter opens the best hit, whichever group it is in.
  const results = groups.flatMap((group) => group.hits)

  const go = (r) => {
    const kind = SEARCH_KINDS[r.kind]
    if (!kind) return
    navigate(kind.to(r))
    setQuery('')
    setFocused(false)
    inputRef.current?.blur()
  }

  const showResults = focused && query.trim().length >= MIN_QUERY

  return (
    <header className="sticky top-0 z-20 h-16 border-b border-white/10 bg-navy-950/80 backdrop-blur">
      <div className="flex h-full items-center gap-3 px-4 sm:px-6">
        <button onClick={onMenu} className="lg:hidden text-white/70 hover:text-white">
          <Menu size={22} />
        </button>

        {/* Search — was a decorative span with placeholder text and no input. */}
        <div className="relative hidden md:block w-full max-w-sm">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 focus-within:border-gold/50 transition-colors">
            <Search size={15} className="text-white/40 shrink-0" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setTimeout(() => setFocused(false), 150)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setQuery(''); inputRef.current?.blur() }
                if (e.key === 'Enter' && results.length) go(results[0])
              }}
              placeholder={t('Search anything — documents, people, stock, amounts…')}
              className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
            />
            {query && (
              <button onClick={() => setQuery('')} className="text-white/30 hover:text-white shrink-0" aria-label="Clear search">
                <X size={14} />
              </button>
            )}
          </div>

          {showResults && (
            <div className="absolute left-0 right-0 top-full mt-2 rounded-xl border border-white/10 bg-navy-800 p-1.5 shadow-2xl animate-fade-up max-h-[70vh] overflow-y-auto">
              {/* Grouped, best group first, so an exact purchase order is not buried under
                  three fuzzy project names. The old list was flat and capped at eight. */}
              {groups.map((group) => (
                <div key={group.kind}>
                  <div className="px-3 pt-2 pb-1 text-[9px] uppercase tracking-wider text-white/30">
                    {t(group.label)}
                  </div>
                  {group.hits.map((r) => {
                    const Icon = ICONS[r.kind] || BookOpen
                    return (
                      <button
                        key={`${r.kind}-${r.uuid ?? r.id}`}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => go(r)}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-white/5 transition-colors"
                      >
                        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-white/10 text-gold/70">
                          <Icon size={14} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-white">{r.title}</span>
                          <span className="block truncate text-[11px] text-white/40">{r.meta}</span>
                        </span>
                        {r.value != null && (
                          <span className="shrink-0 text-[11px] tabular-nums text-white/50">{money(r.value)}</span>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}

              {searchError && (
                <div className="px-3 py-3 text-sm text-rose-300">
                  {t('Search failed')} — {searchError}
                </div>
              )}
              {!searchError && !groups.length && (
                <div className="px-3 py-4 text-sm text-white/30">
                  {searching ? `${t('Searching')}…` : `${t('Nothing found for')} “${query}”`}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Language toggle (EN / ID) */}
          <button
            onClick={() => saveLanguage(toggleLang())}
            className="inline-flex items-center rounded-lg border border-white/15 bg-white/5 overflow-hidden text-[11px] font-medium hover:border-gold/50 transition-colors"
            title="Language / Bahasa"
          >
            <span className={`px-2.5 py-1.5 ${lang === 'en' ? 'bg-gold text-navy-950' : 'text-white/60'}`}>EN</span>
            <span className={`px-2.5 py-1.5 ${lang === 'id' ? 'bg-gold text-navy-950' : 'text-white/60'}`}>ID</span>
          </button>

          {/* In the header flow rather than floating, so it never sits over page content. */}
          {DEMO_MODE && <span
            title={offline ? 'Offline demo: no server is connected. Changes stay in this browser.' : undefined}
            className="hidden sm:inline-flex items-center rounded-full border border-gold/40 bg-gold/10 px-3 py-1 text-[10px] uppercase tracking-[0.25em] text-gold-light whitespace-nowrap"
          >
            {t(offline ? 'Demo mode' : 'Prototype')}
          </span>}

          <NotificationBell />

          {/* Role switcher — drives the RBAC illusion */}
          <div className="relative" ref={roleMenu}>
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex items-center gap-2.5 rounded-lg border border-white/15 bg-white/5 pl-1.5 pr-2.5 py-1.5 hover:border-gold/50 transition-colors"
            >
              <span className="grid h-7 w-7 place-items-center rounded-md bg-gold text-navy-950 text-xs font-semibold">
                {current.initials}
              </span>
              <span className="hidden sm:block text-left leading-tight">
                <span className="block text-xs text-white">{current.name}</span>
                <span className="block text-[10px] text-white/40">{t(current.label)}</span>
              </span>
              <ChevronDown size={15} className="text-white/40" />
            </button>

            {open && (
              <>
                <div className="absolute right-0 z-20 mt-2 w-60 rounded-xl border border-white/10 bg-navy-800 p-1.5 shadow-2xl animate-fade-up">
                  <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-white/30">
                    {t('Signed in as')}
                  </div>
                  {!DEMO_MODE && account && (
                    <div className="px-3 pb-2 text-xs text-white/60 break-all">{account.email}</div>
                  )}
                  {DEMO_MODE && Object.values(ROLES).map((r) => (
                    <button
                      key={r.id}
                      disabled={switching !== null}
                      onClick={async () => {
                        setSwitching(r.id)
                        try { await switchRole(r.id) } finally { setSwitching(null); setOpen(false) }
                      }}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                        role === r.id ? 'bg-gold/15' : 'hover:bg-white/5'
                      }`}
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-md bg-white/10 text-xs font-semibold text-white">
                        {r.initials}
                      </span>
                      <span className="leading-tight">
                        <span className="block text-sm text-white">{t(r.label)}</span>
                        <span className="block text-[11px] text-white/40">{t(r.subtitle)}</span>
                      </span>
                    </button>
                  ))}
                  <div className="mt-1 border-t border-white/10 pt-1">
                    <button
                      onClick={async () => { setOpen(false); await signOut() }}
                      className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white transition-colors"
                    >
                      <span className="grid h-8 w-8 place-items-center rounded-md bg-white/5 text-xs">⎋</span>
                      {t('Sign out')}
                    </button>
                    {!offline && (
                      <button
                        onClick={() => { setOpen(false); setChangingPassword(true) }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white transition-colors"
                      >
                        <span className="grid h-8 w-8 place-items-center rounded-md bg-white/5 text-xs">••</span>
                        {t('Change password')}
                      </button>
                    )}
                    {!offline && (
                      <button
                        onClick={async () => {
                          if (!window.confirm(t('Sign out of every device? You will need to sign in again on each one.'))) return
                          setOpen(false)
                          try { await signOutEverywhere() } catch {
                            pushToast({ title: 'Not signed out everywhere', body: 'The server could not be reached, so your other sessions are still open. Try again.', kind: 'redflag' })
                          }
                        }}
                        className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm text-white/60 hover:bg-white/5 hover:text-white transition-colors"
                      >
                        <span className="grid h-8 w-8 place-items-center rounded-md bg-white/5 text-xs">⎋⎋</span>
                        {t('Sign out everywhere')}
                      </button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {changingPassword && (
        <Modal title="Change password" subtitle="Your other devices will be signed out" onClose={() => setChangingPassword(false)}>
          <ChangePasswordForm onDone={() => setChangingPassword(false)} onCancel={() => setChangingPassword(false)} />
        </Modal>
      )}
    </header>
  )
}
