import { fileURLToPath } from 'node:url'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { db, sql } from './client.ts'

/** Relativo a este arquivo, não ao cwd: `src/boot.ts` e o CLI chegam aqui de lugares diferentes. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('./migrations', import.meta.url))

/**
 * Chave fixa do lock que serializa migrations entre processos. Diferente da do
 * `catalog:sync` (que o boot roda logo depois, em outra transação).
 */
const MIGRATION_LOCK_KEY = 7_311_002_500

export async function runMigrations() {
  // Duas instâncias subindo juntas (deploy com mais de uma réplica) liam a
  // mesma "última migration" e aplicavam a próxima em paralelo: a segunda
  // falhava com `column "..." already exists` e o boot abortava. Com o lock, a
  // segunda espera a primeira commitar e não acha mais nada pendente.
  //
  // Lock de TRANSAÇÃO numa conexão reservada só para segurá-lo (o migrator do
  // Drizzle abre a própria transação em outra conexão do pool), não
  // `pg_advisory_lock` de sessão: atrás de um pooler em modo transação (Neon) o
  // lock de sessão pode ficar preso numa conexão do pooler e travar todo boot
  // seguinte. Essa transação não toca em tabela nenhuma, então não bloqueia o
  // DDL da migration.
  await sql.begin(async (lock) => {
    await lock`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`
    await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
  })
  console.log('Migrations aplicadas.')
}

if (import.meta.main) {
  try {
    await runMigrations()
  } finally {
    await sql.end()
  }
}
