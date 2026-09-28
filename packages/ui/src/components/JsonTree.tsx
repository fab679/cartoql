import { useState, type JSX } from 'react'

/** Collapsible JSON tree with playroom carets (▾/▸), brand colors, one-click roots. */
function renderValue(value: unknown, keyString: string | null, depth: number): JSX.Element {
  if (value === null) return <span className="italic text-paper-dim">null</span>
  if (typeof value === 'string') return <span className="text-terrain">"{value}"</span>
  if (typeof value === 'number') return <span className="text-spec-red/90">{String(value)}</span>
  if (typeof value === 'boolean') return <span className="text-brass">{String(value)}</span>
  void keyString
  void depth
  throw new Error('unreachable — containers handled by caller')
}

function Node({ label, value, bold }: { readonly label: string | null; readonly value: unknown; readonly bold?: boolean }) {
  const [open, setOpen] = useState(true)
  const isContainer = value !== null && typeof value === 'object'
  const entries = isContainer ? Object.entries(value as Record<string, unknown>) : []
  const isEmpty = entries.length === 0
  return (
    <div className="leading-relaxed">
      <div className="flex items-start gap-1">
        {isContainer && !isEmpty ? (
          <button type="button" onClick={() => setOpen(!open)} aria-label={open ? 'collapse' : 'expand'} className="w-3 shrink-0 text-left text-paper-dim hover:text-brass">
            {open ? '▾' : '▸'}
          </button>
        ) : (
          <span className="w-3 shrink-0" />
        )}
        {label !== null ? <span className={bold ? 'text-brass' : 'text-brass'}>{label}</span> : null}
        {label !== null ? <span className="text-paper-dim">: </span> : null}
        {isContainer ? (
          isEmpty ? <span className="text-paper-dim">{Array.isArray(value) ? '[ ]' : '{ }'}</span> : (
            <span className="text-paper-dim">{Array.isArray(value) ? '[' : '{'}</span>
          )
        ) : (
          renderValue(value, label, 0)
        )}
      </div>
      {isContainer && open && !isEmpty ? (
        <div className="pl-4">
          {entries.map(([k, v]) => (
            <Node key={k} label={k} value={v} />
          ))}
          <span className="text-paper-dim">{Array.isArray(value) ? ']' : '}'}</span>
        </div>
      ) : null}
      {isContainer && !open && !isEmpty ? <span className="text-paper-dim">{Array.isArray(value) ? ']' : '}'}</span> : null}
    </div>
  )
}

export function JsonTree({ data }: { readonly data: unknown }) {
  return <div className="text-[12.5px]"><Node label={null} value={data} bold /></div>
}
