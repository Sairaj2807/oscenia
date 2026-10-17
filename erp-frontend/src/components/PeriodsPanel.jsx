// Accounting periods: which months are closed. A closed month refuses any entry dated inside it
// (the server says "Accounting period is closed"), so a month that has been reported on cannot
// quietly change. Closing posts nothing and moves no balances (retained earnings are an open
// question), and reopening just lets entries in again.
//
// Server only: the offline demo has no notion of a closed month, so it says so instead of pretending.
import { useCallback, useEffect, useState } from 'react'
import { Lock, LockOpen } from 'lucide-react'
import { Card, Badge, TableWrap } from './ui'
import { api } from '../lib/api'
import { useStore } from '../store/useStore'
import { appToday } from '../lib/format'
import { MONTH_NAMES, recentMonths, overlayPeriods } from '../lib/periods'
import { useT } from '../i18n'

export default function PeriodsPanel() {
  const t = useT()
  const live = useStore((s) => s.hydrated)
  const role = useStore((s) => s.role)
  const pushToast = useStore((s) => s.pushToast)
  const [rows, setRows] = useState(null)
  const [busy, setBusy] = useState(null) // "2026-9" while that month is being changed
  const [failed, setFailed] = useState(false)
  // The server allows these two roles (post_journal); the buttons are hidden for anyone else.
  const canClose = role === 'ceo' || role === 'finance'

  const load = useCallback(async () => {
    try {
      setRows(await api.get('/periods'))
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }, [])
  useEffect(() => { if (live) load() }, [live, load])

  if (!live) {
    return (
      <Card className="text-sm text-white/55">
        {t('Closing a period needs the server: signed out, this demo has no closed months, so any date can be posted to. Sign in to close or reopen a month.')}
      </Card>
    )
  }

  const change = async (m, action) => {
    const key = `${m.year}-${m.month}`
    setBusy(key)
    try {
      await api.post(`/periods/${m.year}/${m.month}/${action}`)
      await load()
      pushToast({
        title: action === 'close' ? 'Period closed' : 'Period reopened',
        body: `${MONTH_NAMES[m.month - 1]} ${m.year}`, kind: 'finance',
      })
    } catch (err) {
      pushToast({ title: action === 'close' ? 'Could not close the period' : 'Could not reopen the period', body: err.message, kind: 'redflag' })
    } finally {
      setBusy(null)
    }
  }
  const reopen = (m) => {
    if (!window.confirm(t('Reopen this month? Entries dated in it can be posted again, so reports already issued for it can change.'))) return
    change(m, 'reopen')
  }

  const list = overlayPeriods(recentMonths(appToday()), rows)
  return (
    <div className="space-y-4">
      <Card className="text-xs text-white/55">
        {t('A closed month refuses any entry dated inside it. Closing does not post anything or move balances, and reopening only lets entries in again.')}
      </Card>
      {failed && <Card className="border-rose-500/30 text-sm text-rose-200">{t('The periods could not be loaded. Try again shortly.')}</Card>}
      <TableWrap>
        <thead>
          <tr>
            <th className="th text-left">{t('Month')}</th>
            <th className="th text-left">{t('Status')}</th>
            <th className="th text-left">{t('Closed on')}</th>
            <th className="th"><span className="sr-only">{t('Action')}</span></th>
          </tr>
        </thead>
        <tbody>
          {list.map((m) => {
            const key = `${m.year}-${m.month}`
            return (
              <tr key={key} className="border-t border-white/5">
                <td className="td text-white/85">{t(MONTH_NAMES[m.month - 1])} {m.year}</td>
                <td className="td"><Badge>{m.closed ? 'Closed' : 'Open'}</Badge></td>
                <td className="td text-xs text-white/50">{m.closedAt ? String(m.closedAt).slice(0, 10) : '—'}</td>
                <td className="td text-right">
                  {canClose && (m.closed ? (
                    <button type="button" disabled={busy === key} onClick={() => reopen(m)} className="btn-ghost !py-1 text-xs">
                      <LockOpen size={13} />{t('Reopen')}
                    </button>
                  ) : (
                    <button type="button" disabled={busy === key} onClick={() => change(m, 'close')} className="btn-ghost !py-1 text-xs">
                      <Lock size={13} />{t('Close')}
                    </button>
                  ))}
                </td>
              </tr>
            )
          })}
        </tbody>
      </TableWrap>
    </div>
  )
}
