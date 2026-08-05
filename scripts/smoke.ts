/**
 * Smoke test end-to-end contra uma API rodando (Java ou Bun).
 * Uso: BASE_URL=http://localhost:8080/api bun run scripts/smoke.ts
 */
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8080/api'

let token = ''
let passed = 0
let failed = 0

interface Res {
  status: number
  body: any
  headers: Headers
}

async function call(
  method: string,
  path: string,
  options: { body?: unknown; auth?: boolean } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.auth !== false && token) headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })

  const text = await res.text()
  let body: any = null
  if (text.length > 0) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, body, headers: res.headers }
}

function check(label: string, condition: boolean, extra?: unknown) {
  if (condition) {
    passed += 1
    console.log(`  ok   ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL ${label}`, extra === undefined ? '' : JSON.stringify(extra))
  }
}

const email = `smoke_${Date.now()}@test.com`
const password = 'test1234'

console.log(`Smoke em ${BASE_URL}`)

// --- Health -----------------------------------------------------------------
{
  const res = await call('GET', '/health', { auth: false })
  check('GET /health → 200 {status:OK}', res.status === 200 && res.body?.status === 'OK', res.body)
}

// --- Cadastro + login -------------------------------------------------------
{
  const res = await call('POST', '/clients', {
    auth: false,
    body: {
      firstName: 'Smoke',
      lastName: 'Teste',
      weight: 80.5,
      height: 1.8,
      user: { email, password },
    },
  })
  check('POST /clients → 200 {id}', res.status === 200 && typeof res.body?.id === 'number', res.body)
}

{
  const res = await call('POST', '/authenticate', { auth: false, body: { email, password } })
  check('POST /authenticate → 200 {token}', res.status === 200 && !!res.body?.token, res.body)
  token = res.body?.token ?? ''

  const parts = token.split('.')
  const payload = parts[1] ? JSON.parse(Buffer.from(parts[1], 'base64url').toString()) : {}
  check('JWT sub == email', payload.sub === email, payload)
  check('JWT tem roles + exp', Array.isArray(payload.roles) && typeof payload.exp === 'number', payload)
}

{
  const res = await call('POST', '/authenticate', {
    auth: false,
    body: { email, password: 'errada' },
  })
  check('POST /authenticate senha errada → 401', res.status === 401, res.body)
  check(
    'erro tem code/message/path/timestamp',
    !!res.body?.code && !!res.body?.message && 'path' in res.body && !!res.body?.timestamp,
    res.body,
  )
}

// --- Client -----------------------------------------------------------------
{
  const res = await call('GET', '/clients')
  check(
    'GET /clients → dados do logado',
    res.status === 200 && res.body?.user?.email === email && res.body?.weight === 80.5,
    res.body,
  )
}

{
  const res = await call('GET', '/clients', { auth: false })
  check('GET /clients sem token → 401', res.status === 401, res.body)
}

// --- Exercises --------------------------------------------------------------
let exerciseIds: number[] = []
{
  const res = await call('GET', '/exercises')
  const list = Array.isArray(res.body) ? res.body : []
  exerciseIds = list.slice(0, 3).map((e: any) => e.id)
  check('GET /exercises → lista', res.status === 200 && list.length > 0, res.body?.length)
  check(
    'exercise tem id/name/bodyPart',
    list[0] && typeof list[0].id === 'number' && !!list[0].name && !!list[0].bodyPart,
    list[0],
  )
}

{
  const res = await call('GET', '/exercises?body_part=PEITO&body_part=COSTAS')
  const list = Array.isArray(res.body) ? res.body : []
  check(
    'GET /exercises?body_part=PEITO&COSTAS filtra',
    res.status === 200 &&
      list.length > 0 &&
      list.every((e: any) => e.bodyPart === 'PEITO' || e.bodyPart === 'COSTAS'),
    list.length,
  )
}

{
  const res = await call('GET', '/exercises?body_part=INVALIDO')
  check(
    'GET /exercises body_part inválido → 400 ARGUMENT_TYPE_MISMATCH',
    res.status === 400 && res.body?.code === 'ARGUMENT_TYPE_MISMATCH',
    res.body,
  )
}

// --- Workouts ---------------------------------------------------------------
let workoutId = 0
{
  const res = await call('POST', '/workouts', {
    body: {
      workoutName: 'Treino Smoke',
      exercises: [
        { exerciseId: exerciseIds[0], sets: 3, reps: 10, load: 40 },
        { exerciseId: exerciseIds[1] },
      ],
    },
  })
  workoutId = res.body?.id ?? 0
  check('POST /workouts → 201 {id}', res.status === 201 && workoutId > 0, res.body)
  check(
    'POST /workouts → header Location',
    res.headers.get('location') === `/api/workouts/${workoutId}`,
    res.headers.get('location'),
  )
}

