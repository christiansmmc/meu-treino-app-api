import { z } from 'zod'

/**
 * `workout_exercise.exercise_load` e `workout_record_exercise_set.exercise_load`
 * são ambos `numeric(5, 2)`: no máximo 5 dígitos significativos com 2 casas
 * decimais, ou seja, o maior valor representável é 999.99. Carga negativa não
 * faz sentido físico, por isso o piso é 0. Valores com mais de 2 casas
 * decimais seriam truncados silenciosamente pelo banco — rejeitamos aqui em
 * vez de deixar isso acontecer sem o cliente saber.
 *
 * Compartilhado entre `workout-exercises.routes.ts`, `workouts.routes.ts` e
 * `workout-records.routes.ts`: as três rotas escrevem em colunas `numeric(5, 2)`
 * de carga e têm o mesmo risco de 500 por overflow sem essa validação.
 */
const MAX_EXERCISE_LOAD = 999.99

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Number(value.toFixed(2)) === value
}

export const exerciseLoadSchema = z
  .number()
  .nonnegative()
  .max(MAX_EXERCISE_LOAD)
  .refine(hasAtMostTwoDecimalPlaces, { message: 'Number must have at most 2 decimal places' })
