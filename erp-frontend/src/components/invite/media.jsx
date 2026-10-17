// Showing uploaded media (lib/mediaStore.js) in the invitation. A file in this browser (the demo)
// is looked up after the first paint — never during render — so server rendering and the first
// frame draw the fallback, then the file appears. A file on the server has a plain URL from its id,
// known at once; if the browser cannot load it, the tag's `onError` reports it missing. Old inline
// photos (data URLs) still show.
import { createContext, useContext, useEffect, useState } from 'react'
import { getMediaUrl, isLocalKey, isMediaRef } from '../../lib/mediaStore'
import { mediaUrl } from '../../lib/api'
import { safeImage } from '../../lib/events'

/** Which event an upload in this editor belongs to: `{ eventId }` (none in the demo or on a template). */
export const MediaScope = createContext({})
export const useMediaScope = () => useContext(MediaScope)

/** { url, missing, onError }: missing once we know the file cannot be shown; hand `onError` to the tag. */
export function useMediaUrl(ref) {
  const inline = typeof ref === 'string' ? safeImage(ref) || null : null
  const key = isMediaRef(ref) ? ref.key : null
  const local = key ? isLocalKey(key) : false
  const [found, setFound] = useState({ key: null, url: null })
  const [failed, setFailed] = useState(null)
  useEffect(() => {
    if (!key || !local) return undefined
    let live = true
    getMediaUrl(key).then((url) => { if (live) setFound({ key, url }) })
    return () => { live = false }
  }, [key, local])
  if (inline) return { url: inline, missing: false }
  if (!key) return { url: null, missing: false }
  if (!local) {
    const gone = failed === key
    return { url: gone ? null : mediaUrl(key), missing: gone, onError: () => setFailed(key) }
  }
  const known = found.key === key
  return { url: known ? found.url : null, missing: known && !found.url }
}

/** An uploaded photo, or `fallback` until (or unless) it loads. */
export function Img({ src, className = '', alt = '', fallback = null }) {
  const { url, onError } = useMediaUrl(src)
  return url ? <img src={url} alt={alt} className={className} onError={onError} /> : fallback
}
