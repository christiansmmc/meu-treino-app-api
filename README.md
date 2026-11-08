# workout-sheet-api-v2

API do app "Meu Treino" reescrita de Spring Boot/Java para **Bun + Hono + Drizzle + PostgreSQL**,
mantendo a superfície pública compatível com o cliente Flutter (`~/projects/meu-treino-app`).

## Stack

| Camada    | Escolha |
|-----------|---------|
| Runtime   | Bun     |
| HTTP      | Hono (+ `hono/compress`: gzip/deflate nas respostas JSON) |
| ORM       | Drizzle (postgres.js) |
| Banco     | PostgreSQL 16 (local via docker compose; produção no Neon) |
| Validação | Zod     |
| JWT       | jose (HS256, secret base64-decoded) |
| Password  | `Bun.password` (bcrypt, cost 10) |

## Subir do zero

```bash
bun install
cp .env.example .env          # ajuste JWT_SECRET / DATABASE_URL
docker compose up -d db       # Postgres local (porta 5432)
bun run db:migrate            # cria/atualiza o schema
bun run catalog:sync          # sincroniza o catálogo global com data/exercises.json
bun run media:fetch           # baixa as imagens do catálogo para MEDIA_DIR (~6,5 MB + ~7 MB de originais em cache, só o que falta)
bun run dev                   # hot reload
```

Imagens do catálogo ficam em `MEDIA_DIR` (default `./media`, fora do Git) — sem elas a API
funciona, só `GET /api/media/*` responde 404 (o `catalog:sync` avisa quantas faltam).

Validação end-to-end (a API precisa estar no ar, e `DATABASE_URL` tem que ser o mesmo banco dela):

```bash
BASE_URL=http://localhost:8080/api DATABASE_URL=postgres://... bun run smoke
```

O smoke espera um catálogo com pelo menos 3 exercícios, algum de `PEITO`/`COSTAS`
e ao menos um com imagem presente em `MEDIA_DIR` (rode `media:fetch` antes).

## Scripts

