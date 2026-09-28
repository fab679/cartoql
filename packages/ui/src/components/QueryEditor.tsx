import { useEffect, useMemo, useRef, useState } from 'react'
import { parse, print, type GraphQLSchema } from 'graphql'
import { caretCoordinates, prefixBeforeCaret } from '../utility/caret'
import { highlightDocument } from '../utility/highlight'
import { suggestionsAt, type Suggestion } from '../utility/suggest'

/**
 * Editor: gutter + highlighted overlay under a transparent-text textarea, plus
 * the schema-aware autocomplete popup (up/down/enter/tab/escape — playground
 * keyboard semantics). Prettify lives here too so ctrl+shift+enter feels native.
 */
export function QueryEditor({
  value,
  onChange,
  onSubmit,
  schema,
}: {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly onSubmit: () => void
  readonly schema: GraphQLSchema | null
}) {
  const gutterRef = useRef<HTMLPreElement>(null)
  const overlayRef = useRef<HTMLPreElement>(null)
  const viewRef = useRef<HTMLTextAreaElement>(null)
  const [popup, setPopup] = useState<{ top: number; left: number } | null>(null)
  const [filtered, setFiltered] = useState<readonly Suggestion[]>([])
  const [selected, setSelected] = useState(0)
  const [caret, setCaret] = useState(0)
  // playground keyboard contract: bare Enter NEVER accepts a suggestion — only
  // Enter after the user has navigated (ArrowUp/Down) selects. Without this,
  // typing "{" leaves the popup open and the next Enter swallows the newline
  // and inserts a suggestion instead (the reported "skips like tab" bug).
  const [navigated, setNavigated] = useState(false)

  const lineCount = useMemo(() => value.split('\n').length, [value])
  const highlighted = useMemo(() => highlightDocument(value), [value])

  useEffect(() => {
    if (popup === null) return
    const onDismiss = (): void => setPopup(null)
    window.addEventListener('click', onDismiss)
    return () => window.removeEventListener('click', onDismiss)
  }, [popup])

  const syncOverlayScroll = (): void => {
    if (overlayRef.current && viewRef.current && gutterRef.current) {
      const view = viewRef.current
      overlayRef.current.scrollTop = view.scrollTop
      overlayRef.current.scrollLeft = view.scrollLeft
      gutterRef.current.scrollTop = view.scrollTop
    }
  }

  const closePopup = (): void => {
    setPopup(null)
    setFiltered([])
    setSelected(0)
    setNavigated(false)
  }

  const refreshSuggestions = (text: string, caretIndex: number): void => {
    if (schema === null) { closePopup(); return }
    const head = text.slice(0, caretIndex)
    // suppress inside comments/strings
    const lineStart = head.lastIndexOf('\n') + 1
    if (head.slice(lineStart).trimStart().startsWith('#')) { closePopup(); return }
    const prefix = prefixBeforeCaret(head)
    // open only for a typed identifier prefix or an explicit call "("; a bare
    // "{" must NOT wake the popup up (that was half the skipping bug)
    if (prefix === '' && !/\($/.test(head.slice(-1))) { closePopup(); return }
    const all = suggestionsAt(text, caretIndex, schema)
    const matching = prefix !== '' || all.length > 0
      ? all.filter((s) => (prefix.trim() === '' ? true : s.label.toLowerCase().startsWith(prefix.toLowerCase())))
      : []
    if (matching.length === 0 || (matching.length === 1 && matching[0]!.label === prefix)) { closePopup(); return }
    const view = viewRef.current
    if (view === null) { closePopup(); return }
    const at = caretCoordinates(view, caretIndex)
    setPopup({ top: at.top + 20, left: at.left })
    setFiltered(matching.slice(0, 12))
    setSelected(0)
    setNavigated(false)
  }

  const acceptSuggestion = (suggestion: Suggestion): void => {
    const view = viewRef.current
    if (view === null) return
    const caretIndex = view.selectionStart
    const head = value.slice(0, caretIndex)
    const prefix = prefixBeforeCaret(head)
    if (prefix !== '') {
      const newContent = `${value.slice(0, caretIndex - prefix.length)}${suggestion.label}${value.slice(caretIndex)}`
      onChange(newContent)
      const offset = suggestion.label.length - prefix.length
      requestAnimationFrame(() => { view.selectionStart = caretIndex + offset; view.selectionEnd = caretIndex + offset })
    } else {
      onChange(`${value.slice(0, caretIndex)}${suggestion.label}${value.slice(caretIndex)}`)
      const at = caretIndex + suggestion.label.length
      requestAnimationFrame(() => { view.selectionStart = at; view.selectionEnd = at })
    }
    closePopup()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (popup !== null && filtered.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((s) => Math.min(s + 1, filtered.length - 1))
        setNavigated(true)
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((s) => Math.max(s - 1, 0))
        setNavigated(true)
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        acceptSuggestion(filtered[selected]!)
        return
      }
      if (event.key === 'Enter') {
        if (navigated) {
          event.preventDefault()
          acceptSuggestion(filtered[selected]!)
          return
        }
        // bare Enter: close and let the newline through
        closePopup()
        return
      }
      if (event.key === 'Escape') { closePopup(); event.preventDefault(); return }
      // structural punctuation closes the popup; typing must never fight it
      if (['{', '}', '(', ')', ':', ','].includes(event.key)) closePopup()
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      if (event.shiftKey) {
        event.preventDefault()
        try { onChange(print(parse(value))) } catch { /* prettify refused: document doesn't parse */ }
        return
      }
      event.preventDefault()
      onSubmit()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      const element = event.currentTarget
      const { selectionStart, selectionEnd } = element
      onChange(`${value.slice(0, selectionStart)}  ${value.slice(selectionEnd)}`)
      requestAnimationFrame(() => { element.selectionStart = selectionStart + 2; element.selectionEnd = selectionStart + 2 })
    }
  }

  const onSelection = (): void => {
    const view = viewRef.current
    if (view === null) return
    const at = view.selectionStart
    setCaret(at)
    if (popup !== null) refreshSuggestions(value, at)
  }

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden bg-ink">
      <div className="absolute inset-0 flex">
        <pre ref={gutterRef} aria-hidden="true" className="w-10 select-none overflow-hidden border-r border-line px-2 pb-3 text-right align-top text-paper-dim/70">
          {Array.from({ length: lineCount }, (_, i) => `${i + 1}`).join('\n')}
        </pre>
        <div className="relative min-h-0 min-w-0 flex-1">
          <pre ref={overlayRef} aria-hidden="true" className="editor-pre pointer-events-none absolute inset-0 overflow-hidden p-3 text-[12.5px] leading-relaxed">
            <code dangerouslySetInnerHTML={{ __html: `${highlighted}\n` }} />
          </pre>
          <textarea
            ref={viewRef}
            value={value}
            onChange={(e) => {
              onChange(e.target.value)
              const at = e.target.selectionStart
              setCaret(at)
              requestAnimationFrame(() => refreshSuggestions(e.target.value, at))
            }}
            onScroll={syncOverlayScroll}
            onKeyDown={onKeyDown}
            onSelect={onSelection}
            onClick={() => { if (popup !== null) closePopup() }}
            spellCheck={false}
            aria-label="GraphQL document editor"
            className="editor-text absolute inset-0 h-full w-full resize-none bg-transparent p-3 text-[12.5px] leading-relaxed outline-none"
          />
          {popup !== null && filtered.length > 0 ? (
            <ul
              className="absolute z-10 max-h-56 w-72 overflow-auto border border-line-2 bg-ink-2 shadow-lg shadow-black/40"
              style={{ top: Math.min(popup.top, 320), left: popup.left }}
              role="listbox"
              aria-label="autocomplete suggestions"
            >
              {filtered.map((suggestion, index) => (
                <li key={suggestion.label}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={index === selected}
                    onMouseDown={(e) => { e.preventDefault(); acceptSuggestion(suggestion) }}
                    className={`flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left ${index === selected ? 'bg-ink-3' : 'hover:bg-ink-3'}`}
                  >
                    <span className={suggestion.kind === 'field' ? 'text-paper' : suggestion.kind === 'enum' ? 'text-terrain' : 'text-brass'}>
                      {suggestion.label}
                    </span>
                    <span className="text-[10px] text-paper-dim">{suggestion.detail.slice(0, 26)}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <span hidden aria-live="polite">{filtered[selected]?.label ?? ''} caret {caret}</span>
    </div>
  )
}
