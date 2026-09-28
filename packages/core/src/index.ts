/**
 * @cartoql/core — the compiler, algebra IR, directive registry, cost model,
 * and error-code contract.
 *
 * Status: M0 scaffold. The first real surfaces land with M1:
 *   - the algebra IR node types (ADR-1: portable JSON algebra)
 *   - the directive registry contract types (docs/03)
 *   - `CQL_*` error-code constants re-exported for all packages
 */

/** Administered identity of the compiled artifact family (remap policy, docs/01). */
export const ERROR_PREFIX = 'CQL' as const;

/** Enumerate the versioned error codes (docs/03 Part II). */
export const ERROR_CODES = [
  'PERMISSION_DENIED',
  'PERMISSION_STALE',
  'SCOPE_UNRESOLVED',
  'QUERY_TOO_COMPLEX',
  'DIRECTIVE_REJECTED',
  'ONTOLOGY_STALE',
  'SHAPE_MISMATCH',
  'PERSISTED_QUERY_NOT_FOUND',
  'INVALID_ARGUMENT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number] | `${typeof ERROR_PREFIX}_${string}`;

/** Wire form of one error entry (branch on `code`, never on messages). */
export interface CartoQLErrorExtensions {
  code: `${typeof ERROR_PREFIX}_${ErrorCode}`;
  schemaVersion: string;
  planId?: string;
  [key: string]: unknown;
}

/**
 * Placeholder until ADR-1's algebra lands: the shape every plan node will satisfy.
 * Constraints only ever accumulate here — see the enforcement rules (docs/03 Part II).
 */
export interface AlgebraNode {
  kind: 'pattern' | 'graph' | 'constraint' | 'projection' | 'service';
  graph?: string;
  constraints: readonly string[];
}