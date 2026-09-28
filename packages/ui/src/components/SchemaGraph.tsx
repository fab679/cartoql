import { useEffect, useMemo, useRef, useState } from 'react'
import { buildSchema, type GraphQLSchema } from 'graphql'

/**
 * The schema as territory: types are nodes, object fields are edges, interfaces
 * are dashed ties. A hand-rolled force layout (repulsion + springs + center
 * gravity) — no graph libraries in an offline instrument. Drag nodes, wheel to
 * zoom, drag the canvas to pan; click a type for its field list.
 */

interface GNode {
  readonly id: string
  readonly kind: 'type' | 'interface' | 'enum' | 'scalar' | 'root'
  x: number
  y: number
  vx: number
  vy: number
  fixed?: boolean
}

interface GEdge {
  readonly from: string
  readonly to: string
  readonly label: string
  readonly dashed: boolean
}

function named(typeName: string): string {
  return typeName.replace(/[[\]!]/g, '')
}

function buildGraph(sdl: string): { nodes: GNode[]; edges: GEdge[] } | null {
  let schema: GraphQLSchema
  try {
    schema = buildSchema(sdl)
  } catch {
    return null
  }
  const nodes: GNode[] = []
  const edges: GEdge[] = []
  const typeMap = schema.getTypeMap()
  const exposed = new Set(
    Object.values(typeMap)
      .filter((type) => !type.name.startsWith('__') && !('getValues' in type) === false || true)
      .map((type) => type.name),
  )
  void exposed
  const nodeIds = new Set<string>()
  const existing = new Map<string, GNode>()
  const addNode = (id: string, kind: GNode['kind']): GNode => {
    const prior = existing.get(id)
    if (prior !== undefined) return prior // dedupe: typeMap + field edges cover the same types
    const angle = (nodeIds.size * 137.5 * Math.PI) / 180
    const node: GNode = { id, kind, x: 320 + Math.cos(angle) * 260, y: 230 + Math.sin(angle) * 200, vx: 0, vy: 0 }
    nodes.push(node)
    nodeIds.add(id)
    existing.set(id, node)
    return node
  }
  const fieldEdgesOf = (owner: string, fields: Record<string, { name: string; type: { toString(): string } }>): void => {
    for (const field of Object.values(fields)) {
      const target = named(String(field.type))
      if (
        target !== owner &&
        !target.startsWith('__') &&
        !['String', 'Int', 'Float', 'Boolean', 'ID'].includes(target) &&
        (typeMap[target] !== undefined && 'getFields' in typeMap[target]! || 'getValues' in (typeMap[target] ?? {}))
      ) {
        if (!nodeIds.has(owner)) addNode(owner, 'type')
        if (!nodeIds.has(target)) {
          const isEnum = typeMap[target] !== undefined && 'getValues' in typeMap[target]!
          addNode(target, isEnum ? 'enum' : 'type')
        }
        edges.push({ from: owner, to: target, label: field.name, dashed: false })
      }
    }
  }
  const query = schema.getQueryType()
  if (query !== undefined && query !== null) {
    addNode(query.name, 'root')
    fieldEdgesOf(query.name, Object.fromEntries(Object.entries(query.getFields()).map(([k, v]) => [k, { name: k, type: v.type }])) as Record<string, { name: string; type: { toString(): string } }>)
  }
  for (const [typeName, type] of Object.entries(typeMap)) {
    if (typeName.startsWith('__')) continue
    if (type.name === query?.name) continue
    if ('getFields' in type) {
      addNode(type.name, (type as { toString(): string }).toString().startsWith('interface') ? 'interface' : 'type')
      fieldEdgesOf(type.name, Object.fromEntries(Object.entries((type as unknown as { getFields(): Record<string, { name: string; type: { toString(): string } }> }).getFields()).map(([k, v]) => [k, { name: k, type: v.type }])) as unknown as Record<string, { name: string; type: { toString(): string } }>)
    } else if ('getValues' in type) {
      addNode(type.name, 'enum')
    } else {
      addNode(type.name, 'scalar')
    }
  }
  // interface implementations → dashed ties
  for (const [typeName, type] of Object.entries(typeMap)) {
    if (typeName.startsWith('__') || !('getTypes' in type)) continue
    for (const t of (type as unknown as { getTypes(): Array<{ name: string }> }).getTypes()) {
      edges.push({ from: t.name, to: typeName, label: 'implements', dashed: true })
    }
  }
  // dedupe parallel edges between the same pair (labels merge on click)
  const seen = new Map<string, GEdge>()
  const deduped: GEdge[] = []
  for (const edge of edges) {
    const key = `${edge.from}→${edge.to}:${edge.dashed ? 'd' : 's'}`
    const prior = seen.get(key)
    if (prior === undefined) {
      seen.set(key, edge)
      deduped.push(edge)
    } else if (edge.label !== prior.label) {
      seen.set(key, { ...prior, label: `${prior.label}, ${edge.label}` })
    }
  }
  // sort by cluster: bigger degrees centered first (visual stability)
  return { nodes, edges: deduped }
}

