// The vendor lifecycle (client round 2, V2): a board of where every supplier stands, from first
// contact to trading, plus the onboarding checklist that gates approval. The rules live in
// lib/vendors.js and are enforced by the store (useProto.setVendorStage); this file only shows
// them and asks.

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Ban, CheckCircle2, Circle, PauseCircle, RotateCcw } from 'lucide-react'
import { useStore } from '../store/useStore'
import { useProto } from '../store/useProto'
import { useVendorStages, useVendorEntry } from '../store/vendorStages'
import { useAuth } from '../store/useAuth'
import { FilterPill, Field, Rating } from './ui'
import Modal from './Modal'
import {
  VENDOR_STAGES, VENDOR_OFF_BOARD, VENDOR_STEP_LABEL, nextVendorStage, checklistFor, vendorStageOf, vendorKey,
  vendorStageError, resumeStageOf,
} from '../lib/vendors'
import { canDo } from '../lib/roles'
import { formatDate } from '../lib/format'
import { useT } from '../i18n'

const STAGE_TONE = {
  Prospect: 'border-white/15 text-white/70',
  Onboarding: 'border-sky-500/30 text-sky-200',
  Approved: 'border-gold/40 text-gold-light',
  Active: 'border-emerald-500/30 text-emerald-200',
  'On hold': 'border-amber-500/30 text-amber-200',
  Blacklisted: 'border-rose-500/40 text-rose-300',
}

