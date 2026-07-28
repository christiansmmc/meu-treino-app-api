import { isNull } from 'drizzle-orm'
import { BODY_PARTS, type BodyPart, exercise } from './schema.ts'
import { db, sql } from './client.ts'

const CSV_PATH = new URL('../../data/exercise.csv', import.meta.url)

interface CatalogRow {
  name: string
  bodyPart: BodyPart
}

function parseCatalog(csv: string): CatalogRow[] {
  const lines = csv.trim().split('\n').slice(1)
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.lastIndexOf(',')
      const name = line.slice(0, separator).trim()
      const bodyPart = line.slice(separator + 1).trim()
      if (!(BODY_PARTS as readonly string[]).includes(bodyPart)) {
        throw new Error(`body_part inválido no CSV: "${bodyPart}" (linha: ${line})`)
      }
      return { name, bodyPart: bodyPart as BodyPart }
    })
}

const catalog = parseCatalog(await Bun.file(CSV_PATH).text())

// Só o catálogo global (client_id NULL) é semeado; exercícios custom ficam intactos.
const existing = await db
  .select({ name: exercise.name, bodyPart: exercise.bodyPart })
  .from(exercise)
  .where(isNull(exercise.clientId))

const known = new Set(existing.map((row) => `${row.bodyPart}::${row.name}`))
const missing = catalog.filter((row) => !known.has(`${row.bodyPart}::${row.name}`))

if (missing.length === 0) {
  console.log(`Catálogo já atualizado (${existing.length} exercícios globais).`)
} else {
  await db.insert(exercise).values(
    missing.map((row) => ({ name: row.name, bodyPart: row.bodyPart, clientId: null })),
  )
  console.log(`${missing.length} exercícios inseridos (total: ${existing.length + missing.length}).`)
}

await sql.end()
