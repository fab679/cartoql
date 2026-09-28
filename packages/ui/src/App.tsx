import { useCallback, useEffect, useMemo, useState } from 'react'
import { parse, print } from 'graphql'
import type { Explain, GraphQLErrorEntry, Health } from './api'
import { explain as explainApi, health as healthApi, runQuery, sdl as sdlApi } from './api'
import { BudgetGauge } from './components/BudgetGauge'
import { JsonTree } from './components/JsonTree'
import { QueryEditor } from './components/QueryEditor'
import { RightRail } from './components/RightRail'
import { Stamp, DenialStamps } from './components/Stamp'
import { ColumnResize } from './components/Split'
import { SchemaGraph } from './components/SchemaGraph'
import { schemaFrom } from './utility/suggest'
import { toCurl } from './utility/curl'

interface QueryTab {
  readonly id: string
  readonly name: string
  readonly query: string
  readonly variables: string
}

interface HistoryEntry {
  readonly at: string
  readonly query: string
  readonly ms: number
  readonly status: number
}

// endpoint is stored PER ORIGIN so a stale port saved under an old instance never
// bleeds into a console served by a new one (the reported stale-4137 case)
const scopedOrigin = (): string => (window.location.origin === 'null' ? 'file' : window.location.origin)
const endpointKey = (): string => `cartoql.endpoint@${scopedOrigin()}`
const loadEndpoint = (): string =>
  localStorage.getItem(endpointKey()) ?? localStorage.getItem('cartoql.endpoint') ?? ''

const STORAGE = {
  endpoint: 'cartoql.endpoint',
  principal: 'cartoql.principal',
  bearer: 'cartoql.bearer',
  tabs: 'cartoql.tabs',
  activeTab: 'cartoql.active.tab',
  panelResponse: 'cartoql.panel.response',
  panelRail: 'cartoql.panel.rail',
} as const

function loadTabs(): QueryTab[] {
  const saved = localStorage.getItem(STORAGE.tabs)
  if (saved !== null) {
    try {
      const parsed = JSON.parse(saved) as QueryTab[]
      if (parsed.length > 0) return parsed
    } catch { /* fall through */ }
  }
  // schema-agnostic starter: whatever ontology the gateway serves, this opens against it
  return [{ id: 'tab1', name: 'query 1', query: 'query {\n  \n}', variables: '{}' }]
}