export function VendorStageBadge({ stage }) {
  const t = useT()
  return (
    <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider ${STAGE_TONE[stage] || STAGE_TONE.Prospect}`}>
      {t(stage)}
    </span>
  )
}

const livePo = (purchaseOrders, vendorId) =>
  purchaseOrders.some((po) => po.vendorId === vendorId && po.status !== 'Draft' && po.status !== 'Cancelled')

/** One call site for every stage change, so each says why when it is refused. */
function useStageChange() {
  const t = useT()
  const role = useStore((s) => s.role)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const pushToast = useStore((s) => s.pushToast)
  const author = useAuth((s) => s.user?.name)
  const live = useStore((s) => s.hydrated)
  return (vendor, to, reason = '') => {
    // Signed in the server decides (and its own toast says why it refused); signed out the demo's rules apply.
    if (live) return useStore.getState().changeVendorStage(vendor, to, reason)
    const error = useProto.getState().setVendorStage(vendor, to, {
      role, by: author, reason, hasLivePo: livePo(purchaseOrders, vendor.id),
    })
    if (error) pushToast({ title: t('Not changed'), body: t(error), kind: 'redflag' })
    else pushToast({ title: `${vendor.name} · ${t(to)}`, body: reason ? reason : t('Vendor stage updated'), kind: 'project' })
    return !error
  }
}

/** Put on hold / blacklist: both need a reason, which stays on the vendor's record. */
function ReasonModal({ vendor, to, onClose }) {
  const t = useT()
  const change = useStageChange()
  const [reason, setReason] = useState('')
  return (
    <Modal
      title={`${t(to === 'Blacklisted' ? 'Blacklist' : 'Put on hold')} — ${vendor.name}`}
      subtitle={t(to === 'Blacklisted'
        ? 'A blacklisted vendor gets no new purchase orders, and has to be vetted again to come back.'
        : 'A vendor on hold gets no new purchase orders until it is reactivated.')}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button
            disabled={!reason.trim()}
            onClick={async () => { if (await change(vendor, to, reason)) onClose() }}
            className={to === 'Blacklisted' ? 'btn-ghost border-rose-500/40 text-rose-300 disabled:opacity-30' : 'btn-gold'}
          >
            {t(to === 'Blacklisted' ? 'Blacklist vendor' : 'Put on hold')}
          </button>
        </>
      }
    >
      <Field label="Reason" hint={t('Required — it stays on the vendor’s record.')}>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder={t('e.g. Late delivery on two events; awaiting a corrective plan')}
          className="w-full rounded-lg border border-white/10 bg-navy-900 px-3 py-2 text-sm text-white/85 outline-none focus:border-gold/50"
        />
      </Field>
      {/* Existing purchase orders are commitments already made; they carry on. */}
      <div className="text-[11px] text-white/40">{t('Purchase orders already issued are not affected.')}</div>
    </Modal>
  )
}

/** The onboarding checklist; hand-ticked items can be ticked while the vendor is being vetted. */
export function VendorChecklist({ vendor, compact = false }) {
  const t = useT()
  const role = useStore((s) => s.role)
  const live = useStore((s) => s.hydrated)
  const entry = useVendorEntry(vendor)
  const stage = entry?.stage || vendorStageOf(null, vendor.id)
  const list = checklistFor(vendor, entry)
  const editable = (stage === 'Prospect' || stage === 'Onboarding') && (canDo(role, 'request_po') || canDo(role, 'approve_po'))
  return (
    <ul className={compact ? 'space-y-0.5' : 'space-y-1.5'}>
      {list.items.map((item) => {
        const Icon = item.done ? CheckCircle2 : Circle
        const tickable = item.manual && !item.auto && editable
        return (
          <li key={item.key} className={`flex items-start gap-1.5 ${compact ? 'text-[11px]' : 'text-sm'}`}>
            {tickable ? (
              <button
                onClick={() => (live
                  ? useStore.getState().tickVendorCheck(vendor, item.key, !item.done)
                  : useProto.getState().toggleVendorCheck(vendorKey(vendor), item.key, role))}
                aria-pressed={item.done}
                aria-label={t(item.label)}
                className={`mt-0.5 shrink-0 ${item.done ? 'text-emerald-400' : 'text-white/30 hover:text-white/70'}`}
              >
                <Icon size={compact ? 12 : 15} />
              </button>
            ) : (
              <Icon size={compact ? 12 : 15} className={`mt-0.5 shrink-0 ${item.done ? 'text-emerald-400' : 'text-white/25'}`} />
            )}
            <span className={item.done ? 'text-white/75' : 'text-white/45'}>
              {t(item.label)}
              {!compact && item.manual && !item.auto && <span className="ml-1 text-[10px] text-white/30">· {t('tick when received')}</span>}
              {!compact && !item.manual && !item.done && <span className="ml-1 text-[10px] text-amber-300/70">· {t('fill in the vendor record')}</span>}
            </span>
          </li>
        )
      })}
    </ul>
  )
}

/** The buttons for a vendor's next move: forward one stage, hold, blacklist, reactivate. */
export function VendorStageActions({ vendor, size = 'sm' }) {
  const t = useT()
  const role = useStore((s) => s.role)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const entry = useVendorEntry(vendor)
  const stage = entry?.stage || vendorStageOf(null, vendor.id)
  const change = useStageChange()
  const [asking, setAsking] = useState(null)
  const canApprove = canDo(role, 'approve_po')
  const next = nextVendorStage(stage)
  const resume = stage === 'On hold' ? resumeStageOf(entry) : stage === 'Blacklisted' ? 'Onboarding' : null
  // Shown even when refused, so the reason is one click away rather than a missing button.
  const nextError = next && vendorStageError({
    from: stage, to: next, canApprove,
    checklistComplete: checklistFor(vendor, entry).complete,
    hasLivePo: livePo(purchaseOrders, vendor.id),
  })
  const text = size === 'sm' ? 'text-[11px]' : 'text-xs'
  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${text}`}>
      {next && (
        <button
          onClick={() => change(vendor, next)}
          aria-disabled={Boolean(nextError)}
          title={nextError ? t(nextError) : undefined}
          className={`inline-flex items-center gap-1 ${nextError ? 'text-white/30' : 'text-gold/85 hover:text-gold-light'}`}
        >
          {t(VENDOR_STEP_LABEL[next])}<ArrowRight size={11} />
        </button>
      )}
      {resume && (
        <button
          onClick={() => change(vendor, resume)}
          aria-disabled={!canApprove}
          title={canApprove ? undefined : t('Only finance or the CEO can reactivate a vendor.')}
          className={`inline-flex items-center gap-1 ${canApprove ? 'text-gold/85 hover:text-gold-light' : 'text-white/30'}`}
        >
          <RotateCcw size={11} />{t('Reactivate')} → {t(resume)}
        </button>
      )}
      {canApprove && stage !== 'On hold' && stage !== 'Blacklisted' && (
        <button onClick={() => setAsking('On hold')} className="inline-flex items-center gap-1 text-white/45 hover:text-amber-200">
          <PauseCircle size={11} />{t('Hold')}
        </button>
      )}
      {canApprove && stage !== 'Blacklisted' && (
        <button onClick={() => setAsking('Blacklisted')} className="inline-flex items-center gap-1 text-white/45 hover:text-rose-300">
          <Ban size={11} />{t('Blacklist')}
        </button>
      )}
      {asking && <ReasonModal vendor={vendor} to={asking} onClose={() => setAsking(null)} />}
    </div>
  )
}

