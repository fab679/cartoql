/**
 * @verax/core — budget enforcement (docs/08; threat T3's mitigation made live).
 *
 * Cost was already computed and snapshot-pinned; this module turns it into a
 * gate. Rejection is pre-execution and typed — VX_QUERY_TOO_COMPLEX with the
 * offending metric and the limit in the error, never a truncated result set
 * and never a hung request answered partially.
 */
import { planDepth, planNodeCount, type Plan } from './ir.js'

export class BudgetError extends Error {
  readonly code = 'VX_QUERY_TOO_COMPLEX'
  readonly metric: 'cost' | 'depth' | 'nodes'
  readonly value: number
  readonly limit: number

  constructor(metric: BudgetError['metric'], value: number, limit: number) {
    super(`VX_QUERY_TOO_COMPLEX: plan ${metric} ${value} exceeds limit ${limit} — narrow the selection or paginate`)
    this.name = 'BudgetError'
    this.metric = metric
    this.value = value
    this.limit = limit
  }
}

export interface BudgetLimits {
  readonly maxCost?: number
  readonly maxDepth?: number
  readonly maxNodes?: number
}

/** docs/08 defaults: cost cap, depth cap, algebra node cap (hard at 2,500). */
export const DEFAULT_BUDGETS: Required<BudgetLimits> = Object.freeze({
  maxCost: 2_500,
  maxDepth: 16,
  maxNodes: 2_500,
})

/** Complex documents reject HERE, before any adapter sees them. */
export function enforceBudgets(plan: Plan, limits: BudgetLimits = DEFAULT_BUDGETS): void {
  const maxCost = limits.maxCost ?? DEFAULT_BUDGETS.maxCost
  const maxDepth = limits.maxDepth ?? DEFAULT_BUDGETS.maxDepth
  const maxNodes = limits.maxNodes ?? DEFAULT_BUDGETS.maxNodes
  if (plan.cost > maxCost) throw new BudgetError('cost', plan.cost, maxCost)
  if (planDepth(plan) > maxDepth) throw new BudgetError('depth', planDepth(plan), maxDepth)
  const nodes = planNodeCount(plan)
  if (nodes > maxNodes) throw new BudgetError('nodes', nodes, maxNodes)
}
