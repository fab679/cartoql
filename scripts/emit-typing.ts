/**
 * typing-shard snapshots (D4 part 2): plans, SPARQL projections, and responses —
 * the polymorphic corpus. Emits under reference semantics (open posture; the
 * typing shard carries no stamps yet).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { canonicalJson } from '../packages/core/src/ir.js'
import { compileDocument } from '../packages/core/src/compiler.js'
import { ReferenceAdapter } from '../packages/adapters/reference/src/index.js'
import { projectRoot } from '../packages/adapters/sparql-http/src/index.js'

const shard = fileURLToPath(new URL('../corpus/shards/typing/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shard, 'data.ttl'), 'utf-8')

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/typing', {
  datasetGraphs: ['urn:cartoql:shard:typing'],
})
writeFileSync(join(shard, 'expected/sdl/typing.graphql'), generated.sdl)
const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}
const adapter = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

for (const file of readdirSync(join(shard, 'documents')).filter((f) => f.endsWith('.graphql')).sort()) {
  const source = readFileSync(join(shard, 'documents', file), 'utf-8')
  const variables = JSON.parse(readFileSync(join(shard, 'documents', file.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
  const plan = compileDocument(source, module_)
  const base = file.replace(/\.graphql$/, '')
  writeFileSync(join(shard, 'expected/plans', `${base}.json`), canonicalJson(plan))
  const requests = plan.roots.map((root, i) => {
    if (root.kind !== 'EntityLookup') throw new Error('unexpected root')
    return projectRoot(root, i, variables, 'protocol')
  })
  writeFileSync(join(shard, 'expected/sparql', `${base}.rq`), requests.map((r) => r.query).join('\n'))
  const response = await adapter.run(plan, module_, variables)
  writeFileSync(join(shard, 'expected/responses', `${base}.json`), canonicalJson({ variables, response }))
  console.log(`typing snapshot ${file}`)
}
