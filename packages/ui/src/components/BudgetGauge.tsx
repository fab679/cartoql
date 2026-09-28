import type { Explain } from '../api'

/**
 * Budget gauge: a drawn arc against the cost band (docs/08) — the explain
 * readout makes cost preview literal rather than a single number.
 */
export function BudgetGauge({ explain }: { readonly explain: Explain }) {
  const maxCost = explain.budgets?.maxCost ?? 2500
  const fraction = Math.min(1, explain.cost / maxCost)
  const over = fraction >= 1
  const R = 18
  const C = Math.PI * R
  const verdict = over ? <span className="text-spec-red">over budget</span> : <span className="text-terrain">within budget</span>
  return (
    <div className="flex items-start gap-2">
      <svg viewBox="0 0 48 26" width="48" height="26" aria-hidden="true">
        <path d="M 5 23 A 18 18 0 0 1 43 23" fill="none" stroke="var(--color-line)" strokeWidth="3" strokeLinecap="round" pathLength={C} />
        <path
          d="M 5 23 A 18 18 0 0 1 43 23"
          fill="none"
          stroke={over ? 'var(--color-spec-red)' : 'var(--color-brass)'}
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={`${fraction * C} ${C}`}
          pathLength={C}
        />
      </svg>
      <div className="flex flex-col gap-0.5 text-[11px] leading-tight">
        <div>
          cost <span className="font-semibold text-paper">{explain.cost}</span>
          <span className="text-paper-dim"> / {maxCost}</span> — {verdict}
        </div>
        {over ? <div className="text-paper-dim">narrow the selection or paginate to fit the band</div> : null}
        <div className="text-paper-dim">
          depth {explain.depth} · nodes {explain.nodeCount}
        </div>
      </div>
    </div>
  )
}
