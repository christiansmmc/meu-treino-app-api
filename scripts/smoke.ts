/**
 * Smoke test end-to-end contra uma API rodando (Java ou Bun).
 *
 * Precisa de duas env vars, não só `BASE_URL`:
 * - `BASE_URL`: onde a API alvo está escutando.
 * - `DATABASE_URL`: aponta para o MESMO banco que essa API usa. O script
 *   importa `../src/db/client.ts`, que abre um pool Postgres já no load do
 *   módulo, e o bloco de isolamento entre clientes escreve direto nesse
 *   banco (insere um exercício custom, lê o id do cliente). Um
 *   `DATABASE_URL` apontando para outro banco falha longe do ponto real:
 *   a busca do cliente não acha nada, o id cai para `0`, e o insert
 *   seguinte estoura uma FK não tratada, matando a suíte no meio sem
 *   imprimir o resumo.
 *
 * Uso: BASE_URL=http://localhost:8080/api DATABASE_URL=postgres://... bun run scripts/smoke.ts
 */
import { eq, inArray } from 'drizzle-orm'
import {
  CATALOG_FILE,
  LEGACY_MAP_FILE,
  parseCatalog,
  parseLegacyMap,
  syncCatalog,
} from '../src/db/catalog-sync.ts'
import { db, sql } from '../src/db/client.ts'
import { client as clientTable, exercise, users, workoutExercise } from '../src/db/schema.ts'

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

/**
 * Como `check`, mas para pré-condições cuja falha invalida blocos
 * posteriores (ex.: restaurar a senha principal antes de blocos que
 * dependem dela). `check` sozinho registraria a falha e o script seguiria
 * em frente com uma premissa falsa — e aí a falha real aparece só nos
 * blocos dependentes, mais abaixo (ex.: `DELETE /clients → 204` falhando
 * porque a senha não é a que o script pensa que é), apontando para o
 * sintoma errado. `fatal` registra e interrompe ali mesmo.
 */
function fatal(label: string, extra?: unknown): never {
  failed += 1
  console.log(`  FATAL ${label}`, extra === undefined ? '' : JSON.stringify(extra))
  throw new Error(`smoke abortado: ${label}`)
}

const email = `smoke_${Date.now()}@test.com`
const password = 'test1234'

console.log(`Smoke em ${BASE_URL}`)

// O corpo inteiro fica dentro do try/finally abaixo (ver o fechamento no fim
// do arquivo) para que `sql.end()` e o resumo passaram/falharam rodem mesmo
// quando algo lança (ex.: `fatal()`) — sem isso, um throw pulava os dois,
// exatamente a falha que o docstring do topo do arquivo alerta. Deliberadamente
// NÃO reindentado: são ~1300 linhas, e reindentar tudo só pra caber dentro do
// `try` infla o diff sem mudar comportamento nenhum.
try {
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

// --- Cadastro: mínimo de senha alinhado com PATCH /clients/password ---------
// `createClientSchema` e `changePasswordSchema` precisam concordar em min(6)
// (ver comentário em `clients.routes.ts`); senão dá pra criar conta com senha
// que o próprio endpoint de trocar senha recusaria depois.
{
  const emailCurta = `smoke_curta_${Date.now()}@test.com`
  const curta = await call('POST', '/clients', {
    auth: false,
    body: { firstName: 'Smoke', lastName: 'Curta', user: { email: emailCurta, password: '12345' } },
  })
  check(
    'POST /clients senha com 5 caracteres → 400 código 009 (não o envelope genérico do zod)',
    curta.status === 400 && curta.body?.code === '009',
    curta.body,
  )

  const emailMinima = `smoke_minima_${Date.now()}@test.com`
  const senhaMinima = '123456'
  const minima = await call('POST', '/clients', {
    auth: false,
    body: { firstName: 'Smoke', lastName: 'Minima', user: { email: emailMinima, password: senhaMinima } },
  })
  check(
    'POST /clients senha com 6 caracteres → 200 {id}',
    minima.status === 200 && typeof minima.body?.id === 'number',
    minima.body,
  )

  // Limpa a conta criada só para provar o mínimo de 6 chars: troca o token
  // module-scope temporariamente para ela se autodeletar, sem afetar a conta
  // principal (`email`/`password`) usada pelo resto do smoke.
  if (minima.status === 200) {
    const tokenPrincipal = token
    const loginMinima = await call('POST', '/authenticate', {
      auth: false,
      body: { email: emailMinima, password: senhaMinima },
    })
    token = loginMinima.body?.token ?? ''
    const delMinima = await call('DELETE', '/clients', { body: { password: senhaMinima } })
    check('DELETE /clients conta senha mínima → 204 (limpeza)', delMinima.status === 204, delMinima.body)
    token = tokenPrincipal
  }
}

// --- Cadastro: peso/altura usam os mesmos limites de PATCH /clients --------
// `createClientSchema` usava `z.number()` cru para weight/height, sem o teto
// que `clientWeightSchema`/`clientHeightSchema` aplicam em PATCH /clients.
// `height: 175` (erro de digitação óbvio — 1,75m digitado sem a vírgula, e o
// campo de altura do cadastro não tem validador nem formatter no app) chega
// direto em `numeric(3, 2)` e o Postgres estoura `numeric field overflow`,
// virando 500 em vez de 400. Espelha os checks de teto de `PATCH /clients`,
// mas contra `POST /clients`.
{
  const tokenPrincipal = token

  const emailAltura = `smoke_altura_${Date.now()}@test.com`
  const alturaEstoura = await call('POST', '/clients', {
    auth: false,
    body: {
      firstName: 'Smoke',
      lastName: 'Altura',
      height: 175,
      user: { email: emailAltura, password },
    },
  })
  check(
    'POST /clients altura acima do teto (175, erro de digitação típico) → 400, não 500',
    alturaEstoura.status === 400,
    alturaEstoura.body,
  )

  const emailPeso = `smoke_peso_${Date.now()}@test.com`
  const pesoEstoura = await call('POST', '/clients', {
    auth: false,
    body: {
      firstName: 'Smoke',
      lastName: 'Peso',
      weight: 1000,
      user: { email: emailPeso, password },
    },
  })
  check(
    'POST /clients peso acima do teto (1000) → 400, não 500',
    pesoEstoura.status === 400,
    pesoEstoura.body,
  )

  const emailTeto = `smoke_teto_${Date.now()}@test.com`
  const noTeto = await call('POST', '/clients', {
    auth: false,
    body: {
      firstName: 'Smoke',
      lastName: 'Teto',
      weight: 999.99,
      height: 9.99,
      user: { email: emailTeto, password },
    },
  })
  check(
    'POST /clients peso e altura exatamente no teto (999.99 / 9.99) → 200, aceitos',
    noTeto.status === 200 && typeof noTeto.body?.id === 'number',
    noTeto.body,
  )

  // Limpa a única conta que de fato foi criada (a do teto): loga com ela e se
  // autodeleta, sem afetar a conta principal do smoke.
  if (noTeto.status === 200) {
    const loginTeto = await call('POST', '/authenticate', {
      auth: false,
      body: { email: emailTeto, password },
    })
    token = loginTeto.body?.token ?? ''
    const delTeto = await call('DELETE', '/clients', { body: { password } })
    check('DELETE /clients conta no teto → 204 (limpeza)', delTeto.status === 204, delTeto.body)
  }

  token = tokenPrincipal
}

// --- A6: POST /clients concorrente no mesmo e-mail nunca 500 ---------------
// O SELECT que checa e-mail duplicado e o INSERT não são atômicos entre si:
// dois cadastros simultâneos para o mesmo e-mail podem ambos passar pelo
// SELECT antes de qualquer um commitar. O índice único por trás garante que
// só um vence — sem tratar o `PostgresError` 23505 do perdedor, ele recebia
// 500 em vez do 400 EMAIL_ALREADY_EXISTS que o caminho do SELECT já dá.
// Determinístico (não depende de qual dos dois "ganha"): o índice único do
// Postgres garante que exatamente um dos dois commita.
{
  const emailCorrida = `smoke_corrida_${Date.now()}@test.com`
  const [corridaA, corridaB] = await Promise.all([
    call('POST', '/clients', {
      auth: false,
      body: { firstName: 'Smoke', lastName: 'CorridaA', user: { email: emailCorrida, password } },
    }),
    call('POST', '/clients', {
      auth: false,
      body: { firstName: 'Smoke', lastName: 'CorridaB', user: { email: emailCorrida, password } },
    }),
  ])
  const statusesCorrida = [corridaA.status, corridaB.status].sort()
  const perdedor = corridaA.status === 400 ? corridaA : corridaB
  check(
    'POST /clients concorrentes no mesmo e-mail → um 200 e um 400 EMAIL_ALREADY_EXISTS, nunca 500',
    statusesCorrida[0] === 200 &&
      statusesCorrida[1] === 400 &&
      perdedor.body?.code === 'EMAIL_ALREADY_EXISTS',
    { a: corridaA.status, b: corridaB.status, aBody: corridaA.body, bBody: corridaB.body },
  )

  // Limpa a conta que venceu a corrida.
  const tokenPrincipalCorrida = token
  const loginCorrida = await call('POST', '/authenticate', {
    auth: false,
    body: { email: emailCorrida, password },
  })
  token = loginCorrida.body?.token ?? ''
  const delCorrida = await call('DELETE', '/clients', { body: { password } })
  check(
    'DELETE /clients conta vencedora da corrida de e-mail → 204 (limpeza)',
    delCorrida.status === 204,
    delCorrida.body,
  )
  token = tokenPrincipalCorrida
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
/** Primeiro exercício do catálogo com imagem — base dos checks de detalhe e de mídia. */
let exerciseWithImage: any = null
{
  const res = await call('GET', '/exercises')
  const list = Array.isArray(res.body) ? res.body : []
  exerciseIds = list.slice(0, 3).map((e: any) => e.id)
  exerciseWithImage = list.find((e: any) => typeof e.imageUrl === 'string') ?? null
  check('GET /exercises → lista', res.status === 200 && list.length > 0, res.body?.length)
  check(
    'exercise tem id/name/bodyPart',
    list[0] && typeof list[0].id === 'number' && !!list[0].name && !!list[0].bodyPart,
    list[0],
  )
  check(
    'exercise tem equipment/target/imageUrl (imageUrl null ou /api/media/...), sem mediaAttribution',
    list.length > 0 &&
      list.every(
        (e: any) =>
          'equipment' in e &&
          'target' in e &&
          // Crédito da mídia só no detalhe (`GET /exercises/{id}`), não na lista.
          !('mediaAttribution' in e) &&
          (e.imageUrl === null || (typeof e.imageUrl === 'string' && e.imageUrl.startsWith('/api/media/'))),
      ),
    list[0],
  )
  // Mesmo collator do handler: ordem alfabética pt-BR, não por body_part/id.
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true })
  check(
    'GET /exercises vem ordenado por nome (pt-BR)',
    list.every((e: any, i: number) => i === 0 || collator.compare(list[i - 1].name, e.name) <= 0),
    list.slice(0, 5).map((e: any) => e.name),
  )
}

