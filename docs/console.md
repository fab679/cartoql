# The Console

CartoQL ships a [GraphiQL-class](https://github.com/graphql/graphiql) console in the `packages/ui` workspace, served automatically under `--ui packages/ui/dist`. It is the primary interface most people use.

!!! requirements "How to serve the console"
    The console talks to the gateway on the **same origin** by default (the endpoint field stays blank). Boot with `--ui packages/ui/dist` and the console at `http://localhost:<port>` is pre-configured to connect to the gateway that serves it.

```bash
npm run serve -- \
  --ontology my-onto.ttl --shapes my-shapes.ttl \
  --data my-data.ttl \
  --ui packages/ui/dist --port 4137
```

![Server-served console (same-origin)](https://raw.githubusercontent.com/fab679/cartoql/main/docs/console-screenshot.png)
_Figure: the console connected to the core test data gateway at localhost:4137 (same-origin mode)._

## Anatomy of the console surface

| Toolbar button | What it does |
|---|---|
| **run** (or `ctrl+enter`) | Compile and execute against the gateway (the blue-in-brass button.) |
| **PRETTIFY** (or `ctrl+shift+enter`) | graphql's `print(parse(doc))` — parse errors surface the parser's own message with line/col (see also the **in-editor lint gutter**) |
| **HISTORY** (or click it) | Last 25 runs (click one to restore the document into the editor) |
| **COPY CURL** | The exact wire request as a copy-pasteable curl command |
| **EXPLAIN** | Compiles and previews the document's cost without executing (see the budget gauge below — the gauge turns red when the document won't fit) |
| **res** | Toggle the response panel open/closed |
| **rail** | Toggle the schema rail open/closed |
| **graph** | Open the schema-graph dialog |

### The console (left to right)

| Pane | What it shows |
|---|---|
| **principal + bearer inputs** | The `x-cartoql-principal` header value sent with requests. Set it to see the security model in action |
| **document editor** | CodeMirror 6 with cm6-graphql: schema-aware autocompletion ( fields, args, enum members), in-editor GitHub-style lint line markers (parse/validation), fold carets, undo history. `ctrl+enter` runs, `ctrl+shift+enter` prettifies |
| **QUERY VARIABLES \| HEADERS** | CodeMirror as well — the variables pane is a JSON-TTL surface. The headers pane displays exactly what the principal+bearer will send and reproduces it in the `COPY CURL` command |
| **response panel** | The full response: a collapsible JSON tree (caret-style, 6-brightness tones), a stamp strip — HTTP status, time, denial stamps (with typed code and field path) — and a "record land" contour pulse animation |
| **schema rail** | Browsable types from the live `/sdl`: fields, enums, calendar,… — filterable, and root fields have a **use** button that inserts a valid query skeleton directly into the editor |

## Autocomplete

The CodeMirror editor is driven by cm6-graphql (the GraphiQL completion-time engine) against the **live gateway schema** — so completions show exactly what your module declares:

- **Root fields** as you start typing under `query {`
- **Fields of the enclosing type** anywhere inside braces
- **Argument names** after opening parens (`people(`…): only arguments the field actually accepts ( many: links to other addresses exist only if your SHACL/ontology declare them)
- **Enum members** for `orderBy:` — your schema's own `<Type>OrderBy` members

## In-editor lint

cm6-graphql surfaces parse errors **in editor** with line positions in the gutter's lint markers — invalid GraphQL is red-underlined inline. Validation errors (like selecting a field that doesn't exist on the type or mistyping an enum member) mark at the caret with the GraphQL error message on hover.

## The schema graph dialog

The `graph` button opens a dialog with a force-laid-out graph of the types:
- **Drag** any type node to reposition (the engine relaxes 420 iterates)
- **Click** a type node → **sample entities** of that type load (their IRIs and names), each with an **use** button that inserts a single-entity lookup skeleton into the editor and dismisses the dialog
- **Wheel to zoom**, drag the canvas to pan, `esc` to close
- The `helpers` checkbox shows pagination wrappers (Connection, Edge, PageInfo) — turn it off and you see the entity graph first; **it is off by default**

## The response panel

- **North of the tree**: the stamp strip — HTTP status, select/travel time in ms, and diagnostic stamps standing on that border in falling-red for CQL codes
- **North edge**: an animated "contour pulse" (the response record "lands" — the pulse is the region of a recent background flash, respecting `prefers-reduced-motion`)
- **The tree**: expandable with the standard playroom keyboard contract (arrow keys + space/enter, tab/shift-tab for in/out), the same tones for strings/classes/code
- **Hover to see the full JSON path**

---

## First steps

1. Load the console from a served gateway (the URL bar is blank — taken automatically from the same origin).
2. Press `graph`, browse the schema, hit **use** on `Person` ( if you're on the core test data) — an actual, valid GraphQL skeleton lands in the editor with the irI pre-filled.
3. Fill the missing `…` irI: paste from the sample panel.
4. `ctrl+enter` — response appears. If more than one entity exists (`hasNextPage: true`), click the response's `endCursor` → paste it in `QUERY VARIABLES` as `"$after"…`
5. Try checking autocomplete: place the cursor inside the `Title立法 { `,… and see the fields appear in a popup by typing. Type ` `, get suggestions; "enter" inserts the top match; you'll find:
   相关人员 selected fields (using the remaining fields on the type)
6. Use `EXPLAIN` to check the cost, and see that the gauge starts working on the first try.

## Troubleshooting

| symptom | likely cause |
|---|---|
| "gateway answered 500" | The gateway's own /sdl output is broken, or the schema changed mid-request — check that the /health endpoint works and there's no stale token/endpoint in the console's URL bar |
| "cannot reach http://localhost:…" | No gateway is listening at that port — check the CLI output, note the port it prints; serve on a specific `--port` to make it non-ephemeral |
| Endpoint field blank = localhost:<port> | same-origin serving — that is correct when the console is loaded by the same `--ui` |
| Black graph是一只 but no type nodes / schema rail empty | The gateway's `/sdl` didn't parse — check the gateway's console / CLI output for `sdl validation errors` — datasets in a named graph can do this when the data graph is missing or the store is down |
| Autocomplete shows "no contextual type Found" | the schema is still loading — hit ctrl+enter on a {} query and see it change; reload the page once; if the gateway has just been started and /sdl has not been served yet, just re-load the active document |

## Source

* [`packages/ui`](https://github.com/fab679/cartoql/tree/main/packages/ui): React 19 + Vite 6 + Tailwind CSS v4 + CodeMirror 6. Build with `npm run -w @cartoql/ui build`.
* [`packages/gateway`](https://github.com/fab679/cartoql/tree/main/packages/gateway): the Node HTTP server that also serves the UI under `--ui`.