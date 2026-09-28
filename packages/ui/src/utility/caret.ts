/** Caret pixel coordinates via a mirror div — positions the autocomplete popup. */
export function caretCoordinates(
  textarea: HTMLTextAreaElement,
  caretIndex: number,
): { top: number; left: number } {
  const style = window.getComputedStyle(textarea)
  const mirror = document.createElement('div')
  Object.assign(mirror.style, {
    position: 'absolute',
    visibility: 'hidden',
    whiteSpace: 'pre-wrap',
    wordWrap: 'break-word',
    width: style.width,
    font: style.font,
    letterSpacing: style.letterSpacing,
    padding: style.padding,
    border: style.border,
    boxSizing: style.boxSizing,
    overflowWrap: 'break-word',
  })
  const preceding = document.createElement('span')
  mirror.textContent = textarea.value.slice(0, caretIndex)
  const caret = document.createElement('span')
  caret.textContent = '​'
  mirror.appendChild(caret)
  mirror.appendChild(preceding)
  document.body.appendChild(mirror)
  const at = { top: caret.offsetTop - textarea.scrollTop, left: caret.offsetLeft - textarea.scrollLeft }
  mirror.remove()
  return at
}

/** The identifier prefix before the caret on this line — what autocomplete completes. */
/** The identifier prefix at the end of the head slice — what autocomplete completes. */
export function prefixBeforeCaret(head: string): string {
  const match = /([A-Za-z_][A-Za-z0-9_]*)$/.exec(head)
  return match ? match[1]! : ''
}