| Script | O quê |
|--------|-------|
| `bun run dev` | servidor com watch |
| `bun run start` | só o servidor — **não** aplica migrations nem roda o `catalog:sync` |
| `bun run start:prod` | migrations → `catalog:sync --if-changed` (se `CATALOG_SYNC_ON_START`) → servidor (entrypoint do container; é o start de produção também fora do Docker) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run db:generate` | gera migration a partir de `src/db/schema.ts` |
| `bun run db:migrate` | aplica migrations |
| `bun run catalog:sync` | sincroniza o catálogo global (`--dry-run`: mostra os números e faz rollback; `--if-changed`: pula se nada mudou desde o último sync completo, o modo do boot) |
| `bun run media:fetch` | baixa e processa as imagens do catálogo (`data/media-manifest.json` → `MEDIA_DIR`; `--prune` apaga as que saíram do manifesto) |
| `bun run smoke` | smoke test end-to-end |

## Env

```env
JWT_SECRET=<base64; o Java fazia Decoders.BASE64.decode antes de assinar>
DATABASE_URL=postgres://user:pass@host:5432/workout_sheet_api_v2
DATABASE_SSL=false               # true em provider gerenciado (o Neon já manda ?sslmode=require na URL)
PORT=8080
APP_TIMEZONE=America/Sao_Paulo   # usado para serializar `date` (YYYY-MM-DD)
MEDIA_DIR=./media                # raiz de GET /api/media/* e destino do media:fetch (no container: /app/media)
CATALOG_SYNC_ON_START=true       # start:prod roda catalog:sync antes de subir
MEDIA_MANIFEST=...               # opcional, só media:fetch (default: data/media-manifest.json)
```

## Catálogo de exercícios

O catálogo global (`exercise.client_id IS NULL`) vem de **`data/exercises.json`**: uma lista
enxuta de **184** exercícios comuns de academia, 143 com ilustração — 178 escolhidos entre os 1.324
do openGym (texto do ExerciseDB/openGym, nomes e instruções em pt-BR; lista em
`scripts/catalog/curated-list.json`) e 6 escritos para o projeto (`externalId` `mt-0001`…`mt-0006`,
sem imagem: remo ergométrico, leg press horizontal, flexora em pé, abdução de quadril na polia,
glúteo 4 apoios com caneleira, salto no caixote). Licenças em [`NOTICE.md`](NOTICE.md). Formato (array):

```json
{
  "externalId": "0025",
  "name": "Supino reto com barra",
  "nameEn": "barbell bench press",
  "bodyPart": "PEITO",
  "equipment": "Barra",
  "target": "Peitoral",
  "secondaryMuscles": ["Tríceps", "Ombros"],
  "category": "Força",
  "instructions": ["Deite-se em um banco...", "..."],
  "images": ["sources/workout-guide/bench-press/frame-1-white.png", "sources/workout-guide/bench-press/frame-2-white.png"],
  "video": null,
  "mediaAttribution": "Ilustração: Bryl Lim (Workout Guide), adaptada de Everkinetic — CC BY-SA 4.0 (cores adaptadas)"
}
```

- `bodyPart` tem que ser um dos 11 valores do enum (`PEITO, TRICEPS, COSTAS, BICEPS, OMBRO,
  PERNA, ANTEBRACO, ABDOMEN, GLUTEO, LOMBAR, CARDIO`) — o app Flutter lança em valor desconhecido.
- `images`/`video` são caminhos relativos a `MEDIA_DIR`, em qualquer layout (um arquivo pode ser
  compartilhado entre exercícios). Sem `..`, `/` inicial, `\`, `:` ou segmento começando com `.`;
  extensão `jpg/jpeg/png/webp/gif/svg/mp4`. Mais de uma imagem = frames de animação.
- Texto vazio vira `null`; `externalId` repetido ou campo inválido aborta o sync inteiro.

`data/legacy-exercise-map.csv` (opcional), cabeçalho `old_name,old_body_part,external_id`,
leva exercícios antigos (sem `external_id`, ex.: o catálogo CSV de 108 que existia antes) para
um do catálogo novo. Casa por `(nome, body_part)`, ignorando caixa e espaços extras.

`bun run catalog:sync` faz tudo **numa transação** (com `pg_advisory_xact_lock`), idempotente:

1. Upsert por `external_id` (lotes de 500): insere novos, atualiza só as linhas que mudaram e
   limpa `archived_at` de quem voltou ao catálogo.
2. Todo exercício global fora do arquivo:
   - é legado (sem `external_id`) e casa com o mapa legado → `workout_exercise` e
     `workout_record_exercise` passam a apontar para o exercício novo e o antigo é apagado
     (um exercício do catálogo que saiu do arquivo nunca é remapeado por nome);
   - senão, sem nenhuma referência → apagado;
   - senão → `archived_at = now()`: some de `GET /exercises`, mas treinos e histórico continuam
     resolvendo o join (e `GET /exercises/:id` continua respondendo).
3. Exercícios custom de cliente (`client_id` não nulo) nunca são tocados.

**No boot** (`start:prod`) o sync roda com `--if-changed`: todo sync completo grava em
`catalog_sync_state` (migration `0002`) o sha256 de `exercises.json` + mapa legado + versão do
sync (`CATALOG_SYNC_VERSION`) e uma impressão digital dos exercícios globais do banco (contagem +
md5 do conteúdo sincronizado e do estado de arquivamento, em ordem de id). Se os dois batem, o boot loga `sem mudança ... pulado` e não
lê nem escreve o catálogo — o sync completo sem mudança custava ~0,8 s com 20 ms de latência até o
banco e ~3,4 s com 120 ms (o atalho: 0,27 s / 1,5 s, contando a conexão; medido com `tc netem`). Arquivo, código do sync
ou catálogo no banco diferentes (restore de dump, SQL manual) → sync completo. A conferência roda
depois do mesmo `pg_advisory_xact_lock`, na mesma transação. Exercícios arquivados que perderam as
referências só são apagados no próximo sync completo. O CLI sem flag sempre faz o sync completo.

Loga `inseridos/atualizados/sem_mudança/remapeados/apagados/arquivados`, avisa sobre linhas do
mapa que apontam para `external_id` fora do arquivo e sobre arquivos de mídia ausentes em
`MEDIA_DIR` (aviso, não erro). Arquivo vazio é recusado (arquivaria o catálogo todo) salvo
`--allow-empty`.

### Regenerar o catálogo

`data/exercises.json`, `data/media-manifest.json`, `data/credits.json` e
`data/legacy-exercise-map.csv` são gerados por [`scripts/catalog/`](scripts/catalog/README.md)
a partir de um clone do openGym, filtrado por `scripts/catalog/curated-list.json` e somado a
`scripts/catalog/custom-exercises.json` (offline, Node 20+; o build falha se um id da lista não
existe, se dois exercícios têm o mesmo nome, se falta um id usado pelos treinos atuais ou se o mapa
legado aponta para fora da lista):

```bash
node scripts/catalog/build-catalog.mjs /caminho/do/openGym --compound-legs-as-perna
cp scripts/catalog/out/{exercises,media-manifest,credits}.json scripts/catalog/legacy-exercise-map.csv data/
bun run catalog:sync && bun run media:fetch
```

`--compound-legs-as-perna` põe agachamentos, afundos, leg press, stiff/terra e good morning em
`PERNA` (o openGym os mira em glúteos). Distribuição atual: PERNA 34, PEITO 25, COSTAS 23, OMBRO 23,
ABDOMEN 18, TRICEPS 17, BICEPS 15, GLUTEO 12, CARDIO 10, ANTEBRACO 4, LOMBAR 3. A curadoria (o que
entra, nomes, exercícios próprios, validações) está no [README do gerador](scripts/catalog/README.md#curation-curated-listjson-custom-exercisesjson).

Num banco que já tinha o catálogo completo (1.324), o primeiro `catalog:sync` com a lista enxuta
apaga os exercícios que saíram e **arquiva** os que algum treino ou registro ainda usa (somem de
`GET /exercises`, continuam nos treinos e no histórico); os mantidos são atualizados/renomeados no
lugar, pelo mesmo `external_id`. Depois do deploy, `media:fetch --prune` apaga as imagens que saíram
do manifesto (504 → 236 arquivos).

### Imagens: `bun run media:fetch`

`src/media/fetch-media.ts` baixa cada arquivo de `data/media-manifest.json`
(`[{path, url, license, attribution, transform, align}]`) e grava a versão processada em
`MEDIA_DIR/<path>`:

- processa por **grupo** = pasta do caminho (os frames de um exercício, ex.:
  `sources/everkinetic/0004/`): o grupo é gravado inteiro ou não é;
- pula o grupo cujos arquivos já existem (rodar de novo é barato); grava num temporário e renomeia
  (atômico);
- guarda os bytes originais em `MEDIA_DIR/.raw/<sha256 da url>.png` (a rota de mídia não serve
  segmentos começando em `.`): reprocessar depois de mudar o processamento não baixa de novo;
- retry com backoff em erro de rede/408/429/5xx; HTML ou PNG inválido falha sem retry;
- sai com 1 só se as falhas passarem de `--max-fail-ratio` (default 5%), com 2 se o manifesto for
  inválido. Opções: `[manifest] [mediaDir] --concurrency=8 --retries=3 --timeout=30000
  --failures-out=<arquivo.json> --prune`.
- `--prune` (no fim, se as falhas ficaram dentro do limite) apaga de `MEDIA_DIR` os arquivos de mídia
  (extensões servidas pela rota) e temporários `.tmp-*` que o manifesto não lista mais — ex.: os
  caminhos da versão anterior depois de um release — e as pastas que ficarem vazias. Nunca toca em
  `.raw/` nem em outros arquivos; recusa rodar na raiz do sistema de arquivos.

**Normalização de cor**: todo frame termina como traço **branco sobre fundo transparente**, então
o app trata todas as imagens igual (fundo escuro, ou tingir com
`Image.network(url, color: ..., colorBlendMode: BlendMode.srcIn)`). O `transform` de cada entrada
diz como (`src/media/normalize.ts`, PNG em JS puro via `pngjs`, sem dependência nativa):

- `to-white` (Workout Guide, já branco sobre transparente, mas com parte do traço em 254) → RGB = 255,
  alfa mantido;
- `luma-to-alpha` (Everkinetic, traço preto opaco sobre branco) → alfa = (255 − luma) × alfa / 255,
  RGB = 255.

**Enquadramento** (`src/media/frames.ts`), por grupo, para a animação (flip-book) não pular e a
figura preencher o tile quadrado do app:

1. alinha os frames pelo `align`: `canvas` (Workout Guide: os frames já dividem a mesma tela 512×512)
   ou `register` (Everkinetic: cada frame vem recortado rente ao próprio desenho, com tamanhos
   diferentes → cada um é transladado sobre o primeiro pela posição que mais sobrepõe o traço;
   correlação via FFT a ~256 px e refino a ½);
2. recorta pela caixa de **união** do traço de todos os frames (nunca frame a frame), com margem
   uniforme de 6% do lado maior, centralizada num quadrado transparente;
3. reduz para no máximo 512 px por média de área (nunca amplia).

A saída é PNG cinza+alfa 8 bits, quadrado, ≤ 512 px, todos os frames do grupo do mesmo tamanho.
Os caminhos levam a versão do processamento (`frame-N.v2.png`, `MEDIA_VERSION` em
`build-catalog.mjs`): com o cache `immutable` da rota de mídia e o "pula o que já existe", mudar o
resultado do processamento exige mudar a versão (e, depois do release, `media:fetch --prune` uma vez
para apagar a anterior). O `N` é o número do frame na origem: os frames de estilo ou enquadramento
inconsistente ficam de fora (`scripts/catalog/media-frame-exclude.json`; exercício com 1 frame
aparece estático).

As imagens são CC BY-SA 4.0 e são modificadas (cores, recorte, redução): o crédito diz isso em
`mediaAttribution` ("(cores adaptadas)"), no `attribution` de cada arquivo do manifesto e em
`data/credits.json`; [`NOTICE.md`](NOTICE.md) descreve cada mudança e as outras licenças (MIT,
AGPL-3.0 dos textos em pt-BR).

## Endpoints de catálogo e mídia

- `GET /api/exercises[?body_part=X&body_part=Y]` — global + custom do cliente, **sem arquivados**,
  ordenado por nome (collation pt-BR, em JS): `{id, name, bodyPart, equipment, target, imageUrl}`.
- `GET /api/exercises/:id` — mesma regra de acesso (global ou do próprio cliente; arquivado ok):
  `{id, name, nameEn, bodyPart, equipment, target, secondaryMuscles, category, instructions,
  images, videoUrl, imageUrl, mediaAttribution}`.
- `exercise` aninhado em `GET /workouts/:id` e nos detalhes de `/workout-record` ganhou `imageUrl`;
  os itens de `GET /workouts/full` também.
- `imageUrl`/`images`/`videoUrl` são paths **origin-relative** (`/api/media/...`, segmentos
  percent-encoded) ou `null`; o cliente prefixa a própria origem.
- `GET /api/media/*` — **público** (sem token: `Image.network` não manda header), serve de
  `MEDIA_DIR` com `Content-Type` pela extensão, `Cache-Control: public, max-age=31536000, immutable`,
  `ETag`/304 e `Range` (206/416). Traversal (`..`, `%2f`, `%5c`, dotfiles, symlink para fora),
  extensão fora da allowlist ou arquivo ausente → 404 padrão. Como o cache é `immutable`,
  **trocar o conteúdo de uma mídia exige um caminho novo**.

## Docker

```bash
docker build -t meu-treino-api .
docker run -p 8080:8080 \
  -e DATABASE_URL=postgres://... -e JWT_SECRET=... \
  -v /caminho/da/midia:/app/media:ro \
  meu-treino-api
```

O container roda `src/boot.ts`: aplica as migrations, roda `catalog:sync` se
`CATALOG_SYNC_ON_START` (default `true`) e só então sobe o servidor. Migrations e sync rodam sob
`pg_advisory_xact_lock` (seguro atrás do pooler do Neon): réplicas subindo juntas se enfileiram
em vez de aplicar a mesma migration duas vezes. Qualquer falha encerra com
código 1 sem subir o servidor (o deploy anterior continua no ar). A imagem leva `src/`
(com as migrations), `data/` e `NOTICE.md`. Roda como usuário `bun`, com `HEALTHCHECK` em
`/api/health`.

**Mídia embutida**: um estágio do build roda `media:fetch` (rede no build; ~10 s, ~6,5 MB) e a imagem
leva só os arquivos processados em `MEDIA_DIR=/app/media` (dono `bun`; o cache `.raw/` fica de
fora) — num host sem disco persistente (Render free) a API sobe com as imagens. O estágio só
depende de `data/media-manifest.json`, `src/media/` e `src/shared/media-paths.ts`, então fica em
cache enquanto eles não mudam. Algumas falhas de download não derrubam o build (só as imagens
faltantes dão 404); acima de `MEDIA_MAX_FAIL_RATIO` (build arg, padrão `0.05`) o build falha —
`--build-arg MEDIA_MAX_FAIL_RATIO=1` aceita qualquer quantidade.

Montar um volume em `/app/media` continua funcionando: um volume nomeado **novo** nasce com a cópia
da imagem; um volume já preenchido (ou bind mount) a esconde. Para completar/atualizar o volume, a
mesma imagem roda o download (one-shot, volume montado com escrita; `/app/media` pertence ao
usuário `bun`):

```bash
docker run --rm -v midia:/app/media meu-treino-api bun run media:fetch
```

Sem Docker (ex.: runtime nativo de Bun no Render): build `bun install --frozen-lockfile && bun run
media:fetch` (grava em `./media`, o `MEDIA_DIR` padrão, relativo ao diretório de trabalho) e start
`bun run start:prod` — **não** `bun run start`, que sobe só o servidor, sem migrations nem
`catalog:sync`. `.bun-version` fixa o Bun (1.4.4) para quem respeita o arquivo (o Render).

Local, tudo junto: `docker compose --profile api up -d --build` (API em `:8080` — ou
`API_PORT` — apontando pro Postgres do compose e montando `./media`, que `bun run media:fetch`
preenche). `docker compose up -d db` continua subindo só o banco. A stack completa (web + API +
Postgres + download das imagens) fica em `../stack`.

## Estrutura

```
src/
  index.ts                  bootstrap Bun.serve
  boot.ts                   entrypoint do container: migrate → catalog:sync → index.ts
  app.ts                    montagem das rotas + compress + handlers de erro
  env.ts                    env parseado com zod
  types.ts                  Variables do contexto Hono
  db/
    schema.ts               tabelas Drizzle
    client.ts               postgres.js + drizzle
    migrate.ts              aplica migrations (CLI e boot)
    catalog-sync.ts         catalog:sync (CLI e boot; atalho --if-changed via catalog_sync_state)
    migrations/             saída do drizzle-kit
  auth/
    jwt.ts                  sign/verify HS256
    password.ts             bcrypt cost 10
    middleware.ts           bearer + hasRole('USER') + client logado
  modules/*.routes.ts       um arquivo por recurso (media.routes.ts: GET /api/media/*)
  media/
    fetch-media.ts          media:fetch (download + cache .raw/ + processamento por grupo, --prune)
    normalize.ts            to-white / luma-to-alpha → plano de alfa; PNG cinza+alfa (pngjs)
    frames.ts               alinhamento (registro), recorte pela união, quadrado, redução ≤ 512 px
  shared/
    errors.ts               AppError + formato de erro idêntico ao Java
    media-paths.ts          path de mídia → URL, allowlist de extensões (sem banco: o media:fetch usa)
    media.ts                reexporta media-paths.ts + `exerciseFirstImage` (SQL)
    serialize.ts            decimal→number, created_at→YYYY-MM-DD
    validate.ts             parse de body/params
data/exercises.json         catálogo global (184 exercícios, gerado por scripts/catalog)
data/media-manifest.json    imagens: path, URL de origem, licença, crédito, transform, align
data/credits.json           fontes e licenças (para uma tela de créditos)
data/legacy-exercise-map.csv  mapa exercício antigo → external_id
media/                      MEDIA_DIR local (fora do Git)
scripts/catalog/            gerador do catálogo (ver README dele)
scripts/smoke.ts            validação end-to-end
NOTICE.md                   licenças do catálogo e das imagens
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
- Campos novos só são **acrescentados** às respostas (o cliente ignora chave desconhecida);
  `bodyPart` continua restrito aos 11 valores.

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
| Ordem de `GET /exercises` | por `body_part`, depois id | por nome (pt-BR) |

JWT: o payload embute `roles: ["USER"]` (o Java mandava `["ROLE_USER"]`). Nada no
cliente lê essa claim; a autorização usa `users.role` do banco.

## Schema V2

Recriado do zero (dados antigos não são migrados):

- `users.role` achatado (`user_roles`/`role` removidas).
- `created_at`/`updated_at` em todas as tabelas.
- `workout_record.date` → `created_at` (timestamp) — desempata sessões do mesmo dia.
- Soft delete (`deleted_at`) em `workout` e `workout_record`; toda leitura filtra `IS NULL`.
- `exercise.client_id` nullable — `NULL` = catálogo global, senão exercício custom.
- BodyPart expandido: `ANTEBRACO, ABDOMEN, GLUTEO, LOMBAR, CARDIO`.
- Catálogo (migration `0001_exercise_catalog`): `exercise.external_id` (único), `name_en`,
  `equipment`, `target`, `secondary_muscles`/`instructions`/`images` (jsonb `string[]`),
  `category`, `video`, `media_attribution`, `archived_at`; índices em `exercise_id` de
  `workout_exercise` e `workout_record_exercise`.
- Índices: `workout(client_id, deleted_at, list_order)`,
  `workout_exercise(workout_id, list_order)`, `workout_record(workout_id, created_at)`.
- Tabelas descontinuadas: `workout_checkin`, `client_record`, `exercise_load_record`.

## Cutover pendente

1. `~/projects/meu-treino-app/lib/config/api_config.dart` — apontar `baseUrl` para a API nova.
2. Deploy (Postgres no Neon) e arquivar o repo Java.

O enum `BodyPart` do cliente Flutter **já foi atualizado** com os cinco novos grupos —
sem isso, `BodyPart.fromString` lançaria ao receber os exercícios do catálogo.