{
  const res = await call('POST', '/workouts', { body: { workoutName: '', exercises: [] } })
  check(
    'POST /workouts inválido → 400 VALIDATION_ERROR',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('POST', '/workouts', {
    body: {
      workoutName: 'Treino Smoke Carga Inválida',
      exercises: [{ exerciseId: exerciseIds[0], sets: 3, reps: 10, load: 9999 }],
    },
  })
  check(
    'POST /workouts com load acima do teto → 400 VALIDATION_ERROR, não 500',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('GET', '/workouts')
  const found = (res.body as any[])?.find((w) => w.id === workoutId)
  check(
    'GET /workouts → exerciseCount + bodyParts',
    res.status === 200 && found?.exerciseCount === 2 && Array.isArray(found?.bodyParts),
    found,
  )
}

let workoutExerciseId = 0
{
  const res = await call('GET', `/workouts/${workoutId}`)
  const first = res.body?.workoutExercises?.[0]
  workoutExerciseId = first?.id ?? 0
  check(
    'GET /workouts/{id} → detalhe',
    res.status === 200 && res.body?.workoutExercises?.length === 2,
    res.body,
  )
  check(
    'workoutExercise: sets/reps/exerciseLoad/listOrder/exercise',
    first?.sets === 3 && first?.reps === 10 && first?.exerciseLoad === 40 && first?.listOrder === 0 && !!first?.exercise?.bodyPart,
    first,
  )
  check(
    'campos omitidos viram null',
    res.body?.workoutExercises?.[1]?.sets === null &&
      res.body?.workoutExercises?.[1]?.exerciseLoad === null,
    res.body?.workoutExercises?.[1],
  )
}

{
  const res = await call('PATCH', `/workouts/${workoutId}`, { body: { name: 'Treino Renomeado' } })
  check('PATCH /workouts/{id} → 200 sem body', res.status === 200, res.body)
  const check2 = await call('GET', `/workouts/${workoutId}`)
  check('rename persistiu', check2.body?.name === 'Treino Renomeado', check2.body?.name)
}

{
  const res = await call('PATCH', '/workouts/list-order', {
    body: [{ id: workoutId, listOrder: 7 }],
  })
  check('PATCH /workouts/list-order → 200', res.status === 200, res.body)
  const list = await call('GET', '/workouts')
  const found = (list.body as any[])?.find((w) => w.id === workoutId)
  check('listOrder persistiu', found?.listOrder === 7, found)
}

{
  const res = await call('GET', '/workouts/999999')
  check(
    'GET /workouts/{inexistente} → 404 WORKOUT_NOT_FOUND',
    res.status === 404 && res.body?.code === '003',
    res.body,
  )
}

// --- Workout exercises ------------------------------------------------------
let addedWorkoutExerciseId = 0
{
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 4,
      reps: 8,
      exerciseLoad: 60,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check('POST /workout-exercises → 201 sem body', res.status === 201 && !res.body, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const added = detail.body?.workoutExercises?.find(
    (we: any) => we.exercise.id === exerciseIds[2],
  )
  addedWorkoutExerciseId = added?.id ?? 0
  check('exercício adicionado aparece no detalhe', !!added && added.exerciseLoad === 60, added)
  check('listOrder do novo é o último', added?.listOrder === 2, added?.listOrder)
}

{
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 4,
      reps: 8,
      exerciseLoad: 9999,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad acima do teto → 400 VALIDATION_ERROR, não 500',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 111,
      reps: 111,
      exerciseLoad: 999.99,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[0] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad no teto (999.99) → 201',
    res.status === 201 && !res.body,
    res.body,
  )

  const detail = await call('GET', `/workouts/${workoutId}`)
  const added = detail.body?.workoutExercises?.find(
    (we: any) => we.sets === 111 && we.reps === 111,
  )
  check('exerciseLoad no teto persistiu como 999.99', added?.exerciseLoad === 999.99, added)

  // Limpa a linha extra: só serviu para exercitar o boundary, não faz parte
  // do fluxo principal do smoke test.
  if (added?.id) await call('DELETE', `/workout-exercises/${added.id}`)
}

{
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 4,
      reps: 8,
      exerciseLoad: -1,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad negativo → 400 VALIDATION_ERROR',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  // Mais de 2 casas decimais não é mais rejeitado: é arredondado (meio para
  // cima) antes de gravar, para casar com o que o numeric(5,2) faria de
  // qualquer forma. 15.253 arredonda para baixo, 15.257 arredonda para cima.
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 131,
      reps: 131,
      exerciseLoad: 15.253,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad com 3 casas (15.253) → 201, não 400',
    res.status === 201 && !res.body,
    res.body,
  )

  const detail = await call('GET', `/workouts/${workoutId}`)
  const added = detail.body?.workoutExercises?.find(
    (we: any) => we.sets === 131 && we.reps === 131,
  )
  check('exerciseLoad 15.253 foi arredondado para 15.25', added?.exerciseLoad === 15.25, added)

  if (added?.id) await call('DELETE', `/workout-exercises/${added.id}`)
}

{
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 132,
      reps: 132,
      exerciseLoad: 15.257,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad com 3 casas (15.257) → 201, não 400',
    res.status === 201 && !res.body,
    res.body,
  )

  const detail = await call('GET', `/workouts/${workoutId}`)
  const added = detail.body?.workoutExercises?.find(
    (we: any) => we.sets === 132 && we.reps === 132,
  )
  check('exerciseLoad 15.257 foi arredondado para 15.26', added?.exerciseLoad === 15.26, added)

  if (added?.id) await call('DELETE', `/workout-exercises/${added.id}`)
}

