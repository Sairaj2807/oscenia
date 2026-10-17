import { useMemo, useState } from 'react'
import {
  Boxes, Plus, Play, AlertTriangle, CalendarClock, TrendingDown, Check,
  ChevronRight, Archive, Landmark,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import {
  PageHeader, Card, TableWrap, Badge, money2, SectionTitle,
  Field, TextInput, NumberInput, Select, ActionButton, FilterPill,
} from '../components/ui'
import Modal from '../components/Modal'
import {
  METHODS, buildSchedule, duePeriods, accumulatedFor, netBookValue,
  registerTotals, validateAsset,
} from '../lib/depreciation'
import { accountBalance } from '../lib/ledger'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptAccountBalances } from '../store/reportAdapters'
import { CASH_ACCOUNTS, accountLabel } from '../lib/accounts'
import { appToday, formatDate } from '../lib/format'
import { useT } from '../i18n'

const STATE_STYLE = {
  posted: 'text-emerald-300',
  due: 'text-amber-300',
  future: 'text-white/35',
}

// ---------------------------------------------------------------------------
// Acquisition form. The preview panel is the point: "the system accurately
// calculates and schedules the monthly depreciation expense allocation" should
// be visible before the asset is saved, not discovered afterwards.
// ---------------------------------------------------------------------------
function AssetModal({ onClose }) {
  const capitaliseAsset = useStore((s) => s.capitaliseAsset)
  const inventory = useStore((s) => s.inventory)
  const fixedAssets = useStore((s) => s.fixedAssets)
  const t = useT()

  const [form, setForm] = useState({
    name: '',
    category: 'Equipment',
    acquiredOn: appToday(),
    cost: 50_000_000,
    salvage: 5_000_000,
    usefulLifeMonths: 60,
    method: 'straight-line',
    inventoryId: '',
  })
  const [payFrom, setPayFrom] = useState(CASH_ACCOUNTS[0] || '1101')
  const [alreadyCarried, setAlreadyCarried] = useState(false)

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const error = validateAsset(form)

  // Warehouse fixed assets that are not on the register yet.
  const uncapitalised = inventory.filter(
    (i) => i.type === 'Fixed Asset' && !fixedAssets.some((a) => a.inventoryId === i.id)
  )

  const preview = useMemo(() => {
    if (error) return null
    const rows = buildSchedule({ ...form, cost: Number(form.cost), salvage: Number(form.salvage), postedThrough: null })
    return {
      monthly: rows[0]?.charge || 0,
      last: rows[rows.length - 1],
      years: (Number(form.usefulLifeMonths) / 12).toFixed(1),
    }
  }, [form, error])

  const submit = () => {
    if (error) return
    capitaliseAsset(form, { post: !alreadyCarried, payFrom })
    onClose()
  }

  return (
    <Modal
      title="Capitalise Fixed Asset"
      subtitle={t('The depreciation schedule is generated the moment the acquisition is saved — no monthly calculation, and nothing to forget.')}
      size="2xl"
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
            <Plus size={14} /> {t('Capitalise')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Asset name">
          <TextInput value={form.name} onChange={set('name')} placeholder="e.g. Haze Machine (4 units)" />
        </Field>
        <Field label="Category">
          <TextInput value={form.category} onChange={set('category')} placeholder="Audio / Lighting / Staging" />
        </Field>
        <Field label="Acquisition date">
          <TextInput type="date" value={form.acquiredOn} onChange={set('acquiredOn')} />
        </Field>
        <Field label="Acquisition cost (Rp)">
          <NumberInput value={form.cost} onChange={set('cost')} min={0} step={1_000_000} />
        </Field>
        <Field label="Salvage / residual value (Rp)" hint={t('What it is expected to be worth at the end of its life')}>
          <NumberInput value={form.salvage} onChange={set('salvage')} min={0} step={1_000_000} />
        </Field>
        <Field label="Useful life (months)" hint={preview ? `${preview.years} ${t('years')}` : undefined}>
          <NumberInput value={form.usefulLifeMonths} onChange={set('usefulLifeMonths')} min={1} step={12} />
        </Field>
        <Field label="Method">
          <Select value={form.method} onChange={set('method')}>
            {METHODS.map((m) => <option key={m.key} value={m.key}>{t(m.label)} — {t(m.hint)}</option>)}
          </Select>
        </Field>
        <Field label="Linked warehouse item" hint={t('Optional — ties the register to physical stock')}>
          <Select value={form.inventoryId} onChange={set('inventoryId')}>
            <option value="">— {t('none')} —</option>
            {uncapitalised.map((i) => (
              <option key={i.id} value={i.id}>{i.id} · {i.item} ({i.qty} {i.unit})</option>
            ))}
          </Select>
        </Field>
      </div>

      {/* Whether this is new money leaving the business, or paperwork catching
          up with equipment the balance sheet already carries. Posting the
          acquisition twice would double account 1302. */}
      <div className="rounded-lg border border-white/10 bg-white/[0.02] p-3 space-y-2">
        <label className="flex items-start gap-2 text-sm text-white/75">
          <input
            type="checkbox"
            checked={alreadyCarried}
            onChange={(e) => setAlreadyCarried(e.target.checked)}
            className="mt-0.5 accent-gold"
          />
          <span>
            {t('Already carried in account 1302')}
            <span className="block text-[10px] text-white/35">
              {t('Tick this when registering equipment the books already hold — nothing will be posted.')}
            </span>
          </span>
        </label>
        {!alreadyCarried && (
          <Field label="Paid from">
            <Select value={payFrom} onChange={(e) => setPayFrom(e.target.value)}>
              {CASH_ACCOUNTS.map((c) => <option key={c} value={c}>{accountLabel(c)}</option>)}
              <option value="2102">{accountLabel('2102')}</option>
            </Select>
          </Field>
        )}
      </div>

      {preview && (
        <div className="rounded-lg border border-gold/25 bg-gold/[0.04] p-3 space-y-1.5 text-[11px]">
          <div className="flex items-center gap-1.5 text-gold-light mb-1">
            <CalendarClock size={13} /> <span className="font-medium">{t('Generated schedule')}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-white/40">{t('Monthly charge')}</span>
            <span className="text-white/85 tabular-nums">{money2(preview.monthly)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-white/40">{t('Periods scheduled')}</span>
            <span className="text-white/85 tabular-nums">{form.usefulLifeMonths}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-white/40">{t('Fully depreciated by')}</span>
            <span className="text-white/85">{formatDate(preview.last?.periodEnd)}</span>
          </div>
          <div className="flex justify-between gap-3">
            <span className="text-white/40">{t('Posts each period')}</span>
            <span className="text-white/85 font-mono text-[10px]">Dr 6103 / Cr 1303</span>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
// The full life of one asset, period by period.
// ---------------------------------------------------------------------------
// Correct what an asset is called, its category, its salvage value, or revise its life and method.
// Cost and what has already been posted are fixed (the acquisition entry evidences the cost); a revision
// to life or method applies from the next unposted period, so nothing already posted is restated.
function EditAssetModal({ asset, onClose }) {
  const updateAsset = useStore((s) => s.updateAsset)
  const t = useT()
  const [form, setForm] = useState({
    name: asset.name,
    category: asset.category || '',
    salvage: asset.salvage,
    usefulLifeMonths: asset.usefulLifeMonths,
    method: asset.method,
  })
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const error = validateAsset({ ...asset, ...form })
  const changed = Object.keys(form).some((k) => String(form[k]) !== String(asset[k] ?? ''))
  return (
    <Modal
      title={`Edit ${asset.id}`}
      subtitle={t('Cost and what has been posted are fixed. A new life or method applies from the next unposted period.')}
      size="xl"
      onClose={onClose}
      footer={
        <>
          {error && <span className="mr-auto inline-flex items-center gap-1.5 text-[11px] text-amber-300"><AlertTriangle size={12} /> {error}</span>}
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            onClick={async () => { await updateAsset(asset.id, form); onClose() }}
            disabled={Boolean(error) || !changed}
            className="btn-gold"
          >
            <Check size={14} /> {t('Save changes')}
          </button>
        </>
      }
    >
      <div className="grid sm:grid-cols-2 gap-3">
        <Field label="Asset name"><TextInput value={form.name} onChange={set('name')} /></Field>
        <Field label="Category"><TextInput value={form.category} onChange={set('category')} /></Field>
        <Field label="Cost (fixed)"><TextInput value={money2(asset.cost)} disabled /></Field>
        <Field label="Salvage value (Rp)"><NumberInput value={form.salvage} onChange={set('salvage')} min={0} /></Field>
        <Field label="Useful life (months)"><NumberInput value={form.usefulLifeMonths} onChange={set('usefulLifeMonths')} min={1} /></Field>
        <Field label="Method">
          <Select value={form.method} onChange={set('method')}>
            {METHODS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  )
}

function ScheduleModal({ asset, onClose }) {
  const disposeAsset = useStore((s) => s.disposeAsset)
  const role = useStore((s) => s.role)
  const t = useT()
  const rows = useMemo(() => buildSchedule(asset), [asset])
  const [proceeds, setProceeds] = useState(0)
  const [disposing, setDisposing] = useState(false)
  const [editing, setEditing] = useState(false)

  const due = rows.filter((r) => r.state === 'due')
  const nbv = netBookValue(asset)

  return (
    <Modal
      title={`${asset.id} · ${asset.name}`}
      subtitle={`${asset.category} · ${t('acquired')} ${formatDate(asset.acquiredOn)} · ${METHODS.find((m) => m.key === asset.method)?.label}`}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          {asset.status !== 'disposed' && (
            <div className="mr-auto flex flex-wrap items-center gap-2">
              {disposing ? (
                <>
                  <span className="text-[11px] text-white/50">{t('Proceeds')}</span>
                  <NumberInput
                    className="w-36 py-1.5"
                    value={proceeds}
                    onChange={(e) => setProceeds(e.target.value)}
                    min={0}
                    step={1_000_000}
                  />
                  <button
                    onClick={() => { disposeAsset(asset.id, { proceeds }); onClose() }}
                    className="btn-ghost text-xs py-1.5 border-rose-500/40 text-rose-300"
                  >
                    <Check size={13} /> {t('Confirm disposal')}
                  </button>
                  <button onClick={() => setDisposing(false)} className="text-xs text-white/40 hover:text-white">
                    {t('Cancel')}
                  </button>
                </>
              ) : (
                <ActionButton
                  action="manage_assets"
                  role={role}
                  onClick={() => setDisposing(true)}
                  className="btn-ghost text-xs py-1.5 border-rose-500/30 text-rose-300/80 disabled:opacity-30"
                  title={t('Remove the asset and its accumulated depreciation from the books')}
                >
                  <Archive size={13} /> {t('Dispose')}
                </ActionButton>
              )}
            </div>
          )}
          {asset.status !== 'disposed' && (
            <ActionButton action="manage_assets" role={role} onClick={() => setEditing(true)} className="btn-ghost text-xs py-1.5 disabled:opacity-30">
              {t('Edit')}
            </ActionButton>
          )}
          <button onClick={onClose} className="btn-gold">{t('Close')}</button>
        </>
      }
    >
      {editing && <EditAssetModal asset={asset} onClose={() => setEditing(false)} />}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg border border-white/10 bg-navy-900/80 p-3 text-[11px]">
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('At cost')}</span>
          <strong className="text-white/85 tabular-nums">{money2(asset.cost)}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Accumulated')}</span>
          <strong className="text-rose-300 tabular-nums">{money2(accumulatedFor(asset))}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Net book value')}</span>
          <strong className="text-gold-light tabular-nums">{money2(nbv)}</strong>
        </div>
        <div>
          <span className="block text-[9px] uppercase tracking-wider text-white/35">{t('Periods due')}</span>
          <strong className={due.length ? 'text-amber-300' : 'text-emerald-300'}>{due.length}</strong>
        </div>
      </div>

      <div className="overflow-x-auto max-h-[46vh]">
        <table className="w-full min-w-[520px] text-left">
          <thead className="sticky top-0 bg-navy-900">
            <tr className="border-b border-white/10 text-[9px] uppercase tracking-wider text-white/40">
              <th className="py-1.5 pr-2">{t('Period')}</th>
              <th className="py-1.5 px-2">{t('Posts on')}</th>
              <th className="py-1.5 px-2 text-right">{t('Opening NBV')}</th>
              <th className="py-1.5 px-2 text-right">{t('Charge')}</th>
              <th className="py-1.5 px-2 text-right">{t('Closing NBV')}</th>
              <th className="py-1.5 pl-2">{t('State')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5 text-[11px]">
            {rows.map((r) => (
              <tr key={r.period} className={r.state === 'due' ? 'bg-amber-500/[0.06]' : ''}>
                <td className="py-1.5 pr-2 font-mono text-white/70">{r.period}</td>
                <td className="py-1.5 px-2 text-white/40">{formatDate(r.periodEnd)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-white/50">{money2(r.opening)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-white/85">{money2(r.charge)}</td>
                <td className="py-1.5 px-2 text-right tabular-nums text-white/50">{money2(r.closing)}</td>
                <td className={`py-1.5 pl-2 uppercase text-[9px] tracking-wider ${STATE_STYLE[r.state]}`}>
                  {t(r.state)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-white/30">
        {t('Future periods are a projection, not journal entries — nothing hits the books until the period falls due and the run posts it.')}
      </div>

      {/* After a revision the table starts at the first unposted period, because
          the periods before it were posted at the old rate and are not being
          restated. Saying so beats a reader wondering where they went. */}
      {asset.scheduleFrom && (
        <div className="flex items-start gap-2 rounded-lg border border-sky-500/25 bg-sky-500/[0.05] p-2.5 text-[11px] text-sky-200/80">
          <CalendarClock size={13} className="shrink-0 mt-0.5" />
          <span>
            {t('This estimate was revised. Periods before')} {asset.scheduleFrom}{' '}
            {t('were posted at the previous rate and are not restated — the schedule below spreads the remaining')}{' '}
            {money2(asset.cost - asset.salvage - accumulatedFor(asset))} {t('over the life that is left.')}
          </span>
        </div>
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------
export default function FixedAssets() {
  const fixedAssets = useStore((s) => s.fixedAssets)
  const journal = useStore((s) => s.journal)
  const runDepreciation = useStore((s) => s.runDepreciation)
  const role = useStore((s) => s.role)
  const live = useStore((s) => s.hydrated)
  const t = useT()

  const [adding, setAdding] = useState(false)
  const [detail, setDetail] = useState(null)
  const [showDisposed, setShowDisposed] = useState(false)

  const totals = useMemo(() => registerTotals(fixedAssets), [fixedAssets])
  const visible = fixedAssets.filter((a) => showDisposed || a.status !== 'disposed')

  // The register is a sub-ledger; account 1302 net of 1303 is the control. If
  // they диverge someone has posted a fixed-asset entry by hand, which is worth
  // saying out loud rather than leaving to be discovered at year end.
  // Signed in, the two control balances come from the server's account tree; the browser's sum over
  // the journal is the demo's source and the cross-check.
  const balances = useReport('/accounts/tree', { includeInactive: true }, adaptAccountBalances, { enabled: live })
  const fromServer = live && balances.data
  const clientCost = accountBalance(journal, '1302')
  const clientAccum = -accountBalance(journal, '1303')
  const ledgerCost = fromServer ? (balances.data['1302'] ?? 0) : clientCost
  const ledgerAccum = fromServer ? -(balances.data['1303'] ?? 0) : clientAccum
  useCrossCheck('fixed assets: cost 1302', fromServer ? ledgerCost : null, clientCost)
  useCrossCheck('fixed assets: accumulated depreciation 1303', fromServer ? ledgerAccum : null, clientAccum)
  const reconciled = Math.abs(ledgerCost - totals.cost) < 1 && Math.abs(ledgerAccum - totals.accumulated) < 1

  return (
    <div className="animate-fade-up">
      <PageHeader
        eyebrow="Fixed Assets"
        title="Asset Register & Depreciation"
        subtitle="Every acquisition schedules its own depreciation to the end of its useful life. The run posts whatever has fallen due — the monthly charge is never calculated by hand and never missed."
        actions={
          <>
            <ActionButton
              action="manage_assets"
              role={role}
              onClick={runDepreciation}
              disabled={totals.overduePeriods === 0}
              className={`disabled:opacity-30 ${totals.overduePeriods > 0 ? 'btn-gold' : 'btn-ghost'}`}
            >
              <Play size={15} /> {t('Run Depreciation')}
            </ActionButton>
            <ActionButton action="manage_assets" role={role} onClick={() => setAdding(true)} className="btn-ghost disabled:opacity-30">
              <Plus size={15} /> {t('Capitalise Asset')}
            </ActionButton>
          </>
        }
      />

      {/* The backlog, stated plainly. This is the client's actual complaint. */}
      {totals.overduePeriods > 0 && (
        <Card className="mb-5 border-amber-500/40 bg-amber-500/[0.06]">
          <div className="flex flex-wrap items-center gap-4">
            <span className="grid h-11 w-11 place-items-center rounded-xl bg-amber-500/15 text-amber-300 shrink-0">
              <AlertTriangle size={20} />
            </span>
            <div className="flex-1 min-w-[220px]">
              <div className="text-sm font-medium text-amber-200">
                {totals.overduePeriods} {t('depreciation period(s) not yet recorded')}
              </div>
              <div className="text-[11px] text-amber-200/60 mt-0.5">
                {money2(totals.due)} {t('of expense is missing from the Income Statement until this is run.')}
              </div>
            </div>
            <ActionButton action="manage_assets" role={role} onClick={runDepreciation} className="btn-gold disabled:opacity-30">
              <Play size={15} /> {t('Post them now')}
            </ActionButton>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
        <Card>
          <div className="text-xs text-white/40">{t('Assets on register')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{totals.count}</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('At cost')}</div>
          <div className="mt-1 font-display text-xl text-white tabular-nums">{money2(totals.cost)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('account')} 1302</div>
        </Card>
        <Card>
          <div className="text-xs text-white/40">{t('Accumulated depreciation')}</div>
          <div className="mt-1 font-display text-xl text-rose-300 tabular-nums">{money2(totals.accumulated)}</div>
          <div className="text-[10px] text-white/30 mt-0.5">{t('account')} 1303</div>
        </Card>
        <Card className={reconciled ? 'border-gold/30' : 'border-rose-500/50'}>
          <div className="text-xs text-white/40">{t('Net book value')}</div>
          <div className="mt-1 font-display text-xl text-gold-light tabular-nums">{money2(totals.netBookValue)}</div>
          <div className={`mt-0.5 inline-flex items-center gap-1 text-[10px] ${reconciled ? 'text-emerald-300' : 'text-rose-300'}`}>
            {reconciled
              ? <><Check size={11} /> {t('Reconciled with the ledger')}</>
              : <><AlertTriangle size={11} /> {t('Register and ledger disagree')}</>}
          </div>
        </Card>
      </div>

      <SectionTitle
        icon={Boxes}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-white/35">
              {t('Next month')} <span className="tabular-nums text-white/70">{money2(totals.monthly)}</span>
            </span>
            <FilterPill active={showDisposed} onClick={() => setShowDisposed((v) => !v)}>
              {showDisposed ? t('Showing disposed') : t('Hiding disposed')}
            </FilterPill>
          </div>
        }
      >
        {t('Asset Register')}
      </SectionTitle>

      <TableWrap>
        <thead>
          <tr>
            <th className="th">{t('Asset')}</th>
            <th className="th">{t('Acquired')}</th>
            <th className="th">{t('Method / life')}</th>
            <th className="th text-right">{t('At cost')}</th>
            <th className="th text-right">{t('Accumulated')}</th>
            <th className="th text-right">{t('Net book value')}</th>
            <th className="th text-right">{t('Next charge')}</th>
            <th className="th"></th>
          </tr>
        </thead>
        <tbody>
          {visible.map((a) => {
            const due = duePeriods(a)
            const schedule = buildSchedule(a)
            const next = schedule.find((r) => r.state !== 'posted')
            const disposed = a.status === 'disposed'
            return (
              <tr
                key={a.id}
                onClick={() => setDetail(a)}
                className={`group cursor-pointer hover:bg-white/[0.03] transition-colors ${disposed ? 'opacity-45' : ''}`}
              >
                <td className="td">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-gold/80">{a.id}</span>
                    <span className="text-white/85">{a.name}</span>
                    {disposed && <Badge>Disposed</Badge>}
                    {!disposed && due.length > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-300">
                        <AlertTriangle size={9} /> {due.length} {t('due')}
                      </span>
                    )}
                  </div>
                  <div className="text-[10px] text-white/30">
                    {a.category}
                    {a.inventoryId && <> · <Landmark size={8} className="inline" /> {a.inventoryId}</>}
                  </div>
                </td>
                <td className="td text-white/50">{formatDate(a.acquiredOn)}</td>
                <td className="td text-white/60 text-xs">
                  {METHODS.find((m) => m.key === a.method)?.label}
                  <div className="text-[10px] text-white/30">{a.usefulLifeMonths} {t('months')}</div>
                </td>
                <td className="td text-right tabular-nums text-white/70">{money2(a.cost)}</td>
                <td className="td text-right tabular-nums text-rose-300/80">{money2(accumulatedFor(a))}</td>
                <td className="td text-right tabular-nums text-white">{money2(netBookValue(a))}</td>
                <td className="td text-right tabular-nums text-white/50">
                  {disposed || !next ? <span className="text-white/20">—</span> : (
                    <>
                      {money2(next.charge)}
                      <div className="text-[10px] text-white/30">{next.period}</div>
                    </>
                  )}
                </td>
                <td className="td text-right">
                  <ChevronRight size={14} className="inline text-white/20 group-hover:text-gold/70 transition-colors" />
                </td>
              </tr>
            )
          })}
          {!visible.length && (
            <tr><td className="td text-white/30" colSpan={8}>{t('No assets on the register yet.')}</td></tr>
          )}
        </tbody>
      </TableWrap>

      <div className="mt-3 flex flex-wrap items-start gap-2 text-[11px] text-white/30">
        <TrendingDown size={13} className="shrink-0 mt-0.5" />
        <span>
          {t('Each run posts one entry per period — debit Depreciation Expense, credit Accumulated Depreciation — with a line naming every asset in the charge. Click any asset to see its full schedule.')}
        </span>
      </div>

      {adding && <AssetModal onClose={() => setAdding(false)} />}
      {detail && (
        <ScheduleModal
          asset={fixedAssets.find((a) => a.id === detail.id) || detail}
          onClose={() => setDetail(null)}
        />
      )}
    </div>
  )
}
