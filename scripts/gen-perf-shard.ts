/**
 * Perf shard generator (docs/08/09): ~250k synthetic triples with the CORE
 * module's vocabulary — the perf band measurements run over this, not the tiny
 * gold shard. Deterministic (seeded), written to a temp dir; loaded into the
 * test store by perf-check.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const OUT = process.argv[2] ?? '/tmp/cartoql-perf-shard'
mkdirSync(OUT, { recursive: true })

// deterministic "rng"
let seed = 0x2f6e2b1
const rnd = (): number => {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const ORGS = 50
const PERSONS = 20000 // ~250k triples at the core vocabulary (docs/08 perf shard)
const PUBS = 40000

const lines: string[] = []
lines.push('@prefix vcore: <https://cartoql.example/corpus/core#> .')
lines.push('@prefix vdata: <https://cartoql.example/corpus/core/data#> .')
lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .')

for (let i = 0; i < ORGS; i += 1) {
  lines.push(
    `vdata:org-${i} a vcore:Organization ; vcore:name "Organization ${i} Systems" ; vcore:foundedYear "${1960 + (i % 65)}"^^xsd:gYear .`,
  )
}
for (let i = 0; i < PERSONS; i += 1) {
  const org = `vdata:org-${Math.floor(i / 100) % ORGS}`
  const pubs = Array.from({ length: Math.floor(rnd() * 4) }, (_, k) => `vdata:pub-${(i * 4 + k) % PUBS}`)
  const pubRefs = pubs.length > 0 ? ` ; vcore:authored ${pubs.join(', ')}` : ''
  lines.push(`vdata:person-${i} a vcore:Person ; vcore:name "Person ${i} Example" ; vcore:worksFor ${org}${pubRefs} .`)
}
const pubLines: string[] = []
for (let i = 0; i < PUBS; i += 1) {
  pubLines.push(
    `vdata:pub-${i} a vcore:Publication ; vcore:name "Publication ${i} of the series" ; vcore:year "${2015 + (i % 12)}"^^xsd:gYear .`,
  )
}
lines.push(...pubLines, '')
// rough triple count: orgs*3 + persons*(3+~2+pubs) + pubs*3 ≈ 250k
writeFileSync(join(OUT, 'data.ttl'), lines.join('\n'))
console.error(`perf shard: ${PERSONS}+${ORGS} entities, ~${(PERSONS * 5 + PUBS * 3 + ORGS * 3)} triples → ${OUT}/data.ttl`)
