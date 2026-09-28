/**
 * Security-shard snapshots (M2 slice 1): SDL + plans, plus responses per
 * principal (alice: hr-comp + legal; bob: no groups) — the two-track semantics'
 * reviewed evidence. Field denials carry typed errors; entity gating is
 * existence-blind (no error entries anywhere it hides).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSchema } from 'graphql'
import { generateSdl } from '../packages/generator/src/index.js'
import { canonicalJson } from '../packages/core/src/ir.js'
import { compileDocument } from '../packages/core/src/compiler.js'
import { ReferenceAdapter } from '../packages/adapters/reference/src/index.js'

const shard = fileURLToPath(new URL('../corpus/shards/sec/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')
const data = readFileSync(join(shard, 'data.ttl'), 'utf-8')
const stamps = JSON.parse(readFileSync(join(shard, 'stamps.json'), 'utf-8'))

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/sec', {
  datasetGraphs: ['urn:verax:shard:sec'],
  stamps,
})
writeFileSync(join(shard, 'expected/sdl/sec.graphql'), generated.sdl)

const module_ = {
  moduleId: generated.moduleId,
  schemaHash: generated.schemaHash,
  schema: buildSchema(generated.sdl),
  semanticMap: generated.semanticMap,
  datasetGraphs: generated.datasetGraphs,
}
const adapter = ReferenceAdapter.fromTurtle(data, module_.datasetGraphs)

const PRINCIPALS: Record<string, Record<string, string[]>> = {
  alice: { alice: ['hr-comp', 'legal'] },
  bob: { bob: [] },
  carol: { carol: ['hr-comp'] }, // traversal-capable, no legal — the edge-vs-entity fixture
  'site-reviewer': { 'site-reviewer': [] }, // no interest groups — ONLY the reviewer platform role
}
const PRINCIPAL_ROLES: Record<string, readonly string[]> = {
  'site-reviewer': ['reviewer'],
}

for (const file of readdirSync(join(shard, 'documents')).filter((f) => f.endsWith('.graphql')).sort()) {
  const source = readFileSync(join(shard, 'documents', file), 'utf-8')
  const variables = JSON.parse(readFileSync(join(shard, 'documents', file.replace(/\.graphql$/, '.vars.json')), 'utf-8'))
  const plan = compileDocument(source, module_)
  const base = file.replace(/\.graphql$/, '')
  writeFileSync(join(shard, 'expected/plans', `${base}.json`), canonicalJson(plan))
  for (const [principalId, map] of Object.entries(PRINCIPALS)) {
    const view = {
      groups: new Set(map[principalId]!),
      ...(PRINCIPAL_ROLES[principalId] !== undefined
        ? { roles: new Set(PRINCIPAL_ROLES[principalId]) }
        : {}),
      viewVersion: 'static-1',
    }
    const response = await adapter.run(plan, module_, variables, { view, principalId })
    writeFileSync(
      join(shard, 'expected/responses', `${base}::${principalId}.json`),
      canonicalJson({ principalId, viewVersion: view.viewVersion, variables, response }),
    )
  }
  console.log(`sec snapshot ${file} (alice + bob)`)
}
