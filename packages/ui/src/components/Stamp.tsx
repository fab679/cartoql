import type { GraphQLErrorEntry } from '../api'

/** A survey stamp: record metadata and typed denials, never decorative. */
export function Stamp({
  label,
  value,
  tone = 'paper',
}: {
  readonly label: string
  readonly value: string
  readonly tone?: 'paper' | 'brass' | 'terrain' | 'red'
}) {
  const toneClass =
    tone === 'brass'
      ? 'border-brass/60 text-brass'
      : tone === 'terrain'
        ? 'border-terrain/60 text-terrain'
        : tone === 'red'
          ? 'border-spec-red/60 text-spec-red'
          : 'border-line-2 text-paper-dim'
  return (
    <span className={`stamp-tilt inline-flex items-baseline gap-1.5 border px-2 py-0.5 text-[11px] ${toneClass}`}>
      <span className="uppercase tracking-0.08em opacity-70">{label}</span>
      <span className="font-semibold">{value}</span>
    </span>
  )
}

/** Denial stamps: the visible security track, codes are the contract. */
export function DenialStamps({ errors }: { readonly errors: readonly GraphQLErrorEntry[] }) {
  if (errors.length === 0) return null
  const byCode = new Map<string, { count: number; label: string }>()
  for (const error of errors) {
    const code = error.extensions?.code
    const label = code ?? 'UNKNOWN'
    const entry = byCode.get(label)
    if (entry) entry.count += 1
    else byCode.set(label, { count: 1, label })
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {[...byCode.values()].map((entry) => (
        <Stamp
          key={entry.label}
          label={`${entry.label}${entry.count > 1 ? ` ×${entry.count}` : ''}`}
          value="denied"
          tone="red"
        />
      ))}
      <span className="text-[11px] text-paper-dim">
        {errors[0]?.path !== undefined ? `fields: ${[...new Set(errors.map((e) => e.path))].join(', ')}` : null}
      </span>
    </div>
  )
}