export function App() {
  // '' = same-origin (the --ui mode); an explicit URL targets an external gateway (CORS)
  const [endpoint, setEndpoint] = useState(loadEndpoint)
  const [principal, setPrincipal] = useState(() => localStorage.getItem(STORAGE.principal) ?? '')
  const [bearer, setBearer] = useState(() => localStorage.getItem(STORAGE.bearer) ?? '')
  const [tabs, setTabs] = useState<QueryTab[]>(loadTabs)
  const [activeTabId, setActiveTabId] = useState(() => localStorage.getItem(STORAGE.activeTab) ?? 'tab1')
  const [paramsTab, setParamsTab] = useState<'QUERY VARIABLES' | 'HEADERS'>('QUERY VARIABLES')
  const [response, setResponse] = useState<{ body: unknown; rejects: readonly GraphQLErrorEntry[] } | null>(null)
  const [ms, setMs] = useState(0)
  const [status, setStatus] = useState(200)
  const [landKey, setLandKey] = useState(0)
  const [running, setRunning] = useState(false)
  const [explainResult, setExplainResult] = useState<Explain | null>(null)
  const [healthState, setHealthState] = useState<Health | null>(null)
  const [sdlText, setSdlText] = useState<string>('')
  const [notice, setNotice] = useState<string | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [showHistory, setShowHistory] = useState(false)
  const [copied, setCopied] = useState(false)
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem('cartoql.panel.rail') !== 'closed')
  const [graphOpen, setGraphOpen] = useState(() => window.location.hash === '#graph')
  const [responseOpen, setResponseOpen] = useState(() => localStorage.getItem('cartoql.panel.response') !== 'closed')
  const [responseWidth, setResponseWidth] = useState(() => Number(localStorage.getItem('cartoql.panel.response.w') ?? 40))
  const [railWidth, setRailWidth] = useState(() => Number(localStorage.getItem('cartoql.panel.rail.w') ?? 16))

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]!

  const schema = useMemo(() => (sdlText === '' ? null : schemaFrom(sdlText)), [sdlText])

  const loadHealth = useCallback(async (at: string) => {
    try {
      setHealthState(await healthApi(at))
      setSdlText(await sdlApi(at))
      setNotice(null)
    } catch {
      setHealthState(null)
      setNotice(`gateway is not answering at ${at}`)
    }
  }, [])

  useEffect(() => {
    localStorage.setItem(endpointKey(), endpoint)
    localStorage.removeItem('cartoql.endpoint') // migrated to the origin-scoped key
    localStorage.setItem(STORAGE.principal, principal)
    localStorage.setItem(STORAGE.bearer, bearer)
    localStorage.setItem(STORAGE.tabs, JSON.stringify(tabs))
    localStorage.setItem(STORAGE.activeTab, activeTab.id)
    localStorage.setItem('cartoql.panel.response.w', String(responseWidth))
    localStorage.setItem('cartoql.panel.rail.w', String(railWidth))
    localStorage.setItem('cartoql.panel.response', responseOpen ? 'open' : 'closed')
    localStorage.setItem('cartoql.panel.rail', railOpen ? 'open' : 'closed')
  }, [endpoint, principal, bearer, tabs, activeTab, responseWidth, railWidth, responseOpen, railOpen])

  useEffect(() => {
    const timer = setTimeout(() => void loadHealth(endpoint), 300)
    return () => clearTimeout(timer)
  }, [endpoint, loadHealth])

  const setTab = (patch: Partial<QueryTab>): void => {
    setTabs((current) => current.map((tab) => (tab.id === activeTab.id ? { ...tab, ...patch } : tab)))
  }

  const addTab = (): void => {
    const tab = { id: `tab${Date.now()}`, name: `query ${tabs.length + 1}`, query: 'query {\n  \n}', variables: '{}' }
    setTabs((current) => [...current, tab])
    setActiveTabId(tab.id)
  }

  const closeTab = (id: string): void => {
    setTabs((current) => {
      const remaining = current.filter((t) => t.id !== id)
      if (remaining.length === 0) {
        const fresh = { id: `tab${Date.now()}`, name: 'query 1', query: 'query {\n  \n}', variables: '{}' }
        setActiveTabId(fresh.id)
        return [fresh]
      }
      if (id === activeTabId) setActiveTabId(remaining[0]!.id)
      return remaining
    })
  }


  const run = useCallback(async (): Promise<void> => {
    let variables: Record<string, unknown> = {}
    try {
      variables = JSON.parse(activeTab.variables) as Record<string, unknown>
    } catch {
      setNotice('variables must parse as a JSON object')
      return
    }
    setNotice(null)
    setRunning(true)
    try {
      const result = await runQuery(
        endpoint,
        activeTab.query,
        variables,
        principal === '' ? undefined : principal,
        bearer === '' ? undefined : bearer,
      )
      const body = result.body as { errors?: readonly GraphQLErrorEntry[] } | unknown
      const console = body !== null && typeof body === 'object' ? (body as { errors?: readonly GraphQLErrorEntry[] }).errors ?? [] : []
      setResponse({ body: result.body, rejects: console })
      setStatus(result.status)
      setMs(result.ms)
      setLandKey((k) => k + 1)
      setHistory((current) => [{ at: new Date().toLocaleTimeString(), query: activeTab.query, ms: result.ms, status: result.status }, ...current].slice(0, 25))
    } catch (runError) {
      setNotice(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setRunning(false)
    }
  }, [endpoint, principal, bearer, activeTab])

  const prettify = (): void => {
    try {
      setTab({ query: print(parse(activeTab.query)) })
      setNotice(null)
    } catch (error_) {
      // verbatim graphql parse errors: line/column so users can fix, not guess
      setNotice(`prettify: ${(error_ as Error).message.split('\n')[0]}`)
    }
  }

  const copyCurl = (): void => {
    let variables: Record<string, unknown> = {}
    try { variables = JSON.parse(activeTab.variables) as Record<string, unknown> } catch { /* curl with empty vars */ }
    const command = toCurl(endpoint, activeTab.query, variables, principal === 'open' ? undefined : principal, bearer === '' ? undefined : bearer)
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }

  const runExplain = useCallback(async (): Promise<void> => {
    try {
      setExplainResult(await explainApi(endpoint, activeTab.query))
    } catch {
      setNotice('explain could not compile the document')
    }
  }, [endpoint, activeTab])


  const health = healthState
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-ink px-2 py-1">
        <h1 className="text-[14px] font-semibold text-brass">cartoql</h1>
        <div className="flex max-w-60 flex-nowrap overflow-x-auto">
          {tabs.map((tab) => (
            <div key={tab.id} className={`group flex items-baseline gap-1 border-r px-2 py-0.5 text-[12px] ${tab.id === activeTab.id ? 'bg-ink-2' : 'hover:bg-ink-3'}`}>
              <button type="button" onClick={() => setActiveTabId(tab.id)} className="text-paper">
                {tab.name}
              </button>
              <button type="button" aria-label={`close ${tab.name}`} onClick={() => closeTab(tab.id)} className="opacity-0 group-hover:opacity-100 hover:text-spec-red">×</button>
            </div>
          ))}
          <button type="button" onClick={addTab} aria-label="new tab" className="px-2 text-paper-dim hover:text-brass">＋</button>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[12px]">
          <span className={health === null ? 'text-spec-red' : 'text-terrain'}>{health === null ? 'offline' : `gateway ${health.status}`}</span>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-line bg-ink-2 px-2 py-1 text-[11.5px]">
        <button type="button" onClick={() => void run()} disabled={running} className="border border-brass/70 bg-brass/10 px-3 py-0.5 font-semibold text-brass disabled:opacity-30">
          {running ? '· · ·' : 'run'}
        </button>
        <button type="button" onClick={prettify} className="border border-line-2 px-2 py-0.5 tracking-wider text-paper-dim hover:border-brass/50 hover:text-brass">PRETTIFY</button>
        <div className="relative">
          <button type="button" onClick={() => setShowHistory(!showHistory)} className="border border-line-2 px-2 py-0.5 tracking-wider text-paper-dim hover:border-brass/50 hover:text-brass">HISTORY</button>
          {showHistory && history.length > 0 ? (
            <ul className="absolute z-20 mt-1 max-h-64 w-96 overflow-auto border border-line-2 bg-ink-2 p-1 shadow-lg shadow-black/40">
              {history.map((entry, index) => (
                <li key={index}>
                  <button type="button" onClick={() => { setTab({ query: entry.query }); setShowHistory(false) }} className="flex w-full items-baseline justify-between gap-2 px-2 py-1 text-left hover:bg-ink-3">
                    <span className="truncate text-paper">{entry.query.replace(/\s+/g, ' ').slice(0, 44)}</span>
                    <span className="shrink-0 text-paper-dim">{entry.status} · {entry.ms.toFixed(0)}ms · {entry.at}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          aria-label="gateway endpoint"
          className="min-w-42 flex-1 border border-line bg-ink px-2 py-0.5 outline-none focus:border-brass/50"
        />
        <button type="button" onClick={() => copyCurl()} className="border border-line-2 px-2 py-0.5 tracking-wider text-paper-dim hover:border-brass/50 hover:text-brass">
          {copied ? 'COPIED ✓' : 'COPY CURL'}
        </button>
        <span className="flex items-center gap-px text-[11px]">
          <button type="button" onClick={() => setResponseOpen(!responseOpen)} title="response panel" aria-pressed={responseOpen} className={`border px-1.5 py-0.5 ${responseOpen ? 'border-brass/50 text-brass' : 'border-line-2 text-paper-dim'}`}>res</button>
          <button type="button" onClick={() => setRailOpen(!railOpen)} title="schema rail" aria-pressed={railOpen} className={`border px-1.5 py-0.5 ${railOpen ? 'border-brass/50 text-brass' : 'border-line-2 text-paper-dim'}`}>rail</button>
          <button type="button" onClick={() => setGraphOpen(true)} title="schema graph" className="border border-line-2 px-1.5 py-0.5 text-paper-dim hover:border-brass/50 hover:text-brass">graph</button>
        </span>
      </div>

      {notice !== null ? <div className="border-b border-line-2 bg-spec-red/10 px-3 py-1 text-[12px] text-spec-red">{notice}</div> : null}

      <main className="flex min-h-0 flex-1">
        <section className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-line/60 px-2 py-1 text-[11px]">
            <label className="flex items-center gap-1 text-paper-dim">
              principal
              <input
                type="text"
                value={principal}
                onChange={(e) => setPrincipal(e.target.value)}
                placeholder="(none)"
                aria-label="principal header value"
                className="w-32 border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-paper outline-none focus:border-brass/50"
              />
            </label>
            <label className="flex items-center gap-1 text-paper-dim">
              bearer
              <input
                type="text"
                value={bearer}
                onChange={(e) => setBearer(e.target.value)}
                placeholder="(none)"
                aria-label="bearer token"
                className="w-40 border border-line bg-ink-2 px-1.5 py-0.5 font-mono text-paper outline-none focus:border-brass/50"
              />
            </label>
          </div>
          <QueryEditor value={activeTab.query} onChange={(query) => setTab({ query })} onSubmit={() => void run()} onNotice={setNotice} schema={schema} />
          <div className="h-40 shrink-0 border-t border-line">
            <div className="flex justify gap-2 border-b border-line/60 px-2 py-1 text-[11px]">
              {(['QUERY VARIABLES', 'HEADERS'] as const).map((name) => (
                <button key={name} type="button" onClick={() => setParamsTab(name)} className={`tracking-wider ${paramsTab === name ? 'text-brass' : 'text-paper-dim hover:text-paper'}`}>{name}</button>
              ))}
              <button type="button" onClick={() => void runExplain()} className="ml-auto tracking-wider text-paper-dim hover:border-brass/50 hover:text-brass border border-line-2 px-2">EXPLAIN</button>
              {explainResult !== null ? <BudgetGauge explain={explainResult} /> : null}
            </div>
            {paramsTab === 'QUERY VARIABLES' ? (
              <textarea
                value={activeTab.variables}
                onChange={(e) => setTab({ variables: e.target.value })}
                aria-label="query variables"
                spellCheck={false}
                className="h-32 w-full resize-none bg-ink p-2 text-[12px] outline-none"
              />
            ) : (
              <div className="h-32 overflow-auto bg-ink p-2 text-[12px]">
                <div className="text-paper-dim">x-cartoql-principal: <span className="text-brass">{principal === 'open' ? '(not sent)' : principal}</span></div>
                <div className="text-paper-dim">authorization: <span className="text-brass">{bearer === '' ? '(not sent)' : `Bearer ${bearer.slice(0, 9)}…`}</span></div>
                <button type="button" onClick={() => copyCurl()} className="mt-2 border border-line-2 px-2 py-0.5 text-[11px] text-paper-dim hover:border-brass/50 hover:text-brass">copy curl</button>
              </div>
            )}
          </div>
        </section>

        {responseOpen ? (
          <>
            <ColumnResize
              ariaLabel="resize response panel"
              onResize={(delta) => setResponseWidth((w) => Math.min(64, Math.max(20, w - delta / 16)))}
              onReset={() => setResponseWidth(40)}
            />
            <section style={{ width: `${responseWidth}rem` }} className="flex min-h-0 shrink-0 grow-0 flex-col border-l border-line bg-ink-2">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-2 py-1">
            <span className="text-[11px] tracking-wider text-paper-dim">RESPONSE</span>
            {response !== null ? (
              <>
                <Stamp label="status" value={String(status)} tone={status === 200 ? 'terrain' : 'red'} />
                <Stamp label="time" value={`${ms.toFixed(0)}ms`} />
                <DenialStamps errors={response.rejects} />
              </>
            ) : null}
          </div>
          <div key={landKey} className={`min-h-0 flex-1 overflow-auto p-3 ${landKey === 0 ? '' : 'record-land'}`}>
            {response === null ? (
              <div className="pt-8 text-center text-paper-dim">run a query — the record, its cost, and every denial land here.</div>
            ) : (
              <JsonTree data={response.body} />
            )}
          </div>
            </section>
          </>
        ) : null}

        {railOpen ? (
          <>
            <ColumnResize
              ariaLabel="resize schema rail"
              onResize={(delta) => setRailWidth((w) => Math.min(32, Math.max(12, w - delta / 16)))}
              onReset={() => setRailWidth(16)}
            />
            <span style={{ width: `${railWidth}rem` }} className="flex min-h-0 shrink-0">
              <RightRail sdl={sdlText} />
            </span>
          </>
        ) : null}
      </main>
      {graphOpen && sdlText !== '' ? <SchemaGraph sdl={sdlText} onClose={() => setGraphOpen(false)} /> : null}
    </div>
  )
}
