import { useEffect, useMemo, useState } from 'react'
import Modal from '../components/Modal'
import { useParams, Link, useNavigate } from 'react-router-dom'
import {
  ArrowLeft, FileCheck2, MessageSquare, AtSign, Truck, Receipt, AlertTriangle, ExternalLink,
} from 'lucide-react'
import { useStore } from '../store/useStore'
import { canDo } from '../lib/roles'
import { useReport, useCrossCheck } from '../store/useReport'
import { adaptCostEntries } from '../store/reportAdapters'
import { useProto } from '../store/chatProto'
import { homeChannel } from '../lib/workspaceAccess'
import { MessageText } from '../components/chat/MessageParts'
import { STAGES, seedThreads, seedAssets } from '../store/seed'
import {
  Card, Badge, money, money2, pct2, PageHeader, TableWrap, SectionTitle,
} from '../components/ui'
import { projectCostEntries } from '../lib/ledger'
import { accountLabel, account } from '../lib/accounts'
import { poTotal, poPaid, poOutstanding, poVariance, projectVendorVariance } from '../lib/vendors'
import { dayCounter, daysUntil, daysSince, projectMargin } from '../lib/format'
import { useT } from '../i18n'
import SurveyLinkButton from '../components/SurveyLinkButton'

function renderText(text) {
  return text.split(/(@[A-Za-z.\s]+?(?=\s|$|\.))/).map((part, i) =>
    part.startsWith('@')
      ? <span key={i} className="text-gold-light">{part}</span>
      : <span key={i}>{part}</span>
  )
}

