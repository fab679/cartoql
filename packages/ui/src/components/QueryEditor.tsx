import { useEffect, useRef } from 'react'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { graphql } from 'cm6-graphql'
import { lintGutter } from '@codemirror/lint'
import type { GraphQLSchema } from 'graphql'
import { print, parse } from 'graphql'

/** The shared ink-brass theme for every CodeMirror surface. */
export const cmTheme = EditorView.theme({
  '&': { height: '100%', backgroundColor: 'var(--color-ink)', color: 'var(--color-paper)', fontSize: '12.5px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--color-brass)' },
  '.cm-gutters': {
    backgroundColor: 'var(--color-ink)', color: 'var(--color-paper-dim)', opacity: 0.75,
    border: 'none', borderRight: '1px solid var(--color-line)', minWidth: '2em',
  },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-brass) 5%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-brass)' },
  '.cm-selectionBackground': { backgroundColor: 'rgba(201,169,107,0.25)' },
  '.cm-focused': { outline: 'none' },
  '.cm-tooltip': {
    backgroundColor: 'var(--color-ink-2)', border: '1px solid var(--color-line-2)', borderRadius: '2px',
    boxShadow: '0 4px 12px rgba(0,0,0,0.4)', maxWidth: '400px', zIndex: '100',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--color-ink-3)', color: 'var(--color-brass)',
  },
  '.cm-tooltip-autocomplete ul li': {
    padding: '3px 8px', display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
    gap: '12px', cursor: 'pointer',
  },
  '.cm-completionIcon': { display: 'none' },
  '.cm-completionLabel': { color: 'var(--color-paper)', fontFamily: 'var(--font-mono)', fontSize: '11.5px' },
  '.cm-completionDetail': {
    color: 'var(--color-paper-dim)', fontSize: '10px', fontFamily: 'var(--font-mono)', opacity: 0.8,
  },
})

/**
 * The query console editor: CodeMirror 6 driven by cm6-graphql (the
 * graphql-language-service engine) — schema-aware completions open on
 * identifier prefixes and inside parens; in-editor lint marks parse errors and
 * validation mismatches with line positions. The schema re-registers through
 * a Compartment whenever /sdl changes, without killing undo history.
 * ctrl+enter runs; ctrl+shift+enter prettifies.
 */
export function QueryEditor({
  value,
  onChange,
  onSubmit,
  onNotice,
  schema,
}: {
  readonly value: string
  readonly onChange: (text: string) => void
  readonly onSubmit: () => void
  readonly onNotice: (message: string | null) => void
  readonly schema: GraphQLSchema | null
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const schemaComp = useRef(new Compartment())

  useEffect(() => {
    if (hostRef.current === null || viewRef.current !== null) return
    const state = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        closeBrackets(),
        autocompletion({ activateOnTyping: true, maxRenderedOptions: 20 }),
        lintGutter(),
        schemaComp.current.of(schema !== null ? [graphql(schema)] : []),
        keymap.of([
          {
            key: 'Mod-Enter',
            preventDefault: true,
            run: () => {
              onSubmit()
              return true
            },
          },
          {
            key: 'Mod-Shift-Enter',
            preventDefault: true,
            run: (view) => {
              try {
                const text = view.state.doc.toString()
                view.dispatch({ changes: { from: 0, to: text.length, insert: print(parse(text)) } })
                onNotice(null)
              } catch (error_) {
                onNotice(`prettify: ${(error_ as Error).message.split('\n').slice(0, 2).join(' ')}`)
              }
              return true
            },
          },
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) onChange(update.state.doc.toString())
        }),
        cmTheme,
      ],
    })
    const view = new EditorView({ state, parent: hostRef.current })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // swap the schema through the Compartment — working documents keep history
  useEffect(() => {
    const view = viewRef.current
    const compartment = schemaComp.current
    if (view === null || compartment === null) return
    const newSchema = schema
    const effective = newSchema !== null ? [graphql(newSchema)] : []
    view.dispatch({ effects: compartment.reconfigure(effective) })
  }, [schema])

  // external document changes (prettify from toolbar) sync into the doc
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return (
    <div
      ref={hostRef}
      className="h-full min-h-0 flex-1 overflow-hidden border-t border-line bg-ink"
      aria-label="GraphQL document editor"
    />
  )
}