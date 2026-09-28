import { useMemo, useState } from 'react'

/** The right rail: SCHEMA (types with fields/args/doctrines) or DOCS quick reference. */
/** A query skeleton prepared from a field's SDL line: required args only,
 * typed placeholders (ID!/String! → quoted, Int! → number) so what lands in
 * the editor is valid GraphQL on the first ctrl+enter. */
function skeletonFor(fieldLine: string): string {
  const nameMatch = /^\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\(/.exec(fieldLine)
  if (nameMatch === null) return `${fieldLine.trim()} {\n  \n}`
  const name = nameMatch[1]!
  const argsTextMatch = /\(([^)]*)\)/.exec(fieldLine)
  const args: string[] = []
  if (argsTextMatch !== null) {
    for (const piece of argsTextMatch[1]!.split(',')) {
      const arg = /^(\s*)([a-zA-Z][a-zA-Z0-9_]*)\s*:\s*([^\s]+)/.exec(piece)
      if (arg === null) continue
      void arg[1]
      const argName = arg[2]!
      const argType = arg[3]!
      if (!argType.includes('!')) continue // optional args stay out of the skeleton
      if (argType.startsWith('Int')) args.push(`${argName}: 20`)
      else args.push(`${argName}: "…"`)
    }
  }
  const call = args.length === 0 ? name : `${name}(${args.join(', ')})`
  return `query {\n  ${call} {\n    \n  }\n}`
}

export function RightRail({ sdl, onInsertQuery }: { readonly sdl: string; readonly onInsertQuery?: (query: string) => void }) {
  const [tab, setTab] = useState<'SCHEMA' | 'DOCS'>('SCHEMA')
  const [filter, setFilter] = useState('')

  const types = useMemo(() => {
    const sections: Array<{ kind: string; name: string; body: string; raw: string }> = []
    const lines = sdl.split('\n')
    let i = 0
    while (i < lines.length) {
      const header = lines[i]!
      const match = /^(type|interface|enum|scalar|directive)\s+(\w+)/.exec(header.trim())
      if (match !== null && match[1] !== 'directive') {
        const body: string[] = []
        while (i + 1 < lines.length && lines[i + 1]!.startsWith('  ')) {
          i += 1
          body.push(lines[i]!.trim())
        }
        sections.push({ kind: match[1]!, name: match[2]!, body: body.join('\n'), raw: body.join('\n') })
      }
      i += 1
    }
    return sections
  }, [sdl])

  const visible = types.filter(
    (t) => filter === '' || t.name.toLowerCase().includes(filter.toLowerCase()) || t.raw.toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <aside className="flex w-full shrink-0 flex-col border-l border-line bg-ink">
      <div className="flex border-b border-line text-[11px]">
        {(['SCHEMA', 'DOCS'] as const).map((name) => (
          <button
            key={name}
            type="button"
            onClick={() => setTab(name)}
            className={`min-w-[4rem] border-r border-line px-3 py-1.5 ${tab === name ? 'border-b-2 border-b-brass text-brass' : 'text-paper-dim hover:text-paper'}`}
          >
            {name}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'SCHEMA' ? (
          <>
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="filter types…"
              aria-label="filter schema types"
              className="m-2 border border-line bg-ink-2 px-2 py-1 text-[12px] outline-none focus:border-brass/50"
            />
            {visible.map((section) => (
              <details key={section.name} className="border-b border-line/60">
                <summary className="flex cursor-pointer items-baseline gap-2 px-3 py-1.5 hover:bg-ink-3 [&::-webkit-details-marker]:hidden">
                  <span className={section.kind === 'enum' ? 'text-terrain/80' : section.kind === 'interface' ? 'text-brass-dim' : 'text-paper-dim'}>
                    {section.kind.slice(0, 3)}
                  </span>
                  <span className="font-semibold text-paper">{section.name}</span>
                </summary>
                <div className="px-5 pb-2">
                  {section.body.split('\n').map((line) => {
                    const tokens = line.split(/(:\s)/)
                    const isRootField = section.name.includes('Query')
                    return (
                      <div key={line} className="flex items-baseline gap-1 text-[11.5px]">
                        <span className="text-terrain">{tokens[0]}</span>
                        <span className="text-paper-dim">{line.slice(tokens[0]!.length)}</span>
                        {isRootField && onInsertQuery !== undefined ? (
                          <button
                            type="button"
                            title="insert a query skeleton for this field"
                            onClick={() => onInsertQuery(skeletonFor(line))}
                            className="ml-auto border border-line px-1 text-[10px] text-brass hover:border-brass/60"
                          >
                            use
                          </button>
                        ) : null}
                      </div>
                    )
                  })}
                  {section.body.trim() === '' ? <span className="text-[11.5px] text-paper-dim">(no fields)</span> : null}
                </div>
              </details>
            ))}
          </>
        ) : (
          <div className="flex flex-col gap-3 p-3 font-sans text-[12px] leading-normal text-paper-dim">
            <div>
              <div className="mb-1 font-mono text-paper">keys</div>
              <div>ctrl+enter — run the document</div>
              <div>ctrl+shift+enter — prettify</div>
              <div>tab — two spaces; autocomplete: arrows + enter/tab</div>
            </div>
            <div>
              <div className="mb-1 font-mono text-paper">principals</div>
              <div>the request identity rides the x-cartoql-principal header — set any principal your gateway's claims resolve. Fields a principal can't access answer as nulls with typed codes (CQL_PERMISSION_DENIED), never silently.</div>
            </div>
            <div>
              <div className="mb-1 font-mono text-paper">security model</div>
              <div>fields typed <span className="text-brass">@requireGroup</span> deny with typed codes; entity gates hide existences; cursor pages are ordering-checked.</div>
            </div>
            <div>
              <div className="mb-1 font-mono text-paper">explain</div>
              <div>before running — POST /explain returns cost/depth/budget without executing; over-band documents answer CQL_QUERY_TOO_COMPLEX with the metric.</div>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
