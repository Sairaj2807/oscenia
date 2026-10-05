// Stops a <video> downloading. Taking one off the page doesn't reliably do
// that: Chrome can keep streaming a detached film, and on a slow connection
// Home's large films then crowd out the next page's poster. Clearing the
// source and calling load() aborts the request.
export default function releaseVideo(video) {
  if (!video || video.tagName !== 'VIDEO') return
  try {
    video.pause()
    video.removeAttribute('src')
    video.querySelectorAll('source').forEach((s) => s.remove())
    video.load()
  } catch {
    /* already gone */
  }
}
