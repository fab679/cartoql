import { parse, print } from 'graphql'

/** PRETTIFY: parse → print; null when the document doesn't parse (UI says so, never silently). */
export function prettifyDocument(document: string): string | null {
  try {
    return print(parse(document))
  } catch {
    return null
  }
}
