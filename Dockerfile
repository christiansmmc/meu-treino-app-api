FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY . .

FROM oven/bun:1-alpine
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/data ./data
COPY --from=builder /app/package.json ./
ENV NODE_ENV=production
EXPOSE 8080
CMD ["bun", "run", "src/index.ts"]
