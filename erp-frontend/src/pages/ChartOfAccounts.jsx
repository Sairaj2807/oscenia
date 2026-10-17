import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Network, Plus, Pencil, Trash2, EyeOff, Eye, CornerDownRight, Search,
  BookOpen, AlertTriangle, Landmark, Percent, Layers,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { api } from '../lib/api'
import {
  PageHeader, Card, Badge, money2, Field, TextInput, Select, FilterPill,
  ActionButton, SectionTitle,
} from '../components/ui'
import Modal from '../components/Modal'
import {
  ACCOUNT_TYPES, TYPE_ORDER, chartTree, childrenOf, isHeader,
  nextChildCode, nextCodeForType, allGroups, validateAccountDraft, CONTROL_ACCOUNT_CODES,
} from '../lib/accounts'
import { accountBalance } from '../lib/ledger'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptAccountBalances } from '../store/reportAdapters'
import { canDo } from '../lib/roles'
import { useT } from '../i18n'

// ---------------------------------------------------------------------------
// Add / edit an account.
//
// The client's ask was "add, configure, and adjust sub-accounts in alignment
// with dynamic business developments" — so the same form does all three, and
// the parent picker is what turns an account into a sub-account.
// ---------------------------------------------------------------------------
function AccountModal({ editing, presetParent, presetType, onClose }) {
  const accounts = useStore((s) => s.accounts)
  const addAccount = useStore((s) => s.addAccount)
  const updateAccount = useStore((s) => s.updateAccount)
  const accountUsage = useStore((s) => s.accountUsage)
  const t = useT()

  const parentAccount = presetParent ? accounts.find((a) => a.code === presetParent) : null

  const [form, setForm] = useState(() => {
    if (editing) return { ...editing, group: editing.group || '' }
    const type = parentAccount?.type || presetType || 'asset'
    return {
      code: parentAccount ? nextChildCode(parentAccount.code, accounts) : nextCodeForType(type, accounts),
      name: '',
      type,
      group: parentAccount?.group || '',
      parent: parentAccount?.code || '',
      cash: Boolean(parentAccount?.cash),
    }
  })

  const set = (k) => (e) =>
    setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  // Signed in, the server picks the next free code: two people adding accounts at once get different
  // ones, which the browser's own guess (from the list it loaded) cannot promise. A code typed in the
  // meantime is left alone, and if the server cannot be asked the local guess stays.
  const live = useStore((s) => s.hydrated)
  useEffect(() => {
    if (editing || !live) return undefined
    let off = false
    const guess = form.code
    api.get('/accounts/next-code', parentAccount ? { parent: parentAccount.code } : { type: form.type })
      .then((r) => { if (!off && r?.code) setForm((f) => (f.code === guess ? { ...f, code: r.code } : f)) })
      .catch(() => {})
    return () => { off = true }
    // Once, when the form opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const used = editing ? accountUsage(editing.code) : 0
  const codeLocked = used > 0
  const typeLocked = used > 0

  const draft = { ...form, parent: form.parent || undefined }
  const error = validateAccountDraft(draft, accounts, editing?.code ?? null)

  const submit = () => {
    if (error) return
    if (editing) updateAccount(editing.code, draft)
    else addAccount(draft)
    onClose()
  }

  // Only top-level accounts of the same type can be parents — sub-accounts
  // nest one level, which is the "minimise excessive account fragmentation"
  // principle the proposal opens with. The AR/AP control accounts never take sub-accounts.
  const parentOptions = accounts.filter(
    (a) => a.type === form.type && !a.parent && a.code !== editing?.code && !CONTROL_ACCOUNT_CODES.includes(a.code)
  )

  return (
    <Modal
      title={editing ? `Edit ${editing.code}` : parentAccount ? `New sub-account of ${parentAccount.code}` : 'New Account'}
      subtitle={editing
        ? t('Naming is always editable. Code and type lock once the account carries posted history.')
        : t('Type decides which statement the account lands on — that mapping is what makes the reports derive themselves.')}
      size="xl"
      onClose={onClose}
      footer={
        <>
          {error && (
            <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-amber-300">
              <AlertTriangle size={12} /> {error}
            </span>
          )}
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={submit} disabled={Boolean(error)} className="btn-gold">
            <Plus size={14} /> {editing ? t('Save account') : t('Create account')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field
          label="Account code"
          hint={codeLocked ? `${t('Locked —')} ${used} ${t('posted line(s) reference this code')}` : t('Numeric; dotted for sub-accounts (1101.01)')}
        >
          <TextInput value={form.code} onChange={set('code')} disabled={codeLocked} className={codeLocked ? 'opacity-50' : ''} />
        </Field>
        <Field label="Account name">
          <TextInput value={form.name} onChange={set('name')} placeholder="e.g. BCA Operating Account" />
        </Field>
        <Field
          label="Type"
          hint={typeLocked ? t('Locked — retyping would move posted entries between statements') : ACCOUNT_TYPES[form.type]?.statement === 'income' ? t('Appears on the Income Statement') : t('Appears on the Balance Sheet')}
        >
          <Select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value, parent: '' }))}
            disabled={typeLocked}
          >
            {TYPE_ORDER.map((x) => (
              <option key={x} value={x}>{ACCOUNT_TYPES[x].group}</option>
            ))}
          </Select>
        </Field>
        <Field label="Parent account" hint={t('Leave blank for a top-level account')}>
          <Select value={form.parent || ''} onChange={set('parent')}>
            <option value="">— {t('none')} —</option>
            {parentOptions.map((a) => (
              <option key={a.code} value={a.code}>{a.code} · {a.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="Executive group" hint={t('The bucket this rolls into on the summarised report')}>
          <TextInput
            value={form.group}
            onChange={set('group')}
            list="coa-groups"
            placeholder={ACCOUNT_TYPES[form.type]?.group}
          />
          <datalist id="coa-groups">
            {allGroups().map((g) => <option key={g} value={g} />)}
          </datalist>
        </Field>
        <Field label="Flags">
          <label className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2.5 text-sm text-white/75">
            <input type="checkbox" checked={Boolean(form.cash)} onChange={set('cash')} className="accent-gold" />
            {t('Counts towards Total Cash')}
          </label>
        </Field>
      </div>

      {/* Where this account will show up, stated before it is created rather
          than discovered afterwards. This is the "automatic vertical
          integration" from the proposal, made legible. */}
      <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3 text-[11px] space-y-1.5">
        <div className="flex items-center gap-1.5 text-gold-light mb-1">
          <Network size={13} /> <span className="font-medium">{t('Automatic integration')}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-white/40">{t('General Ledger')}</span>
          <span className="text-white/85">{form.code || '—'} · {form.name || t('(unnamed)')}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-white/40">{ACCOUNT_TYPES[form.type]?.statement === 'income' ? t('Income Statement') : t('Balance Sheet')}</span>
          <span className="text-white/85">{ACCOUNT_TYPES[form.type]?.group}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-white/40">{t('Executive summary')}</span>
          <span className="text-white/85">{form.group || ACCOUNT_TYPES[form.type]?.group}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-white/40">{t('Normal balance')}</span>
          <span className="text-white/85 capitalize">{ACCOUNT_TYPES[form.type]?.side}</span>
        </div>
      </div>
    </Modal>
  )
}

// ---------------------------------------------------------------------------
function AccountRow({ acct, depth = 0, balanceOf, onEdit, onAddChild, role }) {
  const setAccountActive = useStore((s) => s.setAccountActive)
  const deleteAccount = useStore((s) => s.deleteAccount)
  const accountUsage = useStore((s) => s.accountUsage)
  const navigate = useNavigate()
  const t = useT()

  const kids = childrenOf(acct.code)
  const header = kids.length > 0
  const used = accountUsage(acct.code)
  const inactive = acct.active === false

  // A header shows what its sub-accounts add up to — PLUS anything posted to
  // the header itself before it had children. Those postings do not migrate
  // when a sub-account is opened, and a figure that ignored them would not
  // reconcile with the ledger.
  const balance = balanceOf(acct.code) + kids.reduce((a, c) => a + balanceOf(c), 0)

  const canManage = canDo(role, 'manage_coa')

  return (
    <>
      <tr className={inactive ? 'opacity-45' : ''}>
        <td className="td">
          <div className="flex items-center gap-2" style={{ paddingLeft: depth * 18 }}>
            {depth > 0 && <CornerDownRight size={12} className="text-white/25 shrink-0" />}
            <span className={`font-mono text-xs ${header ? 'text-white/80' : 'text-gold/80'}`}>{acct.code}</span>
          </div>
        </td>
        <td className="td">
          <div className="flex flex-wrap items-center gap-2">
            <span className={header ? 'text-white font-medium' : 'text-white/85'}>{acct.name}</span>
            {header && <Badge>Header</Badge>}
            {inactive && <Badge>Inactive</Badge>}
            {acct.cash && (
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                <Landmark size={9} /> {t('Cash')}
              </span>
            )}
            {acct.tax && (
              <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                <Percent size={9} /> {acct.tax.toUpperCase()}
              </span>
            )}
          </div>
        </td>
        <td className="td text-white/45 text-xs">{acct.group || ACCOUNT_TYPES[acct.type]?.group}</td>
        <td className="td text-center tabular-nums text-white/50 text-xs">
          {header ? '—' : used || <span className="text-white/20">0</span>}
        </td>
        <td className="td text-right tabular-nums">{money2(balance)}</td>
        <td className="td text-right">
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={() => navigate(`/accounting?tab=ledger&account=${encodeURIComponent(acct.code)}`)}
              className="text-white/25 hover:text-gold-light"
              title={t('Open in the General Ledger')}
            >
              <BookOpen size={13} />
            </button>
            {canManage && !acct.parent && !CONTROL_ACCOUNT_CODES.includes(acct.code) && (
              <button onClick={() => onAddChild(acct.code)} className="text-white/25 hover:text-gold-light" title={t('Add a sub-account')}>
                <Plus size={13} />
              </button>
            )}
            {canManage && (
              <button onClick={() => onEdit(acct)} className="text-white/25 hover:text-gold-light" title={t('Edit account')}>
                <Pencil size={13} />
              </button>
            )}
            {canManage && (
              <button
                onClick={() => setAccountActive(acct.code, inactive)}
                className="text-white/25 hover:text-amber-300"
                title={inactive ? t('Reactivate account') : t('Deactivate account')}
              >
                {inactive ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
            )}
            {canManage && (
              <button
                onClick={() => deleteAccount(acct.code)}
                disabled={used > 0 || kids.length > 0}
                className="text-white/25 hover:text-rose-300 disabled:opacity-20 disabled:hover:text-white/25"
                title={used > 0 ? t('Has posted history — deactivate instead') : t('Delete account')}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        </td>
      </tr>
      {(acct.children || []).map((child) => (
        <AccountRow
          key={child.code}
          acct={child}
          depth={depth + 1}
          balanceOf={balanceOf}
          onEdit={onEdit}
          onAddChild={onAddChild}
          role={role}
        />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
export default function ChartOfAccounts() {
  const accounts = useStore((s) => s.accounts)
  const journal = useStore((s) => s.journal)
  const role = useStore((s) => s.role)
  const live = useStore((s) => s.hydrated)
  const t = useT()

  // Signed in, every account's balance comes from the server's account tree; the browser's own sum
  // over the journal is the demo's source and the cross-check (on the cash accounts, a cheap spot check).
  const balances = useReport('/accounts/tree', { includeInactive: true }, adaptAccountBalances, { enabled: live })
  const fromServer = live && balances.data
  const balanceOf = (code) => (fromServer ? (balances.data[code] ?? 0) : accountBalance(journal, code))
  useCrossCheck('chart: Main Bank 1101', fromServer ? balances.data['1101'] ?? 0 : null, accountBalance(journal, '1101'))
  useCrossCheck('chart: Receivable 1201', fromServer ? balances.data['1201'] ?? 0 : null, accountBalance(journal, '1201'))

  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState('all')
  const [showInactive, setShowInactive] = useState(true)
  const [modal, setModal] = useState(null) // { editing } | { presetParent } | { presetType }

  // Postings per account, computed once for the whole chart rather than per row.
  const usage = useMemo(() => {
    const map = {}
    journal.forEach((e) => (e.lines || []).forEach((l) => { map[l.account] = (map[l.account] || 0) + 1 }))
    return map
  }, [journal])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return accounts.filter((a) => {
      if (typeFilter !== 'all' && a.type !== typeFilter) return false
      if (!showInactive && a.active === false) return false
      if (!q) return true
      return (
        a.code.toLowerCase().includes(q) ||
        a.name.toLowerCase().includes(q) ||
        (a.group || '').toLowerCase().includes(q)
      )
    })
  }, [accounts, query, typeFilter, showInactive])

  const tree = useMemo(() => chartTree(filtered), [filtered])

  const stats = useMemo(() => {
    const postable = accounts.filter((a) => a.active !== false && !isHeader(a.code))
    return {
      total: accounts.length,
      postable: postable.length,
      inactive: accounts.filter((a) => a.active === false).length,
      // "Lean architecture": the proposal asks to minimise excessive account
      // fragmentation. Rather than refuse new accounts, name the ones nobody
      // has ever used — that is the fragmentation, made visible.
      unused: postable.filter((a) => !usage[a.code]).length,
    }
  }, [accounts, usage])

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Master Data"
        title="Chart of Accounts"
        subtitle="The foundation the General Ledger, Income Statement and Balance Sheet all derive from. Add or adjust sub-accounts here and every downstream report follows automatically — nothing is re-mapped by hand."
        actions={
          <ActionButton action="manage_coa" role={role} onClick={() => setModal({ presetType: 'asset' })}>
            <Plus size={15} /> {t('Add Account')}
          </ActionButton>
        }
      />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Accounts')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{stats.total}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Postable')}</div>
          <div className="mt-1 font-display text-xl text-emerald-300 tabular-nums">{stats.postable}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('excludes headers & inactive')}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Deactivated')}</div>
          <div className="mt-1 font-display text-xl text-white/60 tabular-nums">{stats.inactive}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('history kept, postings closed')}</div>
        </Card>
        <Card className={stats.unused > 6 ? 'border-amber-500/35' : ''}>
          <div className="text-xs text-white/40">{t('Never posted to')}</div>
          <div className={`mt-1 font-display text-xl tabular-nums ${stats.unused > 6 ? 'text-amber-300' : 'text-white'}`}>
            {stats.unused}
          </div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('candidates to retire')}</div>
        </Card>
      </div>

      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex-1 min-w-[220px]">
            <Field label="Search">
              <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-navy-900 px-3 py-2 focus-within:border-gold/50">
                <Search size={14} className="text-white/40 shrink-0" />
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('Code, name or group')}
                  className="w-full bg-transparent text-sm text-white/85 placeholder:text-white/30 outline-none"
                />
              </div>
            </Field>
          </div>
          <div className="flex-1 min-w-[240px]">
            <div className="text-[11px] uppercase tracking-wider text-white/35 mb-1.5">{t('Type')}</div>
            <div className="flex flex-wrap gap-2">
              <FilterPill active={typeFilter === 'all'} onClick={() => setTypeFilter('all')}>{t('All')}</FilterPill>
              {TYPE_ORDER.map((x) => (
                <FilterPill key={x} active={typeFilter === x} onClick={() => setTypeFilter(x)}>
                  {t(ACCOUNT_TYPES[x].group)}
                </FilterPill>
              ))}
            </div>
          </div>
          <FilterPill active={showInactive} onClick={() => setShowInactive((v) => !v)}>
            {showInactive ? t('Showing inactive') : t('Hiding inactive')}
          </FilterPill>
        </div>
      </Card>

      {tree.map((section) => (
        <div key={section.type}>
          <SectionTitle icon={Layers}>
            {t(section.label)}
            <span className="ml-2 text-[10px] normal-case tracking-normal text-white/30">
              {ACCOUNT_TYPES[section.type].statement === 'income' ? t('Income Statement') : t('Balance Sheet')}
              {' · '}
              {t('normal')} {t(ACCOUNT_TYPES[section.type].side)}
            </span>
          </SectionTitle>
          {section.groups.map((group) => (
            <div key={group.group} className="mb-4">
              <div className="text-[11px] uppercase tracking-wider text-gold/50 mb-1.5 px-1">{group.group}</div>
              <TableWrapLocal>
                <thead>
                  <tr>
                    <th className="th w-28">{t('Code')}</th>
                    <th className="th">{t('Account')}</th>
                    <th className="th">{t('Executive group')}</th>
                    <th className="th text-center">{t('Postings')}</th>
                    <th className="th text-right">{t('Balance')}</th>
                    <th className="th"></th>
                  </tr>
                </thead>
                <tbody>
                  {group.accounts.map((a) => (
                    <AccountRow
                      key={a.code}
                      acct={a}
                      balanceOf={balanceOf}
                      role={role}
                      onEdit={(acct) => setModal({ editing: acct })}
                      onAddChild={(code) => setModal({ presetParent: code })}
                    />
                  ))}
                </tbody>
              </TableWrapLocal>
            </div>
          ))}
        </div>
      ))}

      {!tree.length && (
        <Card><div className="text-sm text-white/30">{t('No accounts match these filters.')}</div></Card>
      )}

      <div className="mt-4 text-[11px] text-white/30">
        {t('An account that has ever been posted to keeps its code and type for good — deactivate it instead, and the history keeps its account name.')}
      </div>

      {modal && (
        <AccountModal
          editing={modal.editing}
          presetParent={modal.presetParent}
          presetType={modal.presetType}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  )
}

// Narrower minimum than the shared TableWrap: the chart is a reference table,
// not a data grid, and it should not force a horizontal scrollbar on a laptop.
function TableWrapLocal({ children }) {
  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[620px]">{children}</table>
      </div>
    </div>
  )
}
