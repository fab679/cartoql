/**
 * Project the reference documents' plans into SPARQL SELECT + protocol binding
 * snapshots (`expected/sparql/{doc}.{rq,bind.json}`) — the injection-purity
 * evidence for the corpus: query text carries no client values by
 * construction, and the bindings file is where every client value travels.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { canonicalJson } from '../packages/core/src/ir.js'
import { compileDocument } from '../packages/core/src/compiler.js'
import { projectRoot } from '../packages/adapters/sparql-http/src/index.js'

const shard = fileURLToPath(new URL('../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core', {
  datasetGraphs: ['urn:cartoql:shard:core'],
})
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}

for (const file of readdirSync(join(shard, 'documents')).filter((f) => f.endsWith('.graphql')).sort()) {
  const source = readFileSync(join(shard, 'documents', file), 'utf-8')
  const variables = JSON.parse(
    readFileSync(join(shard, 'documents', file.replace(/\.graphql$/, '.vars.json')), 'utf-8'),
  )
  const plan = compileDocument(source, module_)
  const requests = plan.roots.map((root, i) => {
    if (root.kind !== 'EntityLookup') throw new Error(`unexpected root kind: ${root.kind}`)
    return projectRoot(root, i, variables)
  })
  const base = file.replace(/\.graphql$/, '')
  writeFileSync(join(shard, 'expected/sparql', `${base}.rq`), requests.map((r) => r.query).join('\n'))
  writeFileSync(join(shard, 'expected/sparql', `${base}.bind.json`), canonicalJson(requests.map((r) => r.bindings)))
  console.log(`sparql ${file} → ${base}.{rq,bind.json}`)
}
