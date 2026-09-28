/** GraphQL token-coloring pass for the editor overlay. */
export function highlightDocument(text: string): string {
  const escaped = text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c] ?? c)
  const pattern =
    /("(?:[^"\\]|\\.)*")(\s*:)?|(#[^\n]*)|(\b(?:query|mutation|subscription|fragment|on)\b)|(\b\d+(?:\.\d+)?\b)|(\btrue\b|\bfalse\b|\bnull\b)/g
  let out = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(escaped)) !== null) {
    out += escaped.slice(last, match.index)
    if (match[1] && match[2]) out += `<span class="tk-key">${match[1]}${match[2]}</span>`
    else if (match[1]) out += `<span class="tk-string">${match[1]}</span>`
    else if (match[3]) out += `<span class="tk-comment">${match[3]}</span>`
    else if (match[4]) out += `<span class="tk-keyword">${match[4]}</span>`
    else if (match[5]) out += `<span class="tk-number">${match[5]}</span>`
    else out += `<span class="tk-null">${match[6]}</span>`
    last = pattern.lastIndex
  }
  out += escaped.slice(last)
  return out
}
