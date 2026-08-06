import { and, eq, inArray, isNull, or } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { exercise } from '../db/schema.ts'
import type { ClientRow } from '../types.ts'
import { AppError, ErrorType } from './errors.ts'

/**
 * Um exercício é acessível pelo cliente quando é global (`clientId` nulo) ou
 * pertence a ele mesmo. Usado por `workouts.routes.ts`,
 * `workout-records.routes.ts` e `workout-exercises.routes.ts` — as três
 * escrevem FKs para `exercise` a partir de um id enviado pelo cliente e têm o
 * mesmo risco de aceitar/vazar exercício alheio (bigserial sequencial, fácil
 * de adivinhar) sem essa checagem.
 *
 * Historicamente essa função existia em três cópias, uma por módulo; elas
 * divergiram (uma delas deixou de filtrar por cliente) e nada estrutural
 * notou. Centralizada aqui para que `bun run typecheck`/import único torne
 * essa divergência impossível de novo — não só "de boa vontade".
 */
export async function assertExercisesExist(client: ClientRow, ids: number[]) {
  if (ids.length === 0) return
  const rows = await db
    .select({ id: exercise.id })
    .from(exercise)
    .where(
      and(
        inArray(exercise.id, ids),
        or(isNull(exercise.clientId), eq(exercise.clientId, client.id)),
      ),
    )

  const found = new Set(rows.map((r) => r.id))
  for (const id of ids) {
    if (!found.has(id)) throw new AppError(ErrorType.EXERCISE_NOT_FOUND, 404)
  }
}

/** Variante de um único id, para `POST /workout-exercises`. */
export async function assertExerciseExists(client: ClientRow, id: number) {
  await assertExercisesExist(client, [id])
}