export default function ProjectDetail() {
  const { id } = useParams()
  const project = useStore((s) => s.projects.find((p) => p.id === id))
  // The project's main chat channel. Live, chat channels carry the project's business number
  // (`projectNo`), which is what this page's `id` is; the id string keeps the selection stable.
  const chatChannel = useProto((s) => (s.live
    ? homeChannel(s.channels.filter((c) => c.projectNo === id).map((c) => ({ ...c, projectId: id })), id)?.id
    : homeChannel(s.channels, id)?.id))
  const journal = useStore((s) => s.journal)
  const purchaseOrders = useStore((s) => s.purchaseOrders)
  const vendors = useStore((s) => s.vendors)
  const live = useStore((s) => s.hydrated)
  const role = useStore((s) => s.role)
  const setProjectPm = useStore((s) => s.setProjectPm)
  const updateProject = useStore((s) => s.updateProject)
  const [editingProject, setEditingProject] = useState(false)
  // Signed in, the itemised cost lines are the server's (W4); the demo reads its own journal.
  const costReport = useReport('/reports/project-costs', { projectId: project?.uuid }, adaptCostEntries, { enabled: live && Boolean(project?.uuid) })
  // Subscribes to the language so the figures below re-format on toggle.
  const t = useT()
  const navigate = useNavigate()

  // Signed in with a workspace persona, the thread is the project's chat and the files are its
  // tasks' attachments; the seeded fixtures belong to the signed-out demo and are never shown
  // to a real login. (The demo has no server, so `s.live` is only ever true for a real person.)
  const chatLive = useProto((s) => Boolean(s.live))
  const loadChannel = useProto((s) => s.loadChannel)
  const messages = useProto((s) => s.messages)
  const members = useProto((s) => s.members)
  const tasks = useProto((s) => s.tasks)
  const openAttachment = useProto((s) => s.openAttachment)
  useEffect(() => {
    if (chatLive && chatChannel && loadChannel) loadChannel(chatChannel)
  }, [chatLive, chatChannel, loadChannel])

  const thread = useMemo(() => {
    if (!chatLive) return (seedThreads[id] || []).map((c) => ({ ...c, rich: false }))
    if (!chatChannel) return []
    return messages
      .filter((m) => m.channelId === chatChannel && !m.deleted && !m.kind)
      .slice(-8)
      .map((m) => ({ by: members.find((x) => x.id === m.authorId)?.name || m.authorId, at: m.at, text: m.text, rich: true }))
  }, [chatLive, chatChannel, messages, members, id])

  const assets = useMemo(() => {
    if (!chatLive) return (seedAssets[id] || []).map((a) => ({ key: a.name, name: a.name, chip: a.version, by: a.by, at: a.at, badge: a.status }))
    return tasks
      .filter((tk) => tk.projectId === id)
      .flatMap((tk) => (tk.attachments || []).map((a) => ({
        key: `${tk.id}-${a.id}`, name: a.name, chip: a.kind, by: a.by, at: a.at, badge: tk.status, open: a.stored ? () => openAttachment(tk.id, a) : null,
      })))
  }, [chatLive, tasks, id, openAttachment])

  if (!project) {
    return (
      <div className="animate-fade-up">
        <Link to="/projects" className="btn-ghost mb-4"><ArrowLeft size={16} /> Back to board</Link>
        <Card>Project not found in this prototype’s seed data.</Card>
      </div>
    )
  }

  const stageIdx = STAGES.indexOf(project.stage)
  // Budget headroom: positive means still inside the estimate.
  const variance = project.estimatedCost - project.realizedCost

  // Vendors on this project, via the purchase orders raised against it. The
  // deck asked for a vendor list on the project; previously the POs existed but
  // were only visible from the Purchase Orders screen, so you could see THAT a
  // project spent money and not who on.
  const projectPos = purchaseOrders.filter((po) => po.project === project.id)
  const vendorRows = projectPos.map((po) => ({
    po,
    vendor: vendors.find((v) => v.id === po.vendorId),
    committed: poTotal(po),
    paid: poPaid(po),
    outstanding: poOutstanding(po),
  }))
  const totalCommitted = vendorRows
    .filter((r) => r.po.status !== 'Cancelled')
    .reduce((a, r) => a + r.committed, 0)
  const totalPaidToVendors = vendorRows.reduce((a, r) => a + r.paid, 0)
  // Gain/loss across everything settled on this project (slide 8).
  const vendorVariance = projectVendorVariance(purchaseOrders, project.id)

  // Individual cost postings — the "itemized costs" half of the same ask.
  const clientCostLines = projectCostEntries(journal, project.id)
  const costLines = (live && costReport.data) || clientCostLines
  useCrossCheck('Project cost lines total', costReport.data?.reduce((a, l) => a + l.amount, 0), clientCostLines.reduce((a, l) => a + l.amount, 0))
  const costTotal = costLines.reduce((a, l) => a + l.amount, 0)

  // Rollup by account, for a quick read before the line detail.
  const byAccount = costLines.reduce((acc, l) => {
    acc[l.account] = (acc[l.account] || 0) + l.amount
    return acc
  }, {})

  return (
    <div className="animate-fade-up">
      <Link to="/projects" className="inline-flex items-center gap-1.5 text-sm text-white/50 hover:text-white mb-4">
        <ArrowLeft size={16} /> Pipeline board
      </Link>

      <PageHeader
        eyebrow={project.id}
        title={project.name}
        subtitle={`${project.client} · Event ${project.eventDate}${project.pm ? ` · PM ${project.pm}` : ''}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs tabular-nums ${
              (daysUntil(project.eventDate) ?? 99) < 14
                ? 'border-amber-500/40 bg-amber-500/10 text-amber-300'
                : 'border-white/15 bg-white/5 text-white/70'
            }`}>
              {dayCounter(project.eventDate)} {'\u00b7'} {project.eventDate}
            </span>
            {project.stageSince && (
              <span className="inline-flex items-center rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/60 tabular-nums">
                {daysSince(project.stageSince)}d in stage
              </span>
            )}
            <Badge>{project.stage}</Badge>
            <SurveyLinkButton project={project} />
            {live && canDo(role, 'manage_workspace') && !project.cancelled && (
              <button type="button" onClick={() => setEditingProject(true)} className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs text-white/70 hover:text-white">Edit project</button>
            )}
            {live && canDo(role, 'manage_workspace') && (
              <select
                value={project.pmUserId || ''}
                onChange={(e) => setProjectPm(project.id, e.target.value)}
                title="Project manager"
                className="rounded-lg border border-white/15 bg-navy-900 px-2 py-1.5 text-xs text-white"
              >
                <option value="">PM: not set</option>
                {members.filter((m) => m.uuid).map((m) => <option key={m.uuid} value={m.uuid}>PM: {m.name}</option>)}
              </select>
            )}
          </div>
        }
      />

      {/* Milestone timeline */}
      <Card className="mb-4">
        <div className="eyebrow mb-4">Milestone Pipeline</div>
        <div className="flex flex-wrap gap-2">
          {STAGES.map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              <div className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${
                i < stageIdx ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                : i === stageIdx ? 'border-gold/50 bg-gold/15 text-gold-light'
                : 'border-white/10 text-white/40'
              }`}>
                <span className={`grid h-4 w-4 place-items-center rounded-full text-[9px] ${
                  i <= stageIdx ? 'bg-gold text-navy-950' : 'bg-white/10'
                }`}>{i + 1}</span>
                {s}
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Assets */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <FileCheck2 size={16} className="text-gold/70" />
            <div className="eyebrow">{chatLive ? 'Project files' : 'Central Assets · Version Control'}</div>
          </div>
          <div className="space-y-2">
            {assets.length ? assets.map((a) => (
              <div key={a.key} className="flex items-center gap-3 rounded-lg border border-white/5 bg-white/[0.02] px-3 py-2.5">
                <span className="grid h-8 min-w-8 px-1 place-items-center rounded bg-white/5 text-[10px] text-gold/70 font-mono">{a.chip}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-white truncate">{a.name}</div>
                  <div className="text-[11px] text-white/40">{a.by} · {a.at}</div>
                </div>
                <Badge>{a.badge}</Badge>
                {a.open && (
                  <button onClick={a.open} title="Open" className="text-white/50 hover:text-gold-light"><ExternalLink size={14} /></button>
                )}
              </div>
            )) : <div className="text-sm text-white/30">{chatLive ? 'No files attached to this project’s tasks yet.' : 'No assets uploaded yet.'}</div>}
          </div>
        </Card>

        {/* Threaded discussion */}
        <Card>
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare size={16} className="text-gold/70" />
            <div className="eyebrow">Threaded Discussion</div>
            <Link to={`/workspace/${project.id}`} className="ml-auto text-xs text-gold/80 hover:text-gold-light">
              {t('Task board')} →
            </Link>
            <Link to={chatChannel ? `/chat/${chatChannel}` : '/chat'} className="text-xs text-gold/80 hover:text-gold-light">
              {t('Team chat')} →
            </Link>
          </div>
          <div className="space-y-3">
            {thread.length ? thread.map((c, i) => (
              <div key={i} className="flex gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-white/10 text-[11px] font-medium text-white">
                  {String(c.by).split(' ').map((w) => w[0]).join('').slice(0, 3)}
                </span>
                <div className="min-w-0">
                  <div className="text-xs text-white/50">{c.by} · {c.at}</div>
                  <div className="text-sm text-white/85">
                    {c.rich ? <MessageText text={c.text} onOpenTask={() => navigate(`/workspace/${project.id}`)} /> : renderText(c.text)}
                  </div>
                </div>
              </div>
            )) : <div className="text-sm text-white/30">No comments yet.</div>}
          </div>
          <div className="mt-4 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2 text-sm text-white/30">
            <AtSign size={15} /> Mention a crew member…
          </div>
        </Card>
      </div>

      <Card className="mt-4">
        <div className="eyebrow mb-3">{t('Financial Snapshot')}</div>
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          <div><div className="text-xs text-white/40">Contract</div><div className="text-lg text-white tabular-nums">{money(project.contractValue)}</div></div>
          <div><div className="text-xs text-white/40">Est. Cost (budget)</div><div className="text-lg text-white tabular-nums">{money(project.estimatedCost)}</div></div>
          <div><div className="text-xs text-white/40">Realized Cost</div><div className="text-lg text-white tabular-nums">{money(project.realizedCost)}</div></div>
          <div>
            <div className="text-xs text-white/40">Variance</div>
            <div className={`text-lg tabular-nums ${variance >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
              {variance >= 0 ? money(variance) : `(${money(-variance)})`}
            </div>
          </div>
          <div>
            {/* Forecast margin until the project closes, actual once finished —
                consistent with the dashboard and P&L. */}
            <div className="text-xs text-white/40">Margin</div>
            <div className="text-lg text-emerald-400 tabular-nums">{pct2(projectMargin(project))}</div>
          </div>
        </div>
        <div className="mt-3 text-[11px] text-white/30">
          Realized cost is the sum of everything posted to this Project ID in the general ledger
          {'\u00a0'}({money2(project.realizedCost)}).
        </div>
      </Card>

      {/* Vendor list — who the money went to */}
      <SectionTitle icon={Truck}>{t('Vendors on this project')}</SectionTitle>
      {vendorRows.length ? (
        <>
          <TableWrap>
            <thead>
              <tr>
                <th className="th">{t('Vendor')}</th>
                <th className="th">PO</th>
                <th className="th">{t('Lines')}</th>
                <th className="th text-right">{t('Committed')}</th>
                <th className="th text-right">{t('Paid')}</th>
                <th className="th text-right">{t('Outstanding')}</th>
                <th className="th text-right">{t('Variance')}</th>
                <th className="th">{t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {vendorRows.map(({ po, vendor, committed, paid, outstanding }) => (
                <tr key={po.id} className={po.status === 'Cancelled' ? 'opacity-50' : ''}>
                  <td className="td">
                    <Link to={`/vendors/${po.vendorId}`} className="font-medium text-white hover:text-gold-light">
                      {vendor?.name ?? po.vendorId}
                    </Link>
                    <div className="text-[10px] text-white/35">{vendor?.category}</div>
                  </td>
                  <td className="td font-mono text-xs text-gold/80">{po.id}</td>
                  <td className="td text-white/65">
                    {(po.lines || []).map((l) => (
                      <div key={l.itemId} className="text-xs">{l.qty} × {l.item}</div>
                    ))}
                  </td>
                  <td className="td text-right tabular-nums">{money2(committed)}</td>
                  <td className="td text-right tabular-nums text-emerald-300">{money(paid)}</td>
                  <td className="td text-right tabular-nums">
                    <span className={outstanding > 0 ? 'text-amber-300' : 'text-white/40'}>
                      {outstanding > 0 ? money(outstanding) : '—'}
                    </span>
                  </td>
                  <td className="td text-right tabular-nums">
                    {(() => {
                      const v = poVariance(po)
                      if (v === null) return <span className="text-white/20">—</span>
                      if (v === 0) return <span className="text-white/45 text-xs">{t('at budget')}</span>
                      return (
                        <span className={v > 0 ? 'text-emerald-300' : 'text-rose-300'}>
                          {v > 0 ? `+${money(v)}` : `(${money(-v)})`}
                        </span>
                      )
                    })()}
                  </td>
                  <td className="td"><Badge>{po.status}</Badge></td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-white/15">
                <td className="td uppercase text-xs text-white/50" colSpan={3}>{t('Total')}</td>
                <td className="td text-right tabular-nums text-white font-medium">{money2(totalCommitted)}</td>
                <td className="td text-right tabular-nums text-emerald-300 font-medium">{money(totalPaidToVendors)}</td>
                <td className="td text-right tabular-nums text-amber-300">
                  {money(vendorRows.reduce((a, r) => a + r.outstanding, 0))}
                </td>
                <td className={`td text-right tabular-nums font-medium ${
                  vendorVariance > 0 ? 'text-emerald-300' : vendorVariance < 0 ? 'text-rose-300' : 'text-white/45'
                }`}>
                  {vendorVariance === 0
                    ? t('at budget')
                    : vendorVariance > 0 ? `+${money(vendorVariance)}` : `(${money(-vendorVariance)})`}
                </td>
                <td className="td"></td>
              </tr>
            </tfoot>
          </TableWrap>
          {/* Committed above the budget is worth saying out loud rather than
              leaving the reader to compare two numbers. */}
          {totalCommitted > project.estimatedCost && (
            <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/[0.06] px-3 py-1.5 text-[11px] text-rose-200">
              <AlertTriangle size={12} />
              {t('Committed to vendors exceeds the project budget by')} {money(totalCommitted - project.estimatedCost)}
            </div>
          )}
        </>
      ) : (
        <Card><span className="text-sm text-white/30">{t('No purchase orders raised against this project yet.')}</span></Card>
      )}

      {/* Itemised costs — the individual postings behind Realized Cost */}
      <SectionTitle icon={Receipt}>{t('Itemised costs')}</SectionTitle>
      {costLines.length ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-3">
            {Object.entries(byAccount)
              .sort((a, b) => b[1] - a[1])
              .map(([code, amount]) => (
                <Card key={code} className="py-3">
                  <div className="text-[10px] uppercase tracking-wider text-white/35 truncate">
                    {account(code).name}
                  </div>
                  <div className="mt-1 text-sm text-white tabular-nums">{money(amount)}</div>
                  <div className="text-[10px] text-white/30">
                    {costTotal ? pct2((amount / costTotal) * 100) : '—'}
                  </div>
                </Card>
              ))}
          </div>
          <TableWrap>
            <thead>
              <tr>
                <th className="th">{t('Date')}</th>
                <th className="th">{t('Entry')}</th>
                <th className="th">{t('Description')}</th>
                <th className="th">{t('Account')}</th>
                <th className="th text-right">{t('Amount')}</th>
              </tr>
            </thead>
            <tbody>
              {costLines.map((l, i) => (
                <tr key={`${l.entryId}-${i}`} className={l.reversed ? 'opacity-55' : ''}>
                  <td className="td text-white/50">{l.date}</td>
                  <td className="td font-mono text-xs text-gold/80">
                    {l.entryId}
                    {l.reversal && <Badge>Adjustment</Badge>}
                    {l.reversed && <Badge>Reversed</Badge>}
                  </td>
                  <td className="td text-white/75">
                    {l.memo}
                    {l.note && <div className="text-[10px] text-white/35">{l.note}</div>}
                  </td>
                  <td className="td text-white/55 text-xs">{accountLabel(l.account)}</td>
                  <td className={`td text-right tabular-nums ${l.amount < 0 ? 'text-emerald-300' : 'text-white/85'}`}>
                    {l.amount < 0 ? `(${money2(-l.amount)})` : money2(l.amount)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-white/15">
                <td className="td uppercase text-xs text-white/50" colSpan={4}>{t('Realized cost')}</td>
                <td className="td text-right tabular-nums text-white font-medium">{money2(costTotal)}</td>
              </tr>
            </tfoot>
          </TableWrap>
        </>
      ) : (
        <Card><span className="text-sm text-white/30">{t('Nothing has been posted against this project yet.')}</span></Card>
      )}
      {editingProject && <EditProjectModal project={project} onSave={updateProject} onClose={() => setEditingProject(false)} />}
    </div>
  )
}

/** Name, division and event date: the only things editable on a project (money, stage and client are
 *  tied to the quotation and the ledger). A new date moves the due dates of invoices not yet issued. */
function EditProjectModal({ project, onSave, onClose }) {
  const [form, setForm] = useState({ name: project.name || '', division: project.division || '', eventDate: project.eventDate || '' })
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const submit = async (e) => {
    e.preventDefault()
    const patch = {}
    if (form.name.trim() !== (project.name || '')) patch.name = form.name
    if (form.division.trim() !== (project.division || '')) patch.division = form.division
    if (form.eventDate && form.eventDate !== project.eventDate) patch.eventDate = form.eventDate
    if (!Object.keys(patch).length) return onClose()
    setBusy(true)
    const out = await onSave(project.id, patch)
    setBusy(false)
    if (out?.ok !== false) onClose()
  }
  return (
    <Modal title="Edit project" subtitle={project.id} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <label className="block"><span className="text-[11px] uppercase tracking-wider text-white/35">Name</span>
          <input value={form.name} onChange={set('name')} required className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" /></label>
        <label className="block"><span className="text-[11px] uppercase tracking-wider text-white/35">Division</span>
          <input value={form.division} onChange={set('division')} required className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" /></label>
        <label className="block"><span className="text-[11px] uppercase tracking-wider text-white/35">Event date</span>
          <input type="date" value={form.eventDate} onChange={set('eventDate')} className="mt-1 w-full rounded-lg border border-white/10 bg-navy-950 px-2.5 py-2 text-sm text-white/85 outline-none focus:border-gold/50" /></label>
        <p className="text-[11px] text-white/40">A new date moves the due dates of invoices not yet issued. Issued and paid invoices, and any invitation, are not changed.</p>
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className="btn-ghost text-xs" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-gold text-xs" disabled={busy}>Save</button>
        </div>
      </form>
    </Modal>
  )
}
