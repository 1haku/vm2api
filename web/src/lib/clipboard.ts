// Clipboard API requires HTTPS; the control panel is also used on LAN HTTP.
export async function copyText(value: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return
    } catch {
      /* Try the HTTP-compatible path. */
    }
  }
  const previous = document.activeElement as HTMLElement | null
  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.style.cssText =
    'position:fixed;top:0;left:0;opacity:0;pointer-events:none'
  document.body.appendChild(input)
  try {
    input.focus()
    input.select()
    if (!document.execCommand('copy'))
      throw new Error('复制失败，请手动选择文本复制')
  } finally {
    input.remove()
    previous?.focus()
  }
}
