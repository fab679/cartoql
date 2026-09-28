/**
 * Execute the reference documents over the silver-path adapter (reference) and
 * write expected/responses/*.json snapshots: the last of the gold-shard trio
 * (sdl + plans + responses, docs/09).
 *
 * Each response snapshot records the request variables it was minted with, so a
 * changed variable set is a visible diff, not a mystery.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { canonicalJson } from '../packages/core/src/ir.js'
import { compileDocument } from '../packages/core/src/compiler.js'
import { ReferenceAdapter } from '../packages/adapters/reference/src/index.js'

const shard = fileURLToPath(new URL('../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shard, 'data.ttl'), 'utf-8')

const generated = generateSdl(
  { ontology, shapes },
  'corpus/shards/core',
  { datasetGraphs: ['urn:cartoql:shard:core'] },
)
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
  const variables = JSON.parse(
    readFileSync(join(shard, 'documents', file.replace(/\.graphql$/, '.vars.json')), 'utf-8'),
  )
  const plan = compileDocument(source, module_)
  const response = await adapter.run(plan, module_, variables)
  const out = join(shard, 'expected/responses', file.replace(/\.graphql$/, '.json'))
  writeFileSync(out, canonicalJson({ variables, response }))
  console.log(`response ${file} → ${out}`)
}
