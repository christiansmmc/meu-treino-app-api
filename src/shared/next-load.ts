import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import { db } from '../db/client.ts'
import { workout, workoutRecord, workoutRecordExercise } from '../db/schema.ts'

/** Marca que a tela mostra: `KEEP` apaga, então só sobram as duas setas. */
export type NextLoadHint = 'UP' | 'UP_MORE'

/**
 * Marca "subir carga" vigente de cada exercício do cliente: a do registro mais recente em que ele foi concluído
 * (`next_load` não nulo), em qualquer treino. Registro apagado não conta; treino apagado conta (a marca é do
 * exercício, não do treino). Uma consulta só, para todos os exercícios pedidos. Exercício sem marca ou com `KEEP`
 * fica fora do mapa.
 */
export async function latestNextLoads(
  clientId: number,
  exerciseIds: number[],
): Promise<Map<number, NextLoadHint>> {
  const hints = new Map<number, NextLoadHint>()
  if (exerciseIds.length === 0) return hints

  const rows = await db
    .selectDistinctOn([workoutRecordExercise.exerciseId], {
      exerciseId: workoutRecordExercise.exerciseId,
      nextLoad: workoutRecordExercise.nextLoad,
    })
    .from(workoutRecordExercise)
    .innerJoin(workoutRecord, eq(workoutRecord.id, workoutRecordExercise.workoutRecordId))
    .innerJoin(workout, eq(workout.id, workoutRecord.workoutId))
    .where(
      and(
        eq(workout.clientId, clientId),
        isNull(workoutRecord.deletedAt),
        isNotNull(workoutRecordExercise.nextLoad),
        inArray(workoutRecordExercise.exerciseId, [...new Set(exerciseIds)]),
      ),
    )
    .orderBy(
      workoutRecordExercise.exerciseId,
      desc(workoutRecord.createdAt),
      desc(workoutRecord.id),
      desc(workoutRecordExercise.id),
    )

  for (const row of rows) {
    if (row.nextLoad === 'UP' || row.nextLoad === 'UP_MORE') hints.set(row.exerciseId, row.nextLoad)
  }
  return hints
}