{
  // Caso de borda criado pela troca de ordem (arredondar antes de checar o
  // teto): 999.994 está ACIMA do teto bruto (999.99) mas arredonda para
  // 999.99, exatamente o teto — deve ser aceito. Com a ordem antiga
  // (checar o teto no valor bruto) isso seria rejeitado incorretamente.
  // Não existe o caso inverso (valor <= 999.99 que arredonda para ACIMA do
  // teto): 999.99 já tem a mesma escala do arredondamento, então qualquer
  // valor bruto <= 999.99 arredonda, no máximo, para 999.99 — nunca para
  // 1000.00. Só valores já > 999.99 (portanto já rejeitados de qualquer
  // forma) arredondam para 1000.00.
  const res = await call('POST', '/workout-exercises', {
    body: {
      sets: 133,
      reps: 133,
      exerciseLoad: 999.994,
      workout: { id: workoutId },
      exercise: { id: exerciseIds[2] },
    },
  })
  check(
    'POST /workout-exercises exerciseLoad 999.994 (arredonda para o teto) → 201, não 400',
    res.status === 201 && !res.body,
    res.body,
  )

  const detail = await call('GET', `/workouts/${workoutId}`)
  const added = detail.body?.workoutExercises?.find(
    (we: any) => we.sets === 133 && we.reps === 133,
  )
  check('exerciseLoad 999.994 foi arredondado para 999.99', added?.exerciseLoad === 999.99, added)

  if (added?.id) await call('DELETE', `/workout-exercises/${added.id}`)
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: 55.5 },
  })
  check('PATCH /workout-exercises/{id} → 200', res.status === 200, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const updated = detail.body?.workoutExercises?.find((we: any) => we.id === workoutExerciseId)
  check(
    'update de sets/reps/load persistiu',
    updated?.sets === 5 && updated?.reps === 12 && updated?.exerciseLoad === 55.5,
    updated,
  )
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: null },
  })
  check('PATCH /workout-exercises/{id} load:null → 200', res.status === 200, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const updated = detail.body?.workoutExercises?.find((we: any) => we.id === workoutExerciseId)
  check(
    'load:null grava NULL de verdade (não "null", não 0)',
    updated?.exerciseLoad === null,
    updated,
  )
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12 },
  })
  check(
    'PATCH sem a chave load → 400 VALIDATION_ERROR (nullable, não nullish)',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: 999.99 },
  })
  check('PATCH load no teto da coluna (999.99) → 200', res.status === 200, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const updated = detail.body?.workoutExercises?.find((we: any) => we.id === workoutExerciseId)
  check('load no teto persistiu como 999.99', updated?.exerciseLoad === 999.99, updated)
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: 1000 },
  })
  check(
    'PATCH load acima do teto (1000) → 400 VALIDATION_ERROR, não 500',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: -1 },
  })
  check(
    'PATCH load negativo → 400 VALIDATION_ERROR',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  // Mesmo comportamento de arredondamento do POST (schema compartilhado): o
  // caso de borda do teto pós-arredondamento já foi coberto lá, não precisa
  // repetir aqui.
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: 15.253 },
  })
  check('PATCH load com 3 casas (15.253) → 200, não 400', res.status === 200, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const updated = detail.body?.workoutExercises?.find((we: any) => we.id === workoutExerciseId)
  check('load 15.253 foi arredondado para 15.25', updated?.exerciseLoad === 15.25, updated)
}

