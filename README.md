# workout-sheet-api-v2

API do app "Meu Treino" reescrita de Spring Boot/Java para **Bun + Hono + Drizzle + MySQL**,
mantendo a superfície pública compatível com o cliente Flutter (`~/projects/meu-treino-app`).

## Stack

| Camada    | Escolha |
|-----------|---------|
| Runtime   | Bun     |
| HTTP      | Hono    |
| ORM       | Drizzle (mysql2) |
| Validação | Zod     |
| JWT       | jose (HS256, secret base64-decoded) |
| Password  | `Bun.password` (bcrypt, cost 10) |

## Subir do zero

```bash
bun install
cp .env.example .env          # ajuste JWT_SECRET / DATABASE_URL
docker compose up -d db       # ou reaproveite o MySQL do projeto Java
bun run db:migrate            # cria o schema
bun run db:seed               # popula o catálogo global de exercícios (108)
bun run dev                   # hot reload
```

Validação end-to-end (a API precisa estar no ar):

```bash
BASE_URL=http://localhost:8080/api bun run smoke
```

O mesmo script roda contra a API Java para comparar respostas:
`BASE_URL=http://localhost:8080/api` (Java) vs `:8081` (Bun).

## Scripts

| Script | O quê |
|--------|-------|
| `bun run dev` | servidor com watch |
| `bun run start` | servidor |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | gera migration a partir de `src/db/schema.ts` |
| `bun run db:migrate` | aplica migrations |
| `bun run db:seed` | insere exercícios globais faltantes (idempotente) |
| `bun run smoke` | smoke test dos 15 endpoints |

## Env

```env
JWT_SECRET=<base64; o Java fazia Decoders.BASE64.decode antes de assinar>
DATABASE_URL=mysql://user:pass@host:3306/workout_sheet_api_v2
PORT=8080
APP_TIMEZONE=America/Sao_Paulo   # usado para serializar `date` (YYYY-MM-DD)
```

## Estrutura

```
src/
  index.ts                  bootstrap Bun.serve
  app.ts                    montagem das rotas + handlers de erro
  env.ts                    env parseado com zod
  types.ts                  Variables do contexto Hono
  db/
    schema.ts               tabelas Drizzle
    client.ts               pool mysql2 + drizzle
    migrate.ts / seed.ts
    migrations/             saída do drizzle-kit
  auth/
    jwt.ts                  sign/verify HS256
    password.ts             bcrypt cost 10
    middleware.ts           bearer + hasRole('USER') + client logado
  modules/*.routes.ts       um arquivo por recurso
  shared/
    errors.ts               AppError + formato de erro idêntico ao Java
    serialize.ts            decimal→number, created_at→YYYY-MM-DD
    validate.ts             parse de body/params
data/exercise.csv           catálogo global semeado
scripts/smoke.ts            validação end-to-end
```

## Contrato mantido

- Mesmos paths/verbos/status; `Authorization: Bearer <jwt>`.
- Erro sempre `{ code, message, details, path, timestamp }` — o cliente lê
  `errorMessage ?? message`.
- `DELETE` → 204; `PATCH` → 200 sem corpo; `POST /workouts` → 201 + `Location`.
- `GET /workout-record/last` → **200 com corpo `null`** quando não há registros.
- `date` continua `"YYYY-MM-DD"`, derivado de `created_at` em `APP_TIMEZONE`.
- `load` no request / `exerciseLoad` na resposta — inconsistência herdada, mantida.
- Chave ausente **e** `null` são tratadas como "não preenchido".

## Diferenças propositais em relação à API Java

Confirmadas rodando `scripts/smoke.ts` contra as duas APIs:

| Ponto | Java | v2 |
|-------|------|----|
| `exerciseLoad` não preenchido | `0` (sentinela) | `null` |
| `listOrder` em `GET /workouts/{id}` | sempre `0` (nunca mapeado) | ordem real |
| `listOrder` ao adicionar exercício | sempre `0` (query com bug: `WHERE we.id = :workoutId`) | `max+1` |
| Rota inexistente | `500 INTERNAL_SERVER_ERROR` | `404 NOT_FOUND` |
| Request sem token | `403` com corpo vazio | `401` no formato de erro padrão |
| `client.lastName` no cadastro | recebia cópia do `firstName` (bug do mapper) | valor enviado |
| `weight`/`height` | arredondados (`80.5 → 81`) | `decimal(5,2)` / `decimal(3,2)` |
| E-mail duplicado no cadastro | `500` genérico | `400 EMAIL_ALREADY_EXISTS` |
| `DELETE /workout-record/{id}` | remove em cascata | soft delete (`deleted_at`) |
| Registros de treino excluído | continuavam no histórico | filtrados |

JWT: o payload embute `roles: ["USER"]` (o Java mandava `["ROLE_USER"]`). Nada no
cliente lê essa claim; a autorização usa `users.role` do banco.

## Schema V2

Recriado do zero (dados antigos não são migrados):

- `users.role` achatado (`user_roles`/`role` removidas).
- `created_at`/`updated_at` em todas as tabelas.
- `workout_record.date` → `created_at` (DATETIME) — desempata sessões do mesmo dia.
- Soft delete (`deleted_at`) em `workout` e `workout_record`; toda leitura filtra `IS NULL`.
- `exercise.client_id` nullable — `NULL` = catálogo global, senão exercício custom.
- BodyPart expandido: `ANTEBRACO, ABDOMEN, GLUTEO, LOMBAR, CARDIO`.
- Índices: `workout(client_id, deleted_at, list_order)`,
  `workout_exercise(workout_id, list_order)`, `workout_record(workout_id, created_at)`.
- Tabelas descontinuadas: `workout_checkin`, `client_record`, `exercise_load_record`.

## Cutover pendente

1. `~/projects/meu-treino-app/lib/config/api_config.dart` — apontar `baseUrl` para a API nova.
2. Deploy (Render + Aiven MySQL) e arquivar o repo Java.

O enum `BodyPart` do cliente Flutter **já foi atualizado** com os cinco novos grupos —
sem isso, `BodyPart.fromString` lançaria ao receber os exercícios recém-semeados.
