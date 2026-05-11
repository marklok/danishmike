# ── Stage 1: build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci                      # install all deps including devDependencies (tsc)

COPY tsconfig.json ./
COPY src ./src
RUN npm run build               # compiles TypeScript → dist/

# ── Stage 2: run ──────────────────────────────────────────────────────────────
FROM node:20-slim

# LibreOffice needed for document conversion
RUN apt-get update && apt-get install -y --no-install-recommends \
    libreoffice \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev           # production deps only

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