{
  const res = await call('PATCH', `/workout-exercises/${workoutExerciseId}`, {
    body: { sets: 5, reps: 12, load: 15.257 },
  })
  check('PATCH load com 3 casas (15.257) → 200, não 400', res.status === 200, res.body)

  const detail = await call('GET', `/workouts/${workoutId}`)
  const updated = detail.body?.workoutExercises?.find((we: any) => we.id === workoutExerciseId)
  check('load 15.257 foi arredondado para 15.26', updated?.exerciseLoad === 15.26, updated)
}

{
  const res = await call('DELETE', `/workout-exercises/${addedWorkoutExerciseId}`)
  check('DELETE /workout-exercises/{id} → 204', res.status === 204 && !res.body, res.body)
}

// --- Workout records --------------------------------------------------------
{
  const res = await call('GET', `/workout-record/last?workoutId=${workoutId}`)
  check(
    'GET /workout-record/last sem registros → 200 body null',
    res.status === 200 && res.body === null,
    res.body,
  )
}

let recordId = 0
{
  const res = await call('POST', '/workout-record', {
    body: {
      workoutId,
      exercises: [
        {
          exerciseId: exerciseIds[0],
          status: 'COMPLETED',
          note: null,
          exerciseSets: [
            { set: 1, reps: 10, exerciseLoad: 40 },
            { set: 2, reps: 8, exerciseLoad: 45 },
          ],
        },
        { exerciseId: exerciseIds[1], status: 'SKIPPED', exerciseSets: [] },
      ],
    },
  })
  recordId = res.body?.id ?? 0
  check('POST /workout-record → 201 full detail', res.status === 201 && recordId > 0, res.body)
  check(
    'detail: date YYYY-MM-DD + workout + exercícios',
    /^\d{4}-\d{2}-\d{2}$/.test(res.body?.date ?? '') &&
      res.body?.workout?.id === workoutId &&
      res.body?.workoutRecordExercises?.length === 2,
    res.body,
  )
  check(
    'sets do record com set/reps/exerciseLoad',
    res.body?.workoutRecordExercises?.[0]?.workoutRecordExerciseSets?.[0]?.set === 1 &&
      res.body?.workoutRecordExercises?.[0]?.workoutRecordExerciseSets?.[1]?.exerciseLoad === 45,
    res.body?.workoutRecordExercises?.[0],
  )
}

{
  const res = await call('POST', '/workout-record', {
    body: {
      workoutId,
      exercises: [
        {
          exerciseId: exerciseIds[0],
          status: 'COMPLETED',
          note: null,
          exerciseSets: [{ set: 1, reps: 10, exerciseLoad: 9999 }],
        },
      ],
    },
  })
  check(
    'POST /workout-record com exerciseLoad acima do teto → 400 VALIDATION_ERROR, não 500',
    res.status === 400 && res.body?.code === 'VALIDATION_ERROR',
    res.body,
  )
}

{
  const res = await call('GET', `/workout-record/last?workoutId=${workoutId}`)
  check('GET /workout-record/last → último registro', res.body?.id === recordId, res.body?.id)
}

{
  const res = await call('GET', `/workout-record/simple?workoutId=${workoutId}&period=CURRENT_MONTH`)
  const list = Array.isArray(res.body) ? res.body : []
  check(
    'GET /workout-record/simple → [{id,date,workout}]',
    res.status === 200 &&
      list.length === 1 &&
      list[0].id === recordId &&
      /^\d{4}-\d{2}-\d{2}$/.test(list[0].date) &&
      list[0].workout?.id === workoutId,
    res.body,
  )
}

{
  const res = await call('GET', '/workout-record/simple?period=ALL')
  check('GET /workout-record/simple?period=ALL → 200', res.status === 200, res.body)
}

{
  const res = await call('DELETE', `/workout-record/${recordId}`)
  check('DELETE /workout-record/{id} → 204', res.status === 204, res.body)

  const last = await call('GET', `/workout-record/last?workoutId=${workoutId}`)
  check('registro deletado sumiu do /last', last.body === null, last.body)
}

// --- Delete workout ---------------------------------------------------------
{
  const res = await call('DELETE', `/workouts/${workoutId}`)
  check('DELETE /workouts/{id} → 204', res.status === 204, res.body)

  const list = await call('GET', '/workouts')
  check(
    'workout deletado sumiu da lista',
    !(list.body as any[])?.some((w) => w.id === workoutId),
    list.body,
  )
}

// --- 404 --------------------------------------------------------------------
{
  const res = await call('GET', '/nao-existe')
  check('rota inexistente → 404 NOT_FOUND', res.status === 404 && res.body?.code === 'NOT_FOUND', res.body)
}

console.log(`\n${passed} passaram, ${failed} falharam`)
process.exit(failed === 0 ? 0 : 1)
