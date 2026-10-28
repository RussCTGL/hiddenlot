# HiddenLot: one container holds the whole app (Next.js pages, server actions
# and the embedded Postgres). No secrets are baked in: META_API_KEY is passed
# at runtime, and the database lives on a volume at /app/.data.

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
WORKDIR /app
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# The build never touches the runtime database.
RUN HIDDENLOT_DB_DIR=/tmp/build-db npm run build

FROM node:22-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    HIDDENLOT_DB_DIR=/app/.data/pglite
RUN useradd --system --uid 1001 hiddenlot && mkdir -p /app/.data && chown hiddenlot /app/.data
COPY --from=build --chown=hiddenlot /app/.next/standalone ./
COPY --from=build --chown=hiddenlot /app/.next/static ./.next/static
USER hiddenlot
EXPOSE 3000
VOLUME ["/app/.data"]
CMD ["node", "server.js"]
