// The state behind PostingModal, so each screen wires it the same way.
//
// `ask(path, body)` fetches the preview and opens the dialog; `confirm()` runs the real
// action and closes it. The screens keep their own action calls -- the hook only owns the
// question, never the answer, because every one of those actions does something different
// afterwards (routing, a toast, a row refresh).

import { useCallback, useState } from 'react'
import { useStore } from '../store/useStore'

export default function useConfirmPosting() {
  const previewPosting = useStore((s) => s.previewPosting)
  const hydrated = useStore((s) => s.hydrated)
  const [state, setState] = useState(null)

  // `editable` (round 4): the pop-up edits the posting. Live, it asks the server itself
  // (PostingModal's `live`), re-asking as the inputs change, so nothing is fetched here.
  const ask = useCallback(async (path, body = {}, { editable = false } = {}) => {
    // Open immediately, in a loading state. Waiting for the round trip before showing
    // anything reads as a dead button, which is the complaint this release keeps fixing.
    setState({ loading: true, preview: null, error: null })

    if (!hydrated) {
      // No server to ask: the pop-up works out the lines itself from lib/postings.js, the same
      // planners the store posts from, and lets them be edited (round 4).
      setState({ local: true })
      return
    }
    if (editable) {
      setState({ live: true })
      return
    }

    const result = await previewPosting(path, body)
    setState({
      loading: false,
      preview: result?.preview ?? null,
      error: result?.error ?? null,
    })
  }, [hydrated, previewPosting])

  const close = useCallback(() => setState(null), [])

  return { state, ask, close, busy: Boolean(state?.busy) }
}
