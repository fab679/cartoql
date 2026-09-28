/**
 * Emit (or refresh) the core gold-shard SDL snapshot into
 * corpus/shards/core/expected/sdl/core.graphql.
 *
 * Snapshots are reviewed artifacts (docs/09): this script prints the schema hash,
 * and regeneration is always a visible diff in a PR — never silent.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateSdl } from '../packages/generator/src/index.js'

const shard = fileURLToPath(new URL('../corpus/shards/core/', import.meta.url))
const ontology = readFileSync(join(shard, 'ontology.ttl'), 'utf-8')
const shapes = readFileSync(join(shard, 'shapes.ttl'), 'utf-8')

const generated = generateSdl({ ontology, shapes }, 'corpus/shards/core')
const outPath = join(shard, 'expected/sdl/core.graphql')
writeFileSync(outPath, generated.sdl)
console.log(`wrote ${outPath}`)
console.log(`schemaHash: ${generated.schemaHash}`)
