# Spike-only image for Fly.io (Horizon Pulse / Next.js Node 20).
# Do NOT bake secrets into this file or the image. Set secrets via `fly secrets`.
# Prep only — do not `fly deploy` from this spike without operator go-ahead.

FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Fly injects PORT; Next must listen on all interfaces.
ENV HOSTNAME=0.0.0.0
ENV PORT=8080

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/package.json /app/package-lock.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/next.config.ts ./
# App source needed for Next without `output: "standalone"`.
COPY --from=builder /app/app ./app
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/components ./components
COPY --from=builder /app/tsconfig.json ./

USER nextjs
EXPOSE 8080

# Bind explicitly: 0.0.0.0:$PORT (Fly sets PORT).
CMD ["sh", "-c", "npx next start -H 0.0.0.0 -p ${PORT:-8080}"]