function VendorCard({ vendor }) {
  const t = useT()
  const entry = useVendorEntry(vendor)
  const list = checklistFor(vendor, entry)
  const stage = entry?.stage || vendorStageOf(null, vendor.id)
  return (
    <div className="rounded-lg border border-white/10 bg-navy-900 p-2.5 text-sm" data-vendor={vendor.id}>
      <div className="flex items-baseline justify-between gap-2">
        <Link to={`/vendors/${vendor.id}`} className="truncate font-medium text-white hover:text-gold-light">{vendor.name}</Link>
        {vendor.score > 0 && <Rating value={vendor.score} />}
      </div>
      <div className="truncate text-[10px] text-white/40">{vendor.category}</div>
      {(stage === 'Prospect' || stage === 'Onboarding') && (
        <div className="mt-2">
          <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wider text-white/35">
            <span>{t('Onboarding checklist')}</span>
            <span className={list.complete ? 'text-emerald-300' : 'text-white/55'}>{list.done}/{list.total}</span>
          </div>
          <VendorChecklist vendor={vendor} compact />
        </div>
      )}
      {entry?.at && <div className="mt-1.5 text-[10px] text-white/30">{entry.by} · {formatDate(entry.at.slice(0, 10))}</div>}
      <div className="mt-2"><VendorStageActions vendor={vendor} /></div>
    </div>
  )
}

/** Signed in, finance and the CEO can make purchase orders refuse a vendor that is not Approved or Active. */
function EnforceToggle() {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const role = useStore((s) => s.role)
  const on = useStore((s) => s.enforceVendorStage)
  const set = useStore((s) => s.setEnforceVendorStage)
  if (!live || !canDo(role, 'approve_po')) return null
  return (
    <label className="mb-3 flex items-center gap-2 text-xs text-white/55">
      <input type="checkbox" checked={Boolean(on)} onChange={(e) => set(e.target.checked)} aria-label={t('Only Approved or Active vendors can be given a purchase order')} />
      {t('Only Approved or Active vendors can be given a purchase order')}
    </label>
  )
}

export default function VendorPipeline({ vendors }) {
  const t = useT()
  const stages = useVendorStages()
  const [showOff, setShowOff] = useState(false)
  const stageOf = (v) => vendorStageOf(stages, vendorKey(v))
  const off = vendors.filter((v) => VENDOR_OFF_BOARD.includes(stageOf(v)))
  return (
    <div>
      <EnforceToggle />
      <div className="-mx-1 overflow-x-auto pb-2">
        <div className="grid min-w-[960px] grid-cols-4 gap-3 px-1">
          {VENDOR_STAGES.map((stage) => {
            const items = vendors.filter((v) => stageOf(v) === stage)
            return (
              <div key={stage} className="flex flex-col rounded-xl border border-white/10 bg-white/[0.02]" data-vendor-stage={stage}>
                <div className="flex items-center justify-between border-b border-white/10 px-3 py-2 text-xs uppercase tracking-wider text-white/55">
                  <span>{t(stage)}</span>
                  <span className="rounded-full bg-white/10 px-2 text-[10px] text-white/70">{items.length}</span>
                </div>
                <div className="flex-1 space-y-2 p-2">
                  {items.map((v) => <VendorCard key={v.id} vendor={v} />)}
                  {items.length === 0 && (
                    <div className="px-1 py-4 text-center text-[11px] text-white/25">
                      {stage === 'Prospect' ? t('New vendors start here — use Add Vendor.') : t('Nothing here')}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      <div className="mt-3">
        <FilterPill active={showOff} onClick={() => setShowOff((v) => !v)}>{t('On hold & blacklisted')} · {off.length}</FilterPill>
        {showOff && (
          <div className="mt-2 space-y-1.5">
            {off.map((v) => (
              <div key={v.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm">
                <Link to={`/vendors/${v.id}`} className="font-medium text-white hover:text-gold-light">{v.name}</Link>
                <VendorStageBadge stage={stageOf(v)} />
                <span className="min-w-0 flex-1 truncate text-xs text-white/45">{stages?.[vendorKey(v)]?.reason}</span>
                <VendorStageActions vendor={v} />
              </div>
            ))}
            {off.length === 0 && <div className="text-xs text-white/35">{t('No vendors on hold or blacklisted.')}</div>}
          </div>
        )}
      </div>
    </div>
  )
}

/** The stage history, newest first (VendorDetail). */
export function VendorStageHistory({ vendorId }) {
  const t = useT()
  const entry = useVendorStages()?.[vendorId]
  const rows = [...(entry?.history || [])].reverse().filter((h) => h.at)
  if (!rows.length) return <div className="text-sm text-white/30">{t('No stage changes recorded yet.')}</div>
  return (
    <ol className="space-y-1.5">
      {rows.map((h, i) => (
        <li key={i} className="flex flex-wrap items-baseline gap-2 text-xs">
          <VendorStageBadge stage={h.stage} />
          <span className="text-white/45">{formatDate(h.at.slice(0, 10))} · {h.by}</span>
          {h.reason && <span className="text-white/60">— {h.reason}</span>}
        </li>
      ))}
    </ol>
  )
}