{
  const res = await call('GET', '/exercises', { auth: false })
  check('GET /exercises sem token → 401', res.status === 401, res.body)
}

// Resposta JSON comprimida quando o cliente aceita gzip (o Dart aceita e
// descompacta sozinho). `decompress: false` (Bun) devolve os bytes crus para
// provar que vieram mesmo em gzip, não só o header.
{
  const res = await fetch(`${BASE_URL}/exercises`, {
    headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' },
    decompress: false,
  } as RequestInit)
  const bytes = new Uint8Array(await res.arrayBuffer())
  check(
    'GET /exercises com Accept-Encoding: gzip → Content-Encoding gzip',
    res.status === 200 &&
      res.headers.get('content-encoding') === 'gzip' &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x8b,
    { status: res.status, encoding: res.headers.get('content-encoding') },
  )
}

{
  const target = exerciseWithImage ?? null
  const res = target ? await call('GET', `/exercises/${target.id}`) : null
  const d = res?.body
  check(
    'GET /exercises/{id} → detalhe completo',
    !!target &&
      res?.status === 200 &&
      d?.id === target.id &&
      d?.name === target.name &&
      d?.bodyPart === target.bodyPart &&
      'nameEn' in d &&
      'equipment' in d &&
      'target' in d &&
      'category' in d &&
      'mediaAttribution' in d &&
      Array.isArray(d?.secondaryMuscles) &&
      Array.isArray(d?.instructions) &&
      Array.isArray(d?.images) &&
      d.images.every((u: unknown) => typeof u === 'string' && u.startsWith('/api/media/')) &&
      (d?.videoUrl === null || (typeof d?.videoUrl === 'string' && d.videoUrl.startsWith('/api/media/'))) &&
      d?.imageUrl === (d?.images?.[0] ?? null) &&
      d?.imageUrl === target.imageUrl,
    target ? d : 'nenhum exercício do catálogo tem imagem — o catálogo/fixture precisa de pelo menos um',
  )
}

{
  const res = await call('GET', '/exercises/abc')
  check(
    'GET /exercises/{id} não numérico → 400 ARGUMENT_TYPE_MISMATCH',
    res.status === 400 && res.body?.code === 'ARGUMENT_TYPE_MISMATCH',
    res.body,
  )
  const missing = await call('GET', '/exercises/999999999')
  check(
    'GET /exercises/{inexistente} → 404 código 007',
    missing.status === 404 && missing.body?.code === '007',
    missing.body,
  )
}

