import { z } from 'zod'

/**
 * `workout_exercise.exercise_load` e `workout_record_exercise_set.exercise_load`
 * são ambos `numeric(5, 2)`: no máximo 5 dígitos significativos com 2 casas
 * decimais, ou seja, o maior valor representável é 999.99. Carga negativa não
 * faz sentido físico, por isso o piso é 0.
 *
 * Valores com mais de 2 casas decimais NÃO são rejeitados: o Postgres já
 * arredonda (não trunca) o excesso de escala ao gravar num `numeric(5, 2)`,
 * e o app em produção facilmente manda 3 casas (o campo antigo propagava
 * precisão completa e só arredondava na exibição). Rejeitar aqui seria uma
 * regressão de comportamento para clientes em campo que hoje gravam sem
 * problema. Em vez disso arredondamos nós mesmos, para 2 casas, ANTES de
 * checar o teto — assim o teto é aplicado sobre o valor que de fato será
 * gravado, e não sobre o valor bruto recebido.
 *
 * Compartilhado entre `workout-exercises.routes.ts`, `workouts.routes.ts` e
 * `workout-records.routes.ts`: as três rotas escrevem em colunas `numeric(5, 2)`
 * de carga e têm o mesmo risco de 500 por overflow sem essa validação.
 */
const MAX_EXERCISE_LOAD = 999.99

/**
 * Arredonda para 2 casas decimais, "meio para cima" (como o Postgres faz ao
 * gravar num `numeric(N, 2)`).
 *
 * `Math.round(v * 100) / 100` e `Number(v.toFixed(2))` são ambos suscetíveis
 * ao clássico problema de ponto flutuante: `1.005` não existe em binário,
 * é armazenado como `1.00499999999999989...`, então os dois devolvem `1.00`
 * onde a leitura decimal (e o Postgres, que faz aritmética decimal exata)
 * dão `1.01`. Só que `(1.005).toString() === '1.005'` — o JS sempre imprime
 * a menor string decimal que volta a gerar o mesmo double — então dá para
 * reconstruir os dígitos decimais originais a partir da string e arredondar
 * sobre eles, sem depender de multiplicação em ponto flutuante. Para os
 * valores desse campo (carga de treino, no máximo 3 dígitos antes da
 * vírgula) isso reproduz fielmente o que o cliente digitou.
 */
function roundToTwoDecimals(value: number): number {
  const str = value.toString()
  if (!/^-?\d+(\.\d+)?$/.test(str)) {
    // Notação exponencial: só acontece para valores extremos (ex.: 1e-7),
    // onde a diferença entre os métodos de arredondamento é irrelevante.
    return Math.round(value * 100) / 100
  }

  // `nonnegative()` runs before this transform, so `value` is never negative
  // in practice — this branch is unreachable today. Kept for robustness in
  // case the chain order ever changes; the sign handling is correct either way.
  const negative = str.startsWith('-')
  const [intPart, fracPart = ''] = (negative ? str.slice(1) : str).split('.')
  if (fracPart.length <= 2) return value

  const cents = Number(intPart) * 100 + Number(fracPart.slice(0, 2))
  const roundUp = Number(fracPart[2]) >= 5
  const result = (roundUp ? cents + 1 : cents) / 100
  return negative ? -result : result
}

export const exerciseLoadSchema = z
  .number()
  .nonnegative()
  .transform(roundToTwoDecimals)
  .pipe(z.number().max(MAX_EXERCISE_LOAD))
