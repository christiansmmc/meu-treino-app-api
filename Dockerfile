FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Imagens do catálogo embutidas na imagem: num host sem disco persistente
# (Render free: sistema de arquivos efêmero) a API sobe já com a mídia. Estágio
# separado e só com o que o media:fetch usa, para a camada ficar em cache
# enquanto o manifesto e o processamento não mudarem (mudar uma rota não baixa
# tudo de novo). O media:fetch sai com 1 só se as falhas passarem de
# MEDIA_MAX_FAIL_RATIO (padrão 5%): algumas falhas de download não derrubam o
# build, só deixam aquelas imagens em 404. O cache de originais (.raw/, ~17 MB)
# é apagado no mesmo RUN e não entra em camada nenhuma.
FROM oven/bun:1-alpine AS media
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/media ./src/media
COPY src/shared/media-paths.ts ./src/shared/media-paths.ts
COPY data/media-manifest.json ./data/media-manifest.json
ARG MEDIA_MAX_FAIL_RATIO=0.05
RUN bun run src/media/fetch-media.ts data/media-manifest.json /app/media \
      --max-fail-ratio="${MEDIA_MAX_FAIL_RATIO}" \
 && rm -rf /app/media/.raw

FROM oven/bun:1-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    MEDIA_DIR=/app/media \
    CATALOG_SYNC_ON_START=true
COPY --from=deps /app/node_modules ./node_modules
# MEDIA_DIR: a mídia vem embutida (estágio media), com dono bun. Montar um
# volume em /app/media continua funcionando: um volume nomeado novo nasce com
# esta cópia (e gravável pelo usuário bun, para o `bun run media:fetch` do
# stack completar/atualizar); um volume já preenchido ou um bind mount
# esconde a cópia da imagem.
RUN mkdir -p /app/media && chown bun:bun /app/media
COPY --from=media --chown=bun:bun /app/media/ /app/media/
COPY package.json NOTICE.md ./
# src/ inclui src/db/migrations; data/ traz exercises.json (+ legacy-exercise-map.csv) do catalog:sync
# e media-manifest.json do media:fetch. NOTICE.md: licenças do catálogo e das imagens.
COPY src ./src
COPY data ./data
USER bun
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT}/api/health" || exit 1
# migrations → catalog:sync (se CATALOG_SYNC_ON_START) → servidor. Ver src/boot.ts.
CMD ["bun", "run", "src/boot.ts"]
