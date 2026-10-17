// A delivery order's drawn signature, for its PDF.
//
// The picture is never part of the order record and has no public URL: it is read through an
// authenticated request (`GET /delivery-orders/{id}/signature`) and turned into a data URL here, so
// jsPDF can embed it. Returns null when there is none (or this role may not read it), and the PDF is
// then printed with an empty signature line, as before.

import { request } from './api.js'

export async function fetchSignatureDataUrl(orderUuid) {
  try {
    const response = await request(`/delivery-orders/${orderUuid}/signature`, { raw: true })
    const blob = await response.blob()
    return await new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}
