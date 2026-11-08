/**
 * Entrypoint do container (`bun run start:prod`): migrations → catalog:sync
 * (se `CATALOG_SYNC_ON_START`, default true; pulado se o catálogo não mudou
 * desde o último sync completo) → servidor.
 *
 * Um processo só, em TypeScript, em vez de um `entrypoint.sh`: compartilha o
 * pool do Postgres entre as etapas e não depende de fim de linha LF (o repo é
 * clonado no Windows com `core.autocrlf=true`, e um `.sh` com CRLF quebra no
 * alpine).
 *
 * Falha em qualquer etapa encerra com código 1 e o servidor não sobe: num
 * deploy com health check, a versão anterior continua no ar em vez de uma API
 * nova servindo um schema/catálogo pela metade.
 */
import { env } from './env.ts'
import { runCatalogSync } from './db/catalog-sync.ts'
import { sql } from './db/client.ts'
import { runMigrations } from './db/migrate.ts'

// Bun como PID 1 no container não tem handler default de SIGTERM: sem isso um
// `docker stop` durante a migração esperaria o SIGKILL. A transação aberta
// sofre rollback no Postgres quando a conexão cai.
const abortBoot = () => process.exit(143)
process.on('SIGTERM', abortBoot)
process.on('SIGINT', abortBoot)

try {
  await runMigrations()

  if (env.CATALOG_SYNC_ON_START) {
    // Pula se nada mudou desde o último sync completo (catalog_sync_state):
    // num cold start contra um banco remoto o sync sem mudança custava ~25
    // idas e voltas. Ver catalog-sync.ts.
    await runCatalogSync({ skipIfUnchanged: true })
  } else {
    console.log('catalog:sync pulado (CATALOG_SYNC_ON_START=false).')
  }
} catch (err) {
  console.error('Boot abortado:', err)
  await sql.end({ timeout: 5 })
  process.exit(1)
}

process.off('SIGTERM', abortBoot)
process.off('SIGINT', abortBoot)

// `index.ts` sobe o `Bun.serve` e registra o próprio shutdown.
await import('./index.ts')
