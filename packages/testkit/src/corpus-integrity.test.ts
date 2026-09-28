import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const corpusRoot = fileURLToPath(new URL('../../../corpus/', import.meta.url))

describe('testkit: corpus integrity (docs/09)', () => {
  it('shards/core carries the full fixture trio', () => {
    const shard = join(corpusRoot, 'shards/core')
    for (const f of ['ontology.ttl', 'shapes.ttl', 'data.ttl', 'expected/README.md']) {
      expect(readFileSync(join(shard, f), 'utf-8').length, f).toBeGreaterThan(0)
    }
  })

  it('every turtle fixture declares prefixes and keeps IRIs balanced', () => {
    const files: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name !== 'expected') walk(join(dir, entry.name))
        else if (entry.name.endsWith('.ttl')) files.push(join(dir, entry.name))
      }
    }
    walk(corpusRoot)
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const text = readFileSync(f, 'utf-8')
      expect(text.includes('@prefix'), f).toBe(true)
      expect((text.match(/</g) ?? []).length, `${f} unbalanced <`).toBe((text.match(/>/g) ?? []).length)
    }
  })
})
