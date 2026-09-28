/**
 * Compile the core shard's reference documents into expected/plans/*.json
 * snapshots (ADR-1 IR, docs/09). Regeneration is always a visible PR diff.
 *
 * Also writes expected/sdl/core.map.json — the module's semantic map — because
 * the map is the reviewed half of the module contract the compiler consumes.
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { canonicalJson } from '../packages/core/src/ir.js'
import { compileDocument } from '../packages/core/src/compiler.js'

const shard = fileURLToPath(new URL('../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')

const generated = generateSdl(
  { ontology, shapes },
  'corpus/shards/core',
  { datasetGraphs: ['urn:cartoql:shard:core'] },
)
writeFileSync(join(shard, 'expected/sdl/core.map.json'), canonicalJson(generated.semanticMap))

const module = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}

const docsDir = join(shard, 'documents')
for (const file of readdirSync(docsDir).filter((f) => f.endsWith('.graphql')).sort()) {
  const source = readFileSync(join(docsDir, file), 'utf-8')
  const plan = compileDocument(source, module)
  const out = join(shard, 'expected/plans', file.replace(/\.graphql$/, '.json'))
  writeFileSync(out, canonicalJson(plan))
  console.log(`plan ${file} → ${out} (planId ${plan.planId.slice(0, 12)}…, cost ${plan.cost})`)
}