// --- Media ------------------------------------------------------------------
// Público: `Image.network`/<img> não mandam Authorization. `imageUrl` é
// origin-relative (`/api/media/...`), então resolve contra a origem de BASE_URL.
{
  const origin = new URL(BASE_URL).origin
  if (exerciseWithImage) {
    const url = `${origin}${exerciseWithImage.imageUrl}`
    const res = await fetch(url)
    const bytes = new Uint8Array(await res.arrayBuffer())
    check(
      'GET imageUrl sem token → 200 imagem + Cache-Control immutable',
      res.status === 200 &&
        (res.headers.get('content-type') ?? '').startsWith('image/') &&
        (res.headers.get('cache-control') ?? '').includes('immutable') &&
        bytes.length > 0 &&
        Number(res.headers.get('content-length')) === bytes.length,
      {
        url,
        status: res.status,
        type: res.headers.get('content-type'),
        hint: res.status === 404 ? 'MEDIA_DIR da API está populado?' : undefined,
      },
    )

    const ranged = await fetch(url, { headers: { Range: 'bytes=0-9' } })
    const rangedBytes = new Uint8Array(await ranged.arrayBuffer())
    check(
      'GET imageUrl com Range: bytes=0-9 → 206 parcial',
      ranged.status === 206 &&
        rangedBytes.length === 10 &&
        ranged.headers.get('content-range') === `bytes 0-9/${bytes.length}` &&
        rangedBytes.every((b, i) => b === bytes[i]),
      { status: ranged.status, range: ranged.headers.get('content-range'), length: rangedBytes.length },
    )

    const unsatisfiable = await fetch(url, { headers: { Range: `bytes=${bytes.length + 10}-` } })
    check(
      'GET imageUrl com Range fora do arquivo → 416',
      unsatisfiable.status === 416,
      unsatisfiable.status,
    )
  } else {
    check('catálogo tem ao menos um exercício com imageUrl (para testar /media)', false)
  }

  // Path traversal: `%2f`/`%5c` codificados viram separador só DEPOIS de
  // decodificados, e `..` literal é normalizado pelo próprio fetch — por isso
  // as variantes codificadas. Todas têm que dar o 404 padrão, nunca 200.
  const attempts = [
    '/api/media/..%2f..%2fpackage.json',
    '/api/media/..%2F..%2F.env',
    '/api/media/exercises/..%5c..%5cpackage.json',
    '/api/media/%2e%2e%2f%2e%2e%2fpackage.json',
    '/api/media/.env',
    '/api/media/exercises',
    '/api/media/nao-existe.jpg',
    '/api/media/package.json',
  ]
  const results = await Promise.all(
    attempts.map(async (path) => {
      const res = await fetch(`${origin}${path}`)
      const body = await res.text()
      return { path, status: res.status, json: body.includes('"NOT_FOUND"') }
    }),
  )
  check(
    'GET /media com traversal/arquivo inexistente/extensão fora da allowlist → 404 NOT_FOUND',
    results.every((r) => r.status === 404 && r.json),
    results.filter((r) => r.status !== 404 || !r.json),
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
    'workoutExercise.exercise traz imageUrl (string /api/media/... ou null)',
    (res.body?.workoutExercises ?? []).length > 0 &&
      res.body.workoutExercises.every(
        (we: any) =>
          'imageUrl' in (we.exercise ?? {}) &&
          (we.exercise.imageUrl === null || we.exercise.imageUrl.startsWith('/api/media/')),
      ),
    res.body?.workoutExercises?.map((we: any) => we.exercise),
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

// --- Ordem dos exercícios do treino -----------------------------------------
// `PATCH /workouts/{id}/exercise-order` recebe a lista COMPLETA dos
// workoutExercise do treino na nova ordem. Qualquer lista que não seja
// exatamente o conjunto atual (faltando, sobrando, repetida, de outro treino)
// é recusada com 409 — o app estava com uma versão velha do treino.
let orderWorkoutId = 0
{
  const created = await call('POST', '/workouts', {
    body: {
      workoutName: 'Treino Smoke Ordem',
      exercises: exerciseIds.slice(0, 3).map((exerciseId) => ({ exerciseId })),
    },
  })
  orderWorkoutId = created.body?.id ?? 0
  check('POST /workouts (setup da ordem dos exercícios) → 201', created.status === 201, created.body)

  const before = await call('GET', `/workouts/${orderWorkoutId}`)
  const ids: number[] = (before.body?.workoutExercises ?? []).map((we: any) => we.id)
  check(
    'POST /workouts grava os exercícios na ordem do array',
    JSON.stringify(before.body?.workoutExercises?.map((we: any) => we.exercise.id)) ===
      JSON.stringify(exerciseIds.slice(0, 3)),
    before.body?.workoutExercises,
  )

  const [a, b, c] = ids as [number, number, number]
  const novaOrdem = [c, a, b]
  const res = await call('PATCH', `/workouts/${orderWorkoutId}/exercise-order`, {
    body: { workoutExerciseIds: novaOrdem },
  })
  check('PATCH /workouts/{id}/exercise-order → 200 sem body', res.status === 200 && res.body === null, res.body)

  const after = await call('GET', `/workouts/${orderWorkoutId}`)
  check(
    'GET /workouts/{id} devolve a nova ordem, com listOrder 0..n-1',
    JSON.stringify(after.body?.workoutExercises?.map((we: any) => [we.id, we.listOrder])) ===
      JSON.stringify([
        [c, 0],
        [a, 1],
        [b, 2],
      ]),
    after.body?.workoutExercises,
  )

  const full = await call('GET', '/workouts/full')
  const fullWorkout = (full.body as any[])?.find((w) => w.id === orderWorkoutId)
  check(
    'GET /workouts/full segue a nova ordem',
    JSON.stringify(fullWorkout?.exercises?.map((e: any) => e.listOrder)) === JSON.stringify([0, 1, 2]) &&
      fullWorkout?.exercises?.[0]?.name === after.body?.workoutExercises?.[0]?.exercise?.name,
    fullWorkout,
  )

  const recusadas: [string, unknown[]][] = [
    ['lista incompleta', [c, a]],
    ['id repetido', [c, a, a]],
    ['id a mais', [c, a, b, workoutExerciseId]],
    ['id de outro treino no lugar de um deste', [c, a, workoutExerciseId]],
    ['lista vazia', []],
  ]
  for (const [caso, lista] of recusadas) {
    const r = await call('PATCH', `/workouts/${orderWorkoutId}/exercise-order`, {
      body: { workoutExerciseIds: lista },
    })
    check(
      `PATCH exercise-order com ${caso} → 409 código 010`,
      r.status === 409 && r.body?.code === '010',
      r.body,
    )
  }

  const unchanged = await call('GET', `/workouts/${orderWorkoutId}`)
  check(
    'ordem não muda depois das listas recusadas',
    JSON.stringify(unchanged.body?.workoutExercises?.map((we: any) => we.id)) === JSON.stringify(novaOrdem),
    unchanged.body?.workoutExercises,
  )

  const invalido = await call('PATCH', `/workouts/${orderWorkoutId}/exercise-order`, {
    body: { workoutExerciseIds: 'x' },
  })
  check(
    'PATCH exercise-order com body inválido → 400 VALIDATION_ERROR',
    invalido.status === 400 && invalido.body?.code === 'VALIDATION_ERROR',
    invalido.body,
  )

  const inexistente = await call('PATCH', '/workouts/999999/exercise-order', {
    body: { workoutExerciseIds: novaOrdem },
  })
  check(
    'PATCH exercise-order de treino inexistente → 404 código 003',
    inexistente.status === 404 && inexistente.body?.code === '003',
    inexistente.body,
  )

  const idTexto = await call('PATCH', '/workouts/abc/exercise-order', {
    body: { workoutExerciseIds: novaOrdem },
  })
  check(
    'PATCH exercise-order com id não numérico → 400 ARGUMENT_TYPE_MISMATCH',
    idTexto.status === 400 && idTexto.body?.code === 'ARGUMENT_TYPE_MISMATCH',
    idTexto.body,
  )
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

// --- load_updated_at: quando a CARGA mudou por último ----------------------
// Não muda com séries/reps nem com a reordenação (que mexem em `updated_at`).
// SQL direto, sem depender do schema do Drizzle.
async function loadUpdatedAtOf(id: number): Promise<Date | null> {
  const [row] = await sql`select load_updated_at from workout_exercise where id = ${id}`
  // O cliente desta API devolve `timestamp` como texto ("2026-11-11 17:12:16.125").
  const value = row?.load_updated_at as string | Date | null | undefined
  if (value == null) return null
  return value instanceof Date ? value : new Date(value.replace(' ', 'T'))
}
{
  const created = await call('POST', '/workouts', {
    body: {
      workoutName: 'Treino Smoke Carga',
      exercises: [
        { exerciseId: exerciseIds[0], sets: 3, reps: 10, load: 40 },
        { exerciseId: exerciseIds[1] },
      ],
    },
  })
  const loadWorkoutId = created.body?.id ?? 0
  const detail = await call('GET', `/workouts/${loadWorkoutId}`)
  const [comCarga, semCarga] = (detail.body?.workoutExercises ?? []).map((we: any) => we.id as number)
  const t0 = await loadUpdatedAtOf(comCarga ?? 0)
  check(
    'POST /workouts grava load_updated_at só em quem tem carga',
    t0 instanceof Date && (await loadUpdatedAtOf(semCarga ?? 0)) === null,
    { t0 },
  )

  await Bun.sleep(5)
  await call('PATCH', `/workout-exercises/${comCarga}`, { body: { sets: 3, reps: 10, load: 45 } })
  const t1 = await loadUpdatedAtOf(comCarga ?? 0)
  check(
    'PATCH /workout-exercises/{id} que muda a carga atualiza load_updated_at',
    t0 instanceof Date && t1 instanceof Date && t1.getTime() > t0.getTime(),
    { t0, t1 },
  )

  await Bun.sleep(5)
  await call('PATCH', `/workout-exercises/${comCarga}`, { body: { sets: 4, reps: 12, load: 45 } })
  const t2 = await loadUpdatedAtOf(comCarga ?? 0)
  check(
    'PATCH /workout-exercises/{id} só com séries/reps não muda load_updated_at',
    t1 instanceof Date && t2 instanceof Date && t2.getTime() === t1.getTime(),
    { t1, t2 },
  )

  await Bun.sleep(5)
  await call('PATCH', `/workouts/${loadWorkoutId}/exercise-order`, {
    body: { workoutExerciseIds: [semCarga, comCarga] },
  })
  const t3 = await loadUpdatedAtOf(comCarga ?? 0)
  check(
    'PATCH /workouts/{id}/exercise-order não muda load_updated_at',
    t2 instanceof Date && t3 instanceof Date && t3.getTime() === t2.getTime(),
    { t2, t3 },
  )

  await call('POST', '/workout-exercises', {
    body: { sets: 3, reps: 10, exerciseLoad: 22, workout: { id: loadWorkoutId }, exercise: { id: exerciseIds[2] } },
  })
  const afterAdd = await call('GET', `/workouts/${loadWorkoutId}`)
  const adicionado = (afterAdd.body?.workoutExercises ?? []).find((we: any) => we.exercise.id === exerciseIds[2])
  check(
    'POST /workout-exercises com carga grava load_updated_at',
    (await loadUpdatedAtOf(adicionado?.id ?? 0)) instanceof Date,
    adicionado,
  )
}

// --- Cargas entre treinos ---------------------------------------------------
// `GET /exercise-loads`: a carga de cada exercício pedido em todos os treinos
// ativos do cliente. O cliente do smoke já tem outros treinos com
// exerciseIds[0] (blocos acima), então as checagens olham os treinos daqui.
const cargaTreinoIds: number[] = []
{
  const criar = async (workoutName: string, load?: number) =>
    (
      await call('POST', '/workouts', {
        body: { workoutName, exercises: [{ exerciseId: exerciseIds[0], sets: 3, reps: 10, load }] },
      })
    ).body?.id ?? 0
  const comCarga = await criar('Treino Smoke Cargas 1', 30)
  const semCarga = await criar('Treino Smoke Cargas 2')
  const apagado = await criar('Treino Smoke Cargas Apagado', 50)
  await call('DELETE', `/workouts/${apagado}`)
  cargaTreinoIds.push(comCarga, semCarga)

  const res = await call('GET', `/exercise-loads?exerciseIds=${exerciseIds[0]}`)
  const item = (res.body as any[])?.[0]
  const entries: any[] = item?.entries ?? []
  const doTreino = (id: number) => entries.find((e) => e.workoutId === id)
  check(
    'GET /exercise-loads lista o exercício nos treinos ativos',
    res.status === 200 &&
      item?.exerciseId === exerciseIds[0] &&
      doTreino(comCarga)?.load === 30 &&
      doTreino(comCarga)?.workoutName === 'Treino Smoke Cargas 1' &&
      typeof doTreino(comCarga)?.workoutExerciseId === 'number' &&
      doTreino(semCarga)?.load === null &&
      doTreino(semCarga)?.loadUpdatedAt === null &&
      doTreino(apagado) === undefined,
    res.body,
  )

  const datas = entries.map((e) => e.loadUpdatedAt)
  const primeiroNulo = datas.indexOf(null)
  const comData = (primeiroNulo === -1 ? datas : datas.slice(0, primeiroNulo)) as string[]
  check(
    'GET /exercise-loads ordena pela carga mudada por último',
    entries.length >= 2 &&
      (primeiroNulo === -1 || datas.slice(primeiroNulo).every((d) => d === null)) &&
      comData.every((d, i) => i === 0 || Date.parse(comData[i - 1]!) >= Date.parse(d)) &&
      comData.every((d) => !Number.isNaN(Date.parse(d))),
    datas,
  )

  const catalogo = await call('GET', '/exercises')
  const foraDeTreinos = (catalogo.body as any[])?.find((e) => !exerciseIds.includes(e.id))?.id
  const vazio = await call('GET', `/exercise-loads?exerciseIds=${foraDeTreinos},${exerciseIds[0]},${foraDeTreinos}`)
  check(
    'GET /exercise-loads com exercício fora de treinos → entries [] (um item por id, na ordem pedida)',
    vazio.status === 200 &&
      vazio.body?.length === 2 &&
      vazio.body[0]?.exerciseId === foraDeTreinos &&
      Array.isArray(vazio.body[0]?.entries) &&
      vazio.body[0].entries.length === 0 &&
      vazio.body[1]?.exerciseId === exerciseIds[0],
    vazio.body,
  )

  for (const [caso, query] of [
    ['sem exerciseIds', ''],
    ['com exerciseIds=abc', '?exerciseIds=abc'],
  ] as const) {
    const r = await call('GET', `/exercise-loads${query}`)
    check(
      `GET /exercise-loads ${caso} → 400 VALIDATION_ERROR`,
      r.status === 400 && r.body?.code === 'VALIDATION_ERROR',
      r.body,
    )
  }
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
  check(
    'workoutRecordExercise.exercise traz id/name/bodyPart/imageUrl',
    (res.body?.workoutRecordExercises ?? []).length === 2 &&
      res.body.workoutRecordExercises.every(
        (wre: any) =>
          typeof wre.exercise?.id === 'number' &&
          !!wre.exercise?.name &&
          !!wre.exercise?.bodyPart &&
          'imageUrl' in wre.exercise,
      ),
    res.body?.workoutRecordExercises?.map((wre: any) => wre.exercise),
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
  // Mesmo comportamento de arredondamento coberto em POST/PATCH
  // /workout-exercises, mas testado diretamente aqui: esta é a rota que
  // motivou a mudança ("Finalizar treino") — um 400 indevido custaria o
  // treino inteiro do usuário, então merece cobertura própria, não só
  // "o schema é compartilhado, deve estar ok".
  const res = await call('POST', '/workout-record', {
    body: {
      workoutId,
      exercises: [
        {
          exerciseId: exerciseIds[0],
          status: 'COMPLETED',
          note: null,
          exerciseSets: [{ set: 1, reps: 10, exerciseLoad: 15.257 }],
        },
      ],
    },
  })
  check(
    'POST /workout-record exerciseLoad com 3 casas (15.257) → 201, não 400',
    res.status === 201 && typeof res.body?.id === 'number',
    res.body,
  )
  check(
    'exerciseLoad 15.257 foi arredondado para 15.26 no detail devolvido',
    res.body?.workoutRecordExercises?.[0]?.workoutRecordExerciseSets?.[0]?.exerciseLoad === 15.26,
    res.body?.workoutRecordExercises?.[0],
  )

  // Limpa o registro extra: só serviu para exercitar o arredondamento, não
  // faz parte do fluxo principal do smoke test (que usa `recordId`, criado
  // no bloco anterior).
  if (res.body?.id) await call('DELETE', `/workout-record/${res.body.id}`)
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

// --- GET /workouts/full -----------------------------------------------------
// Treino esvaziado de propósito: POST /workouts exige ao menos um exercício,
// então a única forma de ter um treino sem nenhum é criar com um e removê-lo
// depois — o mesmo caminho que um usuário real percorre ao esvaziar o treino.
let workoutEmptyId = 0
{
  const res = await call('POST', '/workouts', {
    body: { workoutName: 'Treino Smoke Vazio', exercises: [{ exerciseId: exerciseIds[0] }] },
  })
  workoutEmptyId = res.body?.id ?? 0
  check(
    'POST /workouts (treino a ser esvaziado) → 201',
    res.status === 201 && workoutEmptyId > 0,
    res.body,
  )

  const detail = await call('GET', `/workouts/${workoutEmptyId}`)
  const onlyWorkoutExerciseId = detail.body?.workoutExercises?.[0]?.id ?? 0
  const del = await call('DELETE', `/workout-exercises/${onlyWorkoutExerciseId}`)
  check('DELETE do único exercício do treino → 204', del.status === 204, del.body)
}

// Inverte listOrder x id de propósito: sem isso, ordenar por id (bug) e
// ordenar por listOrder (correto) dariam o mesmo resultado e o teste não
// provaria nada.
{
  const res = await call('PATCH', '/workouts/list-order', {
    body: [
      { id: workoutId, listOrder: 100 },
      { id: workoutEmptyId, listOrder: 1 },
    ],
  })
  check('PATCH /workouts/list-order (setup do teste de ordenação) → 200', res.status === 200, res.body)
}

// Troca o listOrder dos dois exercícios do treino principal direto no banco.
// Não existe endpoint HTTP que reordene exercícios dentro de um treino hoje:
// POST /workout-exercises sempre anexa no fim (MAX(listOrder) + 1) e PATCH
// não toca listOrder — então HTTP sozinho nunca faz listOrder e id divergir,
// e um teste que dependesse só disso não provaria que o handler ordena por
// listOrder em vez de id. O insert direto imita o padrão já usado acima para
// o exercício custom da conta A. De quebra, fixa o contrato de `/full`
// (ordenar por listOrder) antes do recurso de arrastar-para-reordenar dos
// exercícios chegar no app e passar a depender dele.
let swappedFirstName = ''
let swappedSecondName = ''
{
  const detail = await call('GET', `/workouts/${workoutId}`)
  const [first, second] = detail.body?.workoutExercises ?? []
  const hasTwo = !!first && !!second
  check(
    'treino principal tem os dois exercícios esperados antes da troca de listOrder',
    hasTwo,
    detail.body?.workoutExercises,
  )

  if (hasTwo) {
    swappedFirstName = first.exercise?.name ?? ''
    swappedSecondName = second.exercise?.name ?? ''

    await db
      .update(workoutExercise)
      .set({ listOrder: first.listOrder })
      .where(eq(workoutExercise.id, second.id))
    await db
      .update(workoutExercise)
      .set({ listOrder: second.listOrder })
      .where(eq(workoutExercise.id, first.id))
  }
}

{
  const res = await call('GET', '/workouts/full')
  const isList = Array.isArray(res.body)
  check('GET /workouts/full → 200 lista', res.status === 200 && isList, res.body)
  // Se `/full` fosse capturada por `/:id`, `res.body` seria o objeto de erro
  // do argumentTypeMismatch, não um array — checar isso aqui em vez de deixar
  // o `.find` mais abaixo estourar TypeError antes de qualquer check rodar.
  check('/full não foi capturada por /:id', isList, res.body)

  const list = isList ? (res.body as any[]) : []
  const found = list.find((w) => w.id === workoutId)
  check('treino do smoke aparece com exercícios', !!found?.exercises?.length, found)
  check(
    'exercício traz nome, séries, reps e carga',
    typeof found?.exercises?.[0]?.name === 'string' &&
      'sets' in found.exercises[0] &&
      'reps' in found.exercises[0] &&
      'exerciseLoad' in found.exercises[0] &&
      'imageUrl' in found.exercises[0],
    found?.exercises?.[0],
  )

  const empty = list.find((w) => w.id === workoutEmptyId)
  check(
    'treino sem exercícios aparece com array vazio, não some',
    !!empty && Array.isArray(empty.exercises) && empty.exercises.length === 0,
    empty,
  )

  const emptyIdx = list.findIndex((w) => w.id === workoutEmptyId)
  const mainIdx = list.findIndex((w) => w.id === workoutId)
  check(
    'treinos vêm ordenados por listOrder, não por id',
    emptyIdx !== -1 && mainIdx !== -1 && emptyIdx < mainIdx,
    list.map((w) => ({ id: w.id, listOrder: w.listOrder })),
  )

  // Depois da troca acima, quem tinha o id maior (`second`) ficou com o
  // listOrder menor. Se o handler ordenasse por id em vez de listOrder, a
  // sequência viria `[swappedFirstName, swappedSecondName]` — o inverso.
  const names = found?.exercises?.map((e: any) => e.name) ?? []
  check(
    'exercícios de um treino vêm ordenados por listOrder, não por id',
    names.length === 2 && names[0] === swappedSecondName && names[1] === swappedFirstName,
    names,
  )
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

// --- PATCH /clients ---------------------------------------------------------
{
  const res = await call('PATCH', '/clients', { body: { weight: 82.5, height: 1.78 } })
  check(
    'PATCH /clients medidas → 200 com o cliente atualizado',
    res.status === 200 && res.body?.weight === 82.5 && res.body?.height === 1.78,
    res.body,
  )

  const nome = await call('PATCH', '/clients', { body: { firstName: 'Rafael', lastName: 'Souza' } })
  check(
    'PATCH /clients nome → grava em lowercase',
    nome.status === 200 && nome.body?.firstName === 'rafael' && nome.body?.lastName === 'souza',
    nome.body,
  )

  const parcial = await call('GET', '/clients')
  check(
    'PATCH parcial não apagou as medidas',
    parcial.body?.weight === 82.5 && parcial.body?.height === 1.78,
    parcial.body,
  )

  const limpa = await call('PATCH', '/clients', { body: { weight: null } })
  check('PATCH /clients weight:null limpa o campo', limpa.body?.weight === null, limpa.body)

  const vazio = await call('PATCH', '/clients', { body: {} })
  check('PATCH /clients corpo vazio → 400', vazio.status === 400, vazio.body)

  const alto = await call('PATCH', '/clients', { body: { height: 12 } })
  check('PATCH /clients altura acima do teto → 400', alto.status === 400, alto.body)

  const pesoAlto = await call('PATCH', '/clients', { body: { weight: 1000 } })
  check('PATCH /clients peso acima do teto → 400', pesoAlto.status === 400, pesoAlto.body)

  const noTeto = await call('PATCH', '/clients', { body: { weight: 999.99, height: 9.99 } })
  check(
    'PATCH /clients peso e altura exatamente no teto (999.99 / 9.99) → 200, aceitos',
    noTeto.status === 200 && noTeto.body?.weight === 999.99 && noTeto.body?.height === 9.99,
    noTeto.body,
  )

  const arredonda = await call('PATCH', '/clients', { body: { weight: 82.555 } })
  check(
    'PATCH /clients peso com 3 casas (82.555) → arredondado para 82.56',
    arredonda.status === 200 && arredonda.body?.weight === 82.56,
    arredonda.body,
  )
  const arredondaPersistiu = await call('GET', '/clients')
  check(
    'peso arredondado (82.56) persistiu e volta assim no GET',
    arredondaPersistiu.body?.weight === 82.56,
    arredondaPersistiu.body,
  )

  const semToken = await call('PATCH', '/clients', { body: { weight: 80 }, auth: false })
  check('PATCH /clients sem token → 401', semToken.status === 401, semToken.body)

  // Restaura as medidas para os blocos seguintes.
  await call('PATCH', '/clients', { body: { weight: 82.5, height: 1.78 } })
}

// --- PATCH /clients/password ------------------------------------------------
const novaSenha = 'test5678'
{
  const semToken = await call('PATCH', '/clients/password', {
    auth: false,
    body: { currentPassword: password, newPassword: novaSenha },
  })
  check('PATCH /clients/password sem token → 401', semToken.status === 401, semToken.body)

  const errada = await call('PATCH', '/clients/password', {
    body: { currentPassword: 'senha-errada', newPassword: novaSenha },
  })
  check(
    'PATCH /clients/password senha atual errada → 400 código 008',
    errada.status === 400 && errada.body?.code === '008',
    errada.body,
  )

  const curta = await call('PATCH', '/clients/password', {
    body: { currentPassword: password, newPassword: '123' },
  })
  check(
    'PATCH /clients/password nova senha curta → 400 código 009 (não o envelope genérico do zod)',
    curta.status === 400 && curta.body?.code === '009',
    curta.body,
  )

  const cincoChars = await call('PATCH', '/clients/password', {
    body: { currentPassword: password, newPassword: '12345' },
  })
  check(
    'PATCH /clients/password nova senha com 5 caracteres → 400 código 009',
    cincoChars.status === 400 && cincoChars.body?.code === '009',
    cincoChars.body,
  )

  const res = await call('PATCH', '/clients/password', {
    body: { currentPassword: password, newPassword: novaSenha },
  })
  check('PATCH /clients/password → 204', res.status === 204, res.body)

  const velha = await call('POST', '/authenticate', {
    body: { email, password },
    auth: false,
  })
  check('senha antiga não autentica mais → 401', velha.status === 401, velha.body)

  const nova = await call('POST', '/authenticate', {
    body: { email, password: novaSenha },
    auth: false,
  })
  check('senha nova autentica → 200', nova.status === 200 && !!nova.body?.token, nova.body)

  // Guarda de regressão, não prova desta rota: `requireAuth` valida o JWT por
  // assinatura/expiração e recarrega o usuário pelo `sub` (o e-mail), sem
  // olhar a senha — então isso só passaria a falhar se alguém introduzisse
  // invalidação de token.
  const atual = await call('GET', '/clients')
  check('token anterior continua válido após trocar a senha', atual.status === 200, atual.body)

  // Fronteira dos 6 caracteres: exatamente 6 é o mínimo aceito.
  const seisChars = 'senha6'
  const seisCharsRes = await call('PATCH', '/clients/password', {
    body: { currentPassword: novaSenha, newPassword: seisChars },
  })
  check(
    'PATCH /clients/password nova senha com exatamente 6 caracteres → 204',
    seisCharsRes.status === 204,
    seisCharsRes.body,
  )

  // Trocar para a mesma senha atual é permitido de propósito — a rota não
  // proíbe reuso, e isso não é um bug: só não havia cobertura fixando o
  // comportamento.
  const mesmaSenha = await call('PATCH', '/clients/password', {
    body: { currentPassword: seisChars, newPassword: seisChars },
  })
  check(
    'PATCH /clients/password nova senha igual à atual → 204 (permitido de propósito)',
    mesmaSenha.status === 204,
    mesmaSenha.body,
  )

  // Restaura a senha para `novaSenha`: os blocos seguintes (corrida
  // PATCH x DELETE, isolamento entre clientes e DELETE /clients) dependem
  // desse valor exato. Se isso não voltar 204, a conta fica com uma senha
  // diferente da que o resto do script supõe — sem parar aqui, a falha real
  // só apareceria mais abaixo como `DELETE /clients → 204` falhando (senha
  // errada), apontando para o endpoint errado, e a conta (com seus treinos,
  // registros e o exercício custom inserido direto no banco) ficaria no
  // banco pra sempre, já que aquele DELETE é o único caminho de limpeza.
  const restaura = await call('PATCH', '/clients/password', {
    body: { currentPassword: seisChars, newPassword: novaSenha },
  })
  if (restaura.status !== 204) {
    fatal('PATCH /clients/password restaura para novaSenha → não voltou 204', restaura.body)
  }
  check('PATCH /clients/password restaura para novaSenha → 204', true)
}

// --- A6: PATCH /clients concorrente com DELETE /clients nunca 500 ----------
// Se o client for apagado (DELETE /clients de outro dispositivo) entre
// `requireAuth` e o UPDATE deste PATCH, `.returning()` vem vazio e `updated!`
// estourava `TypeError` → 500 sem a guarda. Dispara os dois concorrentes
// contra a mesma conta descartável: não é garantido acertar exatamente a
// janela de corrida (best-effort, depende de como o event loop intercala as
// duas requisições), mas o PATCH nunca deveria responder 500 em nenhuma
// ordem de execução.
{
  const emailRace = `smoke_race_${Date.now()}@test.com`
  const passwordRace = 'test1234'
  const cadastroRace = await call('POST', '/clients', {
    auth: false,
    body: { firstName: 'Smoke', lastName: 'Race', user: { email: emailRace, password: passwordRace } },
  })
  check(
    'POST /clients conta descartável p/ corrida PATCH x DELETE → 200 {id}',
    cadastroRace.status === 200,
    cadastroRace.body,
  )

  const tokenPrincipalRace = token
  const loginRace = await call('POST', '/authenticate', {
    auth: false,
    body: { email: emailRace, password: passwordRace },
  })
  token = loginRace.body?.token ?? ''

  const [patchRace, deleteRace] = await Promise.all([
    call('PATCH', '/clients', { body: { weight: 70 } }),
    call('DELETE', '/clients', { body: { password: passwordRace } }),
  ])
  check(
    'PATCH /clients concorrente com DELETE /clients → nunca 500',
    patchRace.status !== 500,
    { patch: patchRace.status, patchBody: patchRace.body, del: deleteRace.status },
  )

  // Garante limpeza mesmo se o DELETE concorrente perdeu a corrida.
  if (deleteRace.status !== 204) {
    await call('DELETE', '/clients', { body: { password: passwordRace } })
  }

  token = tokenPrincipalRace
}

// --- Isolamento entre clientes (exercício custom) ----------------------------
// Regressão do fix em `workout-records.routes.ts`: `assertExercisesExist` ali
// não filtrava por cliente, então B conseguia anexar o exerciseId custom de A
// (bigserial sequencial, fácil de adivinhar) a um registro do próprio treino.
// Fica antes do bloco DELETE /clients porque troca o `token` module-scope
// para a conta B e precisa devolvê-lo para A antes daquele bloco rodar.
{
  // Não há endpoint HTTP para criar exercício custom — insere direto no banco
  // (como o `catalog:sync` faz com o catálogo) para garantir que a conta A tem um, sem supor
  // que sobrou algum de um passo anterior.
  const [clientA] = await db
    .select({ id: clientTable.id })
    .from(clientTable)
    .innerJoin(users, eq(users.id, clientTable.userId))
    .where(eq(users.email, email))
  const clientAId = clientA?.id ?? 0
  // Se isso falhar, `DATABASE_URL` não aponta para o mesmo banco que a API em
  // `BASE_URL` está usando — sem essa checagem, `clientAId` cai para `0` e o
  // insert abaixo estoura uma FK não tratada, matando a suíte no meio sem
  // resumo (ver docstring no topo do arquivo).
  check(
    'DATABASE_URL aponta para o mesmo banco usado pela API (cliente do smoke encontrado direto no banco)',
    clientAId > 0,
    { email, clientA },
  )

  let customExerciseId = 0
  if (clientAId > 0) {
    const [customExercise] = await db
      .insert(exercise)
      .values({ name: 'Exercício Custom Smoke A', bodyPart: 'PEITO', clientId: clientAId })
      .returning({ id: exercise.id })
    customExerciseId = customExercise?.id ?? 0
  }

  // Exercício arquivado: `catalog:sync` arquiva (archived_at), em vez de
  // apagar, o exercício que saiu do catálogo mas ainda é usado por algum
  // treino/registro. Reproduzido aqui no custom da conta A — sai junto no
  // DELETE /clients do fim, sem sujar o catálogo global: o treino é criado
  // com ele ativo e o arquivamento é feito direto no banco, como o sync faz.
  if (customExerciseId > 0) {
    const visible = await call('GET', '/exercises')
    check(
      'exercício custom da conta aparece em GET /exercises',
      (visible.body as any[])?.some((e) => e.id === customExerciseId),
      visible.body?.length,
    )

    const created = await call('POST', '/workouts', {
      body: {
        workoutName: 'Treino Smoke Arquivado',
        exercises: [{ exerciseId: customExerciseId }, { exerciseId: exerciseIds[0] }],
      },
    })
    const archivedWorkoutId = created.body?.id ?? 0
    check(
      'POST /workouts com exercício custom → 201',
      created.status === 201 && archivedWorkoutId > 0,
      created.body,
    )

    await db.update(exercise).set({ archivedAt: new Date() }).where(eq(exercise.id, customExerciseId))

    const list = await call('GET', '/exercises')
    check(
      'exercício arquivado some de GET /exercises',
      list.status === 200 && !(list.body as any[])?.some((e) => e.id === customExerciseId),
      list.body?.length,
    )

    const detail = await call('GET', `/exercises/${customExerciseId}`)
    check(
      'GET /exercises/{id} de exercício arquivado → 200 (custom sem mídia: images [] e imageUrl null)',
      detail.status === 200 &&
        detail.body?.id === customExerciseId &&
        Array.isArray(detail.body?.images) &&
        detail.body.images.length === 0 &&
        detail.body?.imageUrl === null &&
        detail.body?.videoUrl === null &&
        detail.body?.mediaAttribution === null,
      detail.body,
    )

    const workoutDetail = await call('GET', `/workouts/${archivedWorkoutId}`)
    check(
      'GET /workouts/{id} continua trazendo o exercício arquivado',
      workoutDetail.status === 200 &&
        (workoutDetail.body?.workoutExercises as any[])?.some(
          (we) => we.exercise?.id === customExerciseId && we.exercise?.name === 'Exercício Custom Smoke A',
        ),
      workoutDetail.body,
    )

    const full = await call('GET', '/workouts/full')
    const fullWorkout = (full.body as any[])?.find((w) => w.id === archivedWorkoutId)
    check(
      'GET /workouts/full continua trazendo o exercício arquivado',
      full.status === 200 &&
        (fullWorkout?.exercises as any[])?.some((e) => e.name === 'Exercício Custom Smoke A'),
      fullWorkout,
    )

    const record = await call('POST', '/workout-record', {
      body: {
        workoutId: archivedWorkoutId,
        exercises: [
          {
            exerciseId: customExerciseId,
            status: 'COMPLETED',
            note: null,
            exerciseSets: [{ set: 1, reps: 10, exerciseLoad: 20 }],
          },
        ],
      },
    })
    check(
      'POST /workout-record com exercício arquivado de um treino existente → 201',
      record.status === 201 &&
        record.body?.workoutRecordExercises?.[0]?.exercise?.id === customExerciseId,
      record.body,
    )
  }

  const tokenA = token

  const emailB = `smoke_b_${Date.now()}@test.com`
  const passwordB = 'test1234'

  const cadastroB = await call('POST', '/clients', {
    auth: false,
    body: { firstName: 'Smoke', lastName: 'B', user: { email: emailB, password: passwordB } },
  })
  check('POST /clients conta B → 200 {id}', cadastroB.status === 200, cadastroB.body)

  const loginB = await call('POST', '/authenticate', {
    auth: false,
    body: { email: emailB, password: passwordB },
  })
  check('POST /authenticate conta B → 200 {token}', loginB.status === 200 && !!loginB.body?.token, loginB.body)
  token = loginB.body?.token ?? ''

  const workoutB = await call('POST', '/workouts', {
    body: { workoutName: 'Treino B', exercises: [{ exerciseId: exerciseIds[0] }] },
  })
  const workoutBId = workoutB.body?.id ?? 0
  check('POST /workouts conta B → 201 {id}', workoutB.status === 201 && workoutBId > 0, workoutB.body)

  const negado = await call('POST', '/workout-record', {
    body: {
      workoutId: workoutBId,
      exercises: [{ exerciseId: customExerciseId, status: 'COMPLETED', note: null, exerciseSets: [] }],
    },
  })
  check(
    'POST /workout-record com exerciseId custom de outro cliente → 404 código 007',
    negado.status === 404 && negado.body?.code === '007',
    negado.body,
  )

  const detalheAlheio = await call('GET', `/exercises/${customExerciseId}`)
  check(
    'GET /exercises/{id} custom de outro cliente → 404 código 007',
    detalheAlheio.status === 404 && detalheAlheio.body?.code === '007',
    detalheAlheio.body,
  )

  const cargasB = await call('GET', `/exercise-loads?exerciseIds=${exerciseIds[0]}`)
  const entriesB: any[] = cargasB.body?.[0]?.entries ?? []
  check(
    'GET /exercise-loads não mostra treinos de outro cliente',
    cargasB.status === 200 && entriesB.length === 1 && entriesB[0]?.workoutId === workoutBId,
    cargasB.body,
  )

  const ordemAlheia = await call('GET', `/workouts/${workoutBId}`)
  const ordemAlheiaIds = (ordemAlheia.body?.workoutExercises ?? []).map((we: any) => we.id)
  token = tokenA
  const treinoA = await call('GET', `/workouts/${orderWorkoutId}`)
  const treinoAIds = (treinoA.body?.workoutExercises ?? []).map((we: any) => we.id)
  token = loginB.body?.token ?? ''
  const reordenarAlheio = await call('PATCH', `/workouts/${orderWorkoutId}/exercise-order`, {
    body: { workoutExerciseIds: [...treinoAIds].reverse() },
  })
  check(
    'PATCH exercise-order no treino de outro cliente → 400 código 002',
    reordenarAlheio.status === 400 && reordenarAlheio.body?.code === '002',
    reordenarAlheio.body,
  )
  const proprioComIdAlheio = await call('PATCH', `/workouts/${workoutBId}/exercise-order`, {
    body: { workoutExerciseIds: [treinoAIds[0]] },
  })
  check(
    'PATCH exercise-order no próprio treino com id de exercício de outro cliente → 409 código 010',
    ordemAlheiaIds.length === 1 && proprioComIdAlheio.status === 409 && proprioComIdAlheio.body?.code === '010',
    proprioComIdAlheio.body,
  )

  const aceito = await call('POST', '/workout-record', {
    body: {
      workoutId: workoutBId,
      exercises: [{ exerciseId: exerciseIds[0], status: 'COMPLETED', note: null, exerciseSets: [] }],
    },
  })
  check(
    'POST /workout-record com exercício global continua permitido → 201',
    aceito.status === 201 && typeof aceito.body?.id === 'number',
    aceito.body,
  )

  // Limpa a conta B: não faz parte do fluxo principal, só existiu para provar
  // o isolamento entre clientes.
  const delB = await call('DELETE', '/clients', { body: { password: passwordB } })
  check('DELETE /clients conta B → 204 (limpeza)', delB.status === 204, delB.body)

  // Devolve a identidade para a conta A: o bloco DELETE /clients a seguir (e
  // tudo que já rodou antes dele) depende do `token` module-scope apontando
  // para a conta principal do smoke.
  token = tokenA
}

// --- catalog:sync no banco da API (sempre dry-run: rollback no fim) ---------
// O mesmo `syncCatalog` que o boot roda, direto no banco de `DATABASE_URL`:
// 1. banco já sincronizado não reescreve nenhuma linha (idempotência);
// 2. exercício do catálogo (com `external_id`) que saiu do arquivo é
//    arquivado, nunca remapeado pelo nome via mapa legado — "Panturrilha no Leg
//    Press" casa com a linha legada → 0738;
// 3. uma referência nova a um exercício legado, inserida por outra transação
//    enquanto o sync roda (a versão anterior da API segue no ar durante o
//    deploy), não derruba o sync com violação de FK: ele espera o commit e
//    arquiva em vez de apagar.
{
  const items = parseCatalog(await Bun.file(CATALOG_FILE).json())
  const legacyMap = parseLegacyMap(await Bun.file(LEGACY_MAP_FILE).text())
  const baseline = await syncCatalog(items, legacyMap, { dryRun: true })
  check(
    'catalog:sync (dry-run) no banco já sincronizado → nada inserido/atualizado',
    baseline.inserted === 0 && baseline.updated === 0 && baseline.unchanged === items.length,
    baseline,
  )

  const created = await call('POST', '/workouts', {
    body: { workoutName: 'Treino Smoke Sync', exercises: [{ exerciseId: exerciseIds[0] }] },
  })
  const syncWorkoutId: number = created.body?.id ?? 0
  check('POST /workouts (fixture do catalog:sync) → 201', created.status === 201 && syncWorkoutId > 0, created.body)

  // Globais falsos, apagados no `finally` (DELETE /clients não apaga global).
  const fakeIds: number[] = []
  try {
    if (syncWorkoutId > 0) {
      const stamp = Date.now()
      const [removed] = await db
        .insert(exercise)
        .values({ name: 'Panturrilha no Leg Press', bodyPart: 'PERNA', externalId: `smoke-removed-${stamp}` })
        .returning({ id: exercise.id })
      const [legacy] = await db
        .insert(exercise)
        .values({ name: `Smoke legado ${stamp}`, bodyPart: 'PERNA' })
        .returning({ id: exercise.id })
      fakeIds.push(removed!.id, legacy!.id)
      await db.insert(workoutExercise).values({ workoutId: syncWorkoutId, exerciseId: removed!.id, listOrder: 1 })

      // Outra conexão insere a referência ao legado e só commita depois que o
      // sync já está rodando (e travado esperando por ela).
      let release!: () => void
      const released = new Promise<void>((resolve) => (release = resolve))
      let markInserted!: () => void
      const inserted = new Promise<void>((resolve) => (markInserted = resolve))
      const concurrent = sql.begin(async (tx) => {
        await tx`INSERT INTO workout_exercise (workout_id, exercise_id, list_order) VALUES (${syncWorkoutId}, ${legacy!.id}, 2)`
        markInserted()
        await released
      })
      await inserted
      const syncing = syncCatalog(items, legacyMap, { dryRun: true }).then(
        (summary) => ({ summary, error: null as unknown }),
        (error: unknown) => ({ summary: null, error }),
      )
      await Bun.sleep(1500)
      release()
      await concurrent
      const { summary, error } = await syncing

      check(
        'catalog:sync com insert concorrente apontando para um legado → sem violação de FK',
        error === null,
        error instanceof Error ? error.message : error,
      )
      check(
        'catalog:sync: exercício do catálogo fora do arquivo e legado recém-referenciado → arquivados (nem remapeados nem apagados)',
        !!summary &&
          summary.remapped === baseline.remapped &&
          summary.deleted === baseline.deleted &&
          summary.archived === baseline.archived + 2,
        { baseline, summary },
      )
    }
  } finally {
    if (fakeIds.length > 0) {
      await db.delete(workoutExercise).where(inArray(workoutExercise.exerciseId, fakeIds))
      await db.delete(exercise).where(inArray(exercise.id, fakeIds))
    }
  }
}

// --- DELETE /clients --------------------------------------------------------
// Precisa ser o último bloco autenticado: apaga o usuário do smoke.
{
  const semToken = await call('DELETE', '/clients', {
    auth: false,
    body: { password: novaSenha },
  })
  check('DELETE /clients sem token → 401', semToken.status === 401, semToken.body)

  const errada = await call('DELETE', '/clients', { body: { password: 'senha-errada' } })
  check(
    'DELETE /clients senha errada → 400 código 008',
    errada.status === 400 && errada.body?.code === '008',
    errada.body,
  )

  const res = await call('DELETE', '/clients', { body: { password: novaSenha } })
  check('DELETE /clients → 204', res.status === 204, res.body)

  const login = await call('POST', '/authenticate', {
    body: { email, password: novaSenha },
    auth: false,
  })
  check('conta excluída não autentica mais → 401', login.status === 401, login.body)

  const comToken = await call('GET', '/clients')
  check('token de conta excluída → 401', comToken.status === 401, comToken.body)
}

// --- A1: token da conta excluída não pode autenticar como quem reusa o e-mail
// `requireAuth` resolvia o usuário por `payload.sub` (o e-mail). DELETE
// /clients libera o e-mail para re-cadastro, então um token de 30 dias ainda
// não expirado, emitido para a conta antiga, passava a autenticar como
// QUALQUER UM que reusasse aquele e-mail depois — sem senha. O check
// 'token de conta excluída → 401' acima NÃO cobre isso: ele passa mesmo sem
// o fix, porque ninguém re-cadastra o e-mail naquele momento. Este bloco
// reproduz o caso que importa: re-cadastra o MESMO e-mail e reusa o token
// antigo contra a conta nova.
{
  const tokenContaExcluida = token

  const recadastro = await call('POST', '/clients', {
    auth: false,
    body: { firstName: 'Smoke', lastName: 'Recadastro', user: { email, password: novaSenha } },
  })
  check(
    'POST /clients re-cadastro do e-mail de conta excluída → 200 {id}',
    recadastro.status === 200 && typeof recadastro.body?.id === 'number',
    recadastro.body,
  )

  token = tokenContaExcluida
  const comTokenAntigo = await call('GET', '/clients')
  check(
    'token emitido para a conta excluída → 401 mesmo após alguém re-cadastrar o e-mail',
    comTokenAntigo.status === 401,
    comTokenAntigo.body,
  )

  // Limpa a conta re-cadastrada com um token válido para ela.
  const loginNovo = await call('POST', '/authenticate', {
    auth: false,
    body: { email, password: novaSenha },
  })
  token = loginNovo.body?.token ?? ''
  const delNovo = await call('DELETE', '/clients', { body: { password: novaSenha } })
  check('DELETE /clients conta re-cadastrada → 204 (limpeza)', delNovo.status === 204, delNovo.body)
}

// --- 404 --------------------------------------------------------------------
{
  const res = await call('GET', '/nao-existe')
  check('rota inexistente → 404 NOT_FOUND', res.status === 404 && res.body?.code === 'NOT_FOUND', res.body)
}
} catch (err) {
  // `fatal()` (ou qualquer outro throw não previsto) cai aqui: registra e
  // segue para o `finally`, em vez de matar o processo antes de fechar a
  // conexão e imprimir o resumo.
  console.error('\nSmoke abortado por um erro fatal:', err)
} finally {
  await sql.end()
  console.log(`\n${passed} passaram, ${failed} falharam`)
}

process.exit(failed === 0 ? 0 : 1)
