// CSV / Excel export.
//
// The deck asked for "Multi-format Data Export (PDF / Excel / CSV)". PDF is
// handled by lib/pdf.js via jsPDF. For the other two:
//
// CSV is written by hand rather than pulled from a library — it is a handful of
// escaping rules and a dependency would be hard to justify.
//
// "Excel" here is an .xls file containing an HTML table, which Excel and Sheets
// both open natively and which preserves column types well enough for a
// finance team to pivot. A real .xlsx needs a zip writer; if the client wants
// true xlsx, that is a library decision to make deliberately.

function csvCell(value) {
  if (value == null) return ''
  const s = String(value)
  // Quote if the value contains a delimiter, quote or newline; double interior
  // quotes. Leading = + - @ are prefixed with a quote so spreadsheets do not
  // interpret them as formulas.
  const risky = /^[=+\-@]/.test(s)
  const body = risky ? `'${s}` : s
  return /[",\n\r]/.test(body) ? `"${body.replace(/"/g, '""')}"` : body
}

/** Hands the browser a file to save. Call it from a click, never during render. */
export function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick so the click has definitely been handled.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

// `columns` is [{ key, label }]; `rows` is an array of plain objects.
export function exportCSV(filename, columns, rows, { title } = {}) {
  const lines = []
  if (title) lines.push(csvCell(title))
  lines.push(columns.map((c) => csvCell(c.label)).join(','))
  rows.forEach((r) => lines.push(columns.map((c) => csvCell(r[c.key])).join(',')))
  // BOM so Excel reads UTF-8 (Rp, en dashes) correctly on Windows.
  download(`${filename}.csv`, '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8')
}

function escapeHtml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export function exportExcel(filename, columns, rows, { title } = {}) {
  const head = columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${columns.map((c) => {
      const v = r[c.key]
      const numeric = typeof v === 'number'
      return `<td${numeric ? ' style="mso-number-format:\'#,##0.00\'"' : ''}>${escapeHtml(v)}</td>`
    }).join('')}</tr>`)
    .join('')

  const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel"><head>
<meta charset="utf-8" />
<style>
  table { border-collapse: collapse; font-family: Calibri, Arial, sans-serif; font-size: 11pt; }
  th { background: #0a1424; color: #e0c789; text-align: left; padding: 6px 10px; }
  td { padding: 5px 10px; border-bottom: 1px solid #ddd; }
  caption { text-align: left; font-weight: bold; padding-bottom: 8px; }
</style></head><body>
<table>${title ? `<caption>${escapeHtml(title)}</caption>` : ''}<thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>
</body></html>`

  download(`${filename}.xls`, html, 'application/vnd.ms-excel;charset=utf-8')
}
