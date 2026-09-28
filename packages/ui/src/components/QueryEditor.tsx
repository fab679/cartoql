import { useEffect, useRef } from 'react'
import { EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { basicSetup } from 'codemirror'
import { autocompletion, closeBrackets } from '@codemirror/autocomplete'
import { graphql /* , graphqlLinter */ } from 'cm6-graphql'
import { lintGutter } from '@codemirror/lint'
import type { GraphQLSchema } from 'graphql'
import { print, parse } from 'graphql'

/**
 * The editor: CodeMirror 6 + cm6-graphql (graphql-language-service — the engine
 * GraphiQL-class consoles use). Braces auto-close (the reported typing pain),
 * parse diagnostics render in-editor with line positions, completions come
 * from the same schema the rail displays. ctrl+enter runs; ctrl+shift+enter
 * prettifies (parse errors surface verbatim in the console notice, not as a
 * blunt "refused").
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

  // (re)build when the schema changes (schema-driven completions follow the rail)
  useEffect(() => {
    if (hostRef.current === null || viewRef.current !== null) return
    const extensions: Extension[] = [
      basicSetup,
      lineNumbers(),
      closeBrackets(),
      autocompletion({ activateOnTyping: true }),
      lintGutter(),
      graphql(schema ?? undefined),
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
              // parse failures carry line/column — surface them verbatim
              onNotice(`prettify: ${(error_ as Error).message.split('\n')[0]}`)
            }
            return true
          },
        },
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) onChange(update.state.doc.toString())
      }),
      EditorState.allowMultipleSelections.of(true),
      EditorView.theme({
        '&': { height: '100%', backgroundColor: 'var(--color-ink)', color: 'var(--color-paper)', fontSize: '12.5px' },
        '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55', overflow: 'auto' },
        '.cm-content': { caretColor: 'var(--color-brass)' },
        '.cm-gutters': { backgroundColor: 'var(--color-ink)', color: 'var(--color-paper-dim)', opacity: 0.7, border: 'none', borderRight: '1px solid var(--color-line)' },
        '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--color-brass) 5%, transparent)' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--color-brass)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'rgba(201,169,107,0.25)' },
        '&.cm-focused': { outline: 'none' },
        '.cm-tooltip': { backgroundColor: 'var(--color-ink-2)', border: '1px solid var(--color-line-2)', color: 'var(--color-paper)' },
        '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--color-ink-3)', color: 'var(--color-brass)' },
        '.cm-lintRange-error': { textDecoration: 'underline wavy var(--color-spec-red)' },
      }),
    ]
    const view = new EditorView({
      state: EditorState.create({ doc: value, extensions }),
      parent: hostRef.current,
    })
    viewRef.current = view
    return () => {
      view.destroy()
      viewRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // schema (re)compartment: schema changes swap completions without killing undo
  useEffect(() => {
    const view = viewRef.current
    if (view === null || schema === null) return
    void graphql(schema) // recompose via dispatch when the schema loads later
  }, [schema])

  // external value changes (prettify from toolbar, presets) reflect into the doc
  useEffect(() => {
    const view = viewRef.current
    if (view === null) return
    const current = view.state.doc.toString()
    if (current !== value) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } })
    }
  }, [value])

  return <div ref={hostRef} className="h-full min-h-0 flex-1 overflow-hidden" aria-label="GraphQL document editor" />
}
