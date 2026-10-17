// Shrinking an image in the browser before the prototype keeps it: localStorage holds only a
// few MB for the whole demo. Used by the invitation builder (hero photo) and by task
// attachments (a small preview).

/**
 * Reads an image file and returns a JPEG data URL, scaled down so its width is at most
 * `maxWidth` — or, with `maxSide`, so its longest side is. Rejects with a message people can
 * read when the file is not an image or is still larger than `maxBytes`.
 */
export function shrinkImage(file, { maxWidth = 1200, maxSide = null, maxBytes = 700_000, quality = 0.8 } = {}) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.onload = () => {
      const img = new Image()
      img.onerror = () => reject(new Error('That file is not an image we can use.'))
      img.onload = () => {
        const scale = maxSide ? Math.min(1, maxSide / Math.max(img.width, img.height)) : Math.min(1, maxWidth / img.width)
        const canvas = document.createElement('canvas')
        canvas.width = Math.max(1, Math.round(img.width * scale))
        canvas.height = Math.max(1, Math.round(img.height * scale))
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        const data = canvas.toDataURL('image/jpeg', quality)
        if (data.length > maxBytes) reject(new Error('That photo is too large even after resizing. Try a smaller one.'))
        else resolve(data)
      }
      img.src = reader.result
    }
    reader.readAsDataURL(file)
  })
}

/** A file as a data URL, unchanged. */
export function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('Could not read the file.'))
    reader.onload = () => resolve(reader.result)
    reader.readAsDataURL(file)
  })
}
