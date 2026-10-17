import { useMemo, useState } from 'react'
import { AlertTriangle, HandCoins } from 'lucide-react'
import { useStore } from '../store/useStore'
import { money2, Field, NumberInput } from './ui'
import Modal from './Modal'
import { PostingEditor, usePostingDraft, BalanceBadge, CLIENT_DATES, settlePost } from './PostingModal'
import { planReceivePayment } from '../lib/postings'
import { CLIENT_MONEY, paymentBody } from '../lib/apiPostings'
import { useT } from '../i18n'

// What is still owed on an invoice. Exported because the AR ageing, the Finance
// invoice table and this form all have to agree on it.
export const outstandingOf = (inv) => inv.amount - (inv.paid || 0)

// ---------------------------------------------------------------------------
// Record a client payment.
//
// Client issue #1 was that receivable balances never updated on settlement. The
// cause was blunter than a broken trigger: there was no way to record a payment
// at all. This is that missing action — and it is also where the client's
// "automated tax calculation validation ... to prevent manual number input
// errors by accounting staff" lives.
//
// Round 4: the journal entry is shown and editable before it posts (PostingEditor) — the two
// dates, the account, the withholding and the lines — guarded by lib/postings.js.
// ---------------------------------------------------------------------------
export default function ReceivePaymentModal({ invoice, onClose }) {
  const receivePayment = useStore((s) => s.receivePayment)
  const taxConfig = useStore((s) => s.taxConfig)
  const projects = useStore((s) => s.projects)
  // Subscribed so the receipt re-plans if the invoice's recognition entry changes.
  const journal = useStore((s) => s.journal)
  const hydrated = useStore((s) => s.hydrated)
  const t = useT()
  const [busy, setBusy] = useState(false)

  const outstanding = outstandingOf(invoice)
  const [amount, setAmount] = useState(outstanding)
  const gross = Math.min(Math.round(Number(amount) || 0), outstanding)
  const project = projects.find((p) => p.id === invoice.project)
  const recognitionId = useMemo(() => useStore.getState()._recognitionFor(invoice.id)?.id ?? null, [journal, invoice.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // The client asked for validation, so the pop-up states the identity it enforces — cash
  // plus tax equals the receivable cleared — as a live balanced badge and a locked 1201 line.
  const draft = usePostingDraft(
    (inputs) => planReceivePayment({ invoice, taxConfig, projectName: project?.name, recognitionId }, { ...inputs, amount: gross }),
    { withhold: taxConfig?.pph23?.active !== false },
    // Live: the lines are the server's dry-run of this payment, re-asked as the amount changes.
    hydrated && invoice.uuid
      ? { path: `/invoices/${invoice.uuid}/payments`, body: (ask) => paymentBody(gross, ask), flow: CLIENT_MONEY }
      : null,
  )
  const partial = gross > 0 && gross < outstanding
  const valid = gross > 0 && draft.check.ok && !busy

  const submit = () => {
    if (!valid) return
    const out = receivePayment(invoice.id, { amount: gross, edited: draft.edited })
    if (hydrated) {
      // Stays open until the server answers; a refusal is shown here rather than lost.
      settlePost(out, draft, setBusy).then((res) => { if (res?.ok) onClose() })
      return
    }
    onClose()
  }

  return (
    <Modal
      title={`Receive Payment — ${invoice.id}`}
      subtitle={`${project?.client || invoice.project} · ${t('outstanding')} ${money2(outstanding)}`}
      size="2xl"
      onClose={onClose}
      footer={
        <>
          <BalanceBadge draft={draft} />
          <button onClick={onClose} className="btn-ghost">{t('Cancel')}</button>
          <button onClick={submit} disabled={!valid} className="btn-gold" data-post>
            <HandCoins size={14} /> {partial ? t('Record part payment') : t('Settle invoice')}
          </button>
        </>
      }
    >
      <Field label="Amount received (gross)" hint={`${t('Maximum')} ${money2(outstanding)}`}>
        <NumberInput value={amount} onChange={(e) => setAmount(e.target.value)} min={0} max={outstanding} step={1_000_000} />
      </Field>
      {partial && (
        <div className="inline-flex items-center gap-1.5 text-[11px] text-amber-300">
          <AlertTriangle size={12} />
          {t('Part payment —')} {money2(outstanding - gross)} {t('will remain outstanding')}
        </div>
      )}

      <PostingEditor draft={draft} dateLabels={CLIENT_DATES} />

      <div className="text-[10px] text-white/40">
        {t('The receivable clears at GROSS. Tax withheld at source is an asset — it is money already paid to the tax office on Oscenia’s behalf, creditable against corporate tax.')}
      </div>
    </Modal>
  )
}