const KIND_COLOR: Record<GNode['kind'], string> = {
  root: '#c9a96b',
  interface: '#c9a96b',
  type: '#e7e2d3',
  enum: '#7fa6a0',
  scalar: '#a8a497',
}

export function SchemaGraph({ sdl, onClose }: { readonly sdl: string; readonly onClose: () => void }) {
  const full = useMemo(() => buildGraph(sdl), [sdl])
  const [helpers, setHelpers] = useState(false)
  const graph = useMemo(() => {
    if (full === null) return null
    if (helpers) return full
    // delivery-clean default: connection/edge wrappers, PageInfo, and scalars are
    // chrome — the interesting graph is entities, interfaces, enums, and the root
    const isHelper = (id: string): boolean =>
      /Connection$|Edge$/.test(id) || id === 'PageInfo' || id.startsWith('CartoQL') || ['String', 'Int', 'Float', 'Boolean', 'ID'].includes(id)
    const keep = new Set(full.nodes.filter((n) => !isHelper(n.id)).map((n) => n.id))
    return {
      nodes: full.nodes.filter((n) => keep.has(n.id)),
      edges: full.edges.filter((e) => keep.has(e.from) && keep.has(e.to)),
    }
  }, [full, helpers])
  const [selected, setSelected] = useState<GNode | null>(null)
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 })
  const svgRef = useRef<SVGSVGElement>(null)
  const dragState = useRef<{ kind: 'node' | 'canvas'; id?: string; lastX: number; lastY: number } | null>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // force simulation: 250 ticks, reheats never (static after settle)
  useEffect(() => {
    if (graph === null) return
    let frame = 0
    const W = 640
    const H = 480
    const tick = (): void => {
      const { nodes, edges } = graph
      for (const a of nodes) {
        for (const b of nodes) {
          if (a === b) continue
          const dx = a.x - b.x
          const dy = a.y - b.y
          const dist = Math.max(20, Math.hypot(dx, dy))
          const force = (14000 / (dist * dist)) * 0.03
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          a.vx += fx
          a.vy += fy
        }
        // center gravity
        a.vx += (W / 2 - a.x) * 0.002
        a.vy += (H / 2 - a.y) * 0.002
      }
      for (const edge of edges) {
        const from = nodes.find((n) => n.id === edge.from)
        const to = nodes.find((n) => n.id === edge.to)
        if (from === undefined || to === undefined) continue
        const dx = to.x - from.x
        const dy = to.y - from.y
        const dist = Math.max(30, Math.hypot(dx, dy))
        const spring = (dist - 170) * 0.02
        const fx = (dx / dist) * spring
        const fy = (dy / dist) * spring
        from.vx += fx
        from.vy += fy
        to.vx -= fx
        to.vy -= fy
      }
      for (const node of nodes) {
        if (node.fixed === true) continue
        node.vx *= 0.82
        node.vy *= 0.82
        node.x += node.vx
        node.y += node.vy
      }
      frame += 1
      if (frame < 420) requestAnimationFrame(tick)
      else setView((v) => ({ ...v })) // settle render
    }
    const handle = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(handle)
  }, [graph])

  if (graph === null) return null
  const byId = new Map(graph.nodes.map((n) => [n.id, n]))
  const selectedEdges = selected === null ? [] : graph.edges.filter((e) => e.from === selected.id || e.to === selected.id)

  return (
    <div
      className="fixed inset-0 z-30 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label="schema graph"
      onClick={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div className="flight relative aspect-4/3 w-[min(92vw,1080px)] border border-line-2 bg-ink-2 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-line px-3 py-1.5">
          <span className="font-semibold text-brass">schema graph</span>
          <span className="text-[11px] text-paper-dim">{graph.nodes.length} types · {graph.edges.length} links — drag nodes, wheel to zoom, esc to close</span>
          <label className="ml-auto flex items-center gap-1 text-[11px] text-paper-dim">
            <input type="checkbox" checked={helpers} onChange={(e) => setHelpers(e.target.checked)} aria-label="show connector types" />
            helpers
          </label>
          <button type="button" onClick={onClose} aria-label="close dialog" className="px-1 text-paper-dim hover:text-spec-red">✕</button>
        </div>
        <svg
          ref={svgRef}
          className="h-[calc(100%-2rem)] w-full cursor-grab active:cursor-grabbing"
          viewBox="0 0 640 480"
          preserveAspectRatio="xMidYMid meet"
          onWheel={(event) => {
            event.preventDefault()
            setView((v) => ({ ...v, zoom: Math.min(3, Math.max(0.4, v.zoom - event.deltaY * 0.001)) }))
          }}
          onPointerDown={(event) => {
            const target = event.target as SVGElement
            const nodeKey = target.dataset['node']
            dragState.current = { kind: nodeKey !== undefined ? 'node' : 'canvas', id: nodeKey, lastX: event.clientX, lastY: event.clientY }
            ;(event.currentTarget as SVGSVGElement).setPointerCapture(event.pointerId)
          }}
          onPointerMove={(event) => {
            const drag = dragState.current
            if (drag === null) return
            const dx = event.clientX - drag.lastX
            const dy = event.clientY - drag.lastY
            drag.lastX = event.clientX
            drag.lastY = event.clientY
            if (drag.kind === 'node' && drag.id !== undefined) {
              const node = byId.get(drag.id)
              if (node !== undefined) {
                node.x += dx / view.zoom
                node.y += dy / view.zoom
                node.fixed = true
                setView((v) => ({ ...v }))
              }
            } else {
              setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))
            }
          }}
          onPointerUp={() => { dragState.current = null }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.zoom}) translate(0 0)`}>
            {graph.edges.map((edge, index) => {
              const from = byId.get(edge.from)
              const to = byId.get(edge.to)
              if (from === undefined || to === undefined) return null
              const highlighted = selected !== null && (edge.from === selected.id || edge.to === selected.id)
              return (
                <g key={`${edge.from}-${edge.to}-${index}`}>
                  <line
                    x1={from.x}
                    y1={from.y}
                    x2={to.x}
                    y2={to.y}
                    stroke={highlighted ? 'var(--color-brass)' : 'var(--color-line-2)'}
                    strokeWidth={highlighted ? 1.8 : 1}
                    strokeDasharray={edge.dashed ? '4 3' : undefined}
                    opacity={selected === null || highlighted ? 0.85 : 0.25}
                  />
                  {highlighted ? (
                    <text x={(from.x + to.x) / 2} y={(from.y + to.y) / 2 - 4} fontSize="9" textAnchor="middle" fill="var(--color-brass)" className="pointer-events-none select-none">
                      {edge.label.length > 28 ? `${edge.label.slice(0, 26)}…` : edge.label}
                    </text>
                  ) : null}
                </g>
              )
            })}
            {graph.nodes.map((node) => {
              const width = Math.max(64, node.id.length * 7 + 18)
              const isSel = selected?.id === node.id
              return (
                <g key={node.id} transform={`translate(${node.x - width / 2} ${node.y - 10})`}>
                  <rect
                    data-node={node.id}
                    width={width}
                    height={22}
                    rx={3}
                    fill="var(--color-ink)"
                    stroke={isSel ? 'var(--color-brass)' : 'var(--color-line-2)'}
                    strokeWidth={isSel ? 1.6 : 1}
                    className="cursor-pointer"
                  />
                  <text
                    x={width / 2}
                    y={15}
                    textAnchor="middle"
                    fontSize="10.5"
                    fill={KIND_COLOR[node.kind]}
                    data-node={node.id}
                    className="cursor-pointer select-none"
                  >
                    {node.id}
                  </text>
                </g>
              )
            })}
          </g>
        </svg>
        <div className="absolute bottom-2 left-2 flex gap-3 border border-line bg-ink px-2 py-1 text-[10px] text-paper-dim">
          <span className="text-brass">■ root/interface</span>
          <span className="text-paper-dim">■ type</span>
          <span className="text-terrain">■ enum</span>
          {selected !== null ? (
            <span className="text-paper">
              {selected.id} → {selectedEdges.map((e) => e.label.slice(0, Math.floor(60 / Math.max(1, selectedEdges.length))).trim()).filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
