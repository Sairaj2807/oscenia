// A guest's table number as free text (round 4): "T1", "VIP-1", "Garden 3"… The browser offers
// the event's tables and every table already typed (a <datalist> the parent renders once); the
// value saves on blur or Enter, and Escape puts the saved one back.
//
// One input per guest: callers key it by guest id. When the guest changes under a half-typed
// table (the check-in desk scans the next QR code), the old input unmounts and saves what was
// typed for the guest it belonged to, instead of dropping it.
import { useEffect, useRef, useState } from 'react'
import { MAX_TABLE_LENGTH, pendingTable } from '../../lib/events'

export default function TableInput({ value = '', onSave, listId, className = '', ...rest }) {
  const [draft, setDraft] = useState(value)
  const cancelled = useRef(false)
  // Read by the unmount save below, which must see the latest draft, value and onSave.
  const live = useRef({ dirty: false })
  Object.assign(live.current, { draft, value, onSave })
  useEffect(() => { setDraft(value); live.current.dirty = false }, [value])
  useEffect(() => () => {
    const l = live.current
    if (!l.dirty) return
    l.dirty = false
    const next = pendingTable(l.draft, l.value)
    if (next != null) l.onSave(next)
  }, [])
  const commit = () => {
    live.current.dirty = false
    if (cancelled.current) { cancelled.current = false; setDraft(value); return }
    const next = pendingTable(draft, value)
    if (next != null) onSave(next)
    else setDraft(value)
  }
  return (
    <input
      value={draft}
      onChange={(e) => { live.current.dirty = true; setDraft(e.target.value) }}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur() }
        if (e.key === 'Escape') { cancelled.current = true; e.currentTarget.blur() }
      }}
      list={listId}
      maxLength={MAX_TABLE_LENGTH}
      placeholder="—"
      className={className}
      {...rest}
    />
  )
}

/** The suggestions one tab's table fields share. */
export function TableSuggestions({ id, tables }) {
  return <datalist id={id}>{tables.map((tb) => <option key={tb} value={tb} />)}</datalist>
}
