/**
 * @cartoql/core — executor-side shared contract: variable resolution, cursor
 * encoding, and the StoreAdapter SPI (docs/02 §4).
 *
 * The *reference adapter* (packages/adapters/reference) implements this SPI by
 * evaluating the IR directly over an in-memory RDF store; its behavior IS the
 * L0 conformance semantics ("the default adapter's semantics is the semantics",
 * docs/02 §5). The SPARQL 1.1 HTTP adapter later projects the same IR to
 * parameterized queries and must reach response-equivalence with this one.
 */
import { createHash } from "node:crypto";
import { canonicalJson, type Binding, type Plan } from "./ir.js";
import type { CartoQLModule } from "./compiler.js";
import type { PermissionView } from "./security.js";

export class ExecutorError extends Error {
  constructor(message: string) {
    super(`[@cartoql/executor] ${message}`);
    this.name = "ExecutorError";
  }
}

/** Runtime resolved variables for one request (string|number|boolean|null scalars). */
export type ResolvedVariables = Readonly<
  Record<string, string | number | boolean | null>
>;

/** Resolve one plan binding against request variables — the D7 choke point (double-fail-loud). */
export function resolveBinding(
  binding: Binding | undefined,
  variables: ResolvedVariables,
  where: string,
): string | number | boolean | null {
  if (binding === undefined) return null; // absent optional argument
  if (typeof binding !== "object" || binding === null) return binding;
  const value = variables[binding.variable];
  if (value === undefined) {
    throw new ExecutorError(
      `variable $${binding.variable} was not provided (${where})`,
    );
  }
  return value;
}

/** Scope hash for cursors: a cursor from a different graph scope must never resolve. */
export function graphScopeHash(graphs: readonly string[]): string {
  return createHash("sha256").update(graphs.join("|")).digest("hex");
}

export interface CursorPayload {
  readonly orderByKey: string;
  readonly lastValue: string;
  readonly lastIRI: string;
  readonly graphHash: string;
}

/** docs/06 D6: canonical ordering key is the entity IRI — cursors carry it explicitly. */
export const ORDER_BY_IRI = "urn:cartoql:ordering:iri";

/**
 * Guard + escape a scalar filter value into an RDF string-literal TERM.
 * Uses a char-code loop, not regex escapes: value characters never enter any
 * syntax position except inside the quoted literal, with backslash and
 * quote escaped (D7 discipline for client-provided values).
 */
export function stringLiteralTerm(value: string): string {
  const QUOTE = String.fromCharCode(34); // no escape-sequence literals: quoting layers have garbled these before
  const BACKSLASH = String.fromCharCode(92);
  let escaped = "";
  for (const ch of value) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20) {
      throw new ExecutorError(
        "filter value contains control characters — not representable in a string literal",
      );
    }
    escaped +=
      ch === QUOTE
        ? BACKSLASH + QUOTE
        : ch === BACKSLASH
          ? BACKSLASH + BACKSLASH
          : ch;
  }
  return '"' + escaped + '"';
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJson(payload), "utf-8").toString("base64url");
}

export function decodeCursor(
  cursor: string,
  expectedGraphHash: string,
  expectedOrderBy?: string,
): CursorPayload {
  let payload: CursorPayload;
  try {
    payload = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf-8"),
    ) as CursorPayload;
  } catch {
    throw new ExecutorError(
      "malformed cursor — refusing to execute (fail loud, never guess a window)",
    );
  }
  if (payload.graphHash !== expectedGraphHash) {
    throw new ExecutorError(
      "cursor was minted against a different graph scope — stale or foreign; refused",
    );
  }
  const expected = expectedOrderBy ?? ORDER_BY_IRI;
  if (payload.orderByKey !== expected) {
    throw new ExecutorError(
      `cursor ordering (${payload.orderByKey}) does not match this query's ordering (${expected}) — ` +
        `stale cursor from a differently ordered window; refused`,
    );
  }
  return payload;
}

/** One typed error entry: branch on extensions.code, never on message (docs/03 Part II). */
export interface CartoQLError {
  readonly message: string;
  readonly path?: string;
  readonly extensions: { readonly code: string };
}

/** The shaped GraphQL response data for a plan — { data, errors } at the transport. */
export interface ResponseData {
  readonly data: Record<string, unknown>;
  readonly errors: readonly CartoQLError[];
}

/**
 * Per-request security context (docs/07: agents run as the human, fail closed).
 * Absent context = the documented open posture (allowAll view) — tests, standalone
 * mode; a configured gateway always resolves a real view before calling run().
 */
export interface SecurityContext {
  readonly view: PermissionView;
  readonly principalId: string;
}

/** The adapter SPI (docs/02 §4). Implementations must never see an AST — only compiled plans. */
export interface StoreAdapter {
  readonly name: string;
  readonly conformance: "reference" | "L0" | "L1" | "L2";
  run(
    plan: Plan,
    module: CartoQLModule,
    variables: ResolvedVariables,
    security?: SecurityContext,
  ): Promise<ResponseData>;
}

/** The open posture as code: what an adapter uses when no security context is supplied. */
export const OPEN_CONTEXT: SecurityContext = Object.freeze({
  view: Object.freeze({
    groups: new Set<string>(),
    viewVersion: "open",
    allowAll: true,
  }),
  principalId: "open",
});
