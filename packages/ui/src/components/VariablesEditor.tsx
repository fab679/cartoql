import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { EditorView as EV } from '@codemirror/view'
import { cmTheme } from './QueryEditor'

/**
 * The variables pane: CodeMirror with JSON syntax — the same engine and theme
 * as the document editor (braces auto-pair, lint shows malformed JSON with
 * line positions, undo history per pane). No graphql language here: it's a
 * JSON document surface.
 */
export function VariablesEditor({
  value,
  onChange,
  onSubmit,
}: {
  readonly value: string
 readonly onChange: (text: string) => void
  readonly onSubmit: () => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)

  useEffect(() => {
    if (hostRef.current === null || viewRef.current !== null) return
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          cmTheme,
          keymap.of([
            {
              key: 'Mod-Enter',
              preventDefault: true,
              run: () => {
                onSubmit()
                return true
              },
            },
          ]),
          EV.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString())
          }),
        ],
      }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full min-h-0 overflow-hidden" aria-label="query variables JSON editor" />
}
