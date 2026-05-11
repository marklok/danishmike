# Mike

Mike is an AI-powered legal assistant for Danish lawyers. It combines document analysis with a curated knowledge base of ~50 Danish laws and selected EU regulations, enabling precise citation lookup, full-text search, and vector-based semantic retrieval.

## Architecture

```
danishmike/
├── frontend/          # Next.js 16 app (deployed on Vercel)
├── backend/           # Express API (deployed on Fly.io)
│   ├── src/
│   │   ├── ingestion/ # Law sync pipeline (retsinformation.dk + EUR-Lex)
│   │   ├── lib/       # Core logic: retrieval, LLM, storage, auth
│   │   └── routes/    # HTTP endpoints
│   └── migrations/    # Incremental SQL migrations
└── .github/workflows/ # GitHub Actions: weekly law sync
```

**Infrastructure:**
- **Frontend:** Vercel (`https://danishmike.vercel.app`)
- **Backend:** Fly.io (`https://mike-backend.fly.dev`), single always-on machine in Stockholm
- **Database:** Supabase (Postgres + pgvector)
- **Storage:** Cloudflare R2 (S3-compatible) for user-uploaded documents
- **Email:** Resend (sync failure alerts)

## Law Knowledge Base

### How it works

Laws are stored in `law_chunks` — a Postgres table with one row per section or subsection. Each chunk carries structured metadata (`law_id`, `section`, `subsection`, `nr_litra`) and a pgvector embedding.

When the assistant references a specific provision (e.g. *Selskabslovens § 110, stk. 2*), the backend runs a three-stage retrieval cascade:

1. **Exact citation lookup** — matches law, section, subsection, and litra directly against `law_chunks`. Returns both the specific litra chunk and its parent subsection so the assistant sees full context.
2. **Full-text search (FTS)** — Postgres `to_tsvector` search scoped to the law when a hint is present.
3. **Vector search** — pgvector cosine similarity via a Supabase RPC function, also scopeable to a single law.

### Sync pipeline

Laws are fetched and chunked weekly:

- **retsinformation.dk** — ~50 Danish laws resolved by popular title or title search, always fetching the latest consolidated version. Managed via `RETSINFORMATION_LAWS` in `backend/.env`.
- **EUR-Lex** — Selected EU regulations (DORA, PRIIPs) fetched via CELEX number. Managed via `EURLEX_REGULATIONS` in `backend/.env`.

The sync runs in two ways:
- **In-process cron:** `node-cron` fires every Sunday at 02:00 inside the backend process.
- **GitHub Actions:** `.github/workflows/law-sync.yml` fires on the same schedule and calls `POST /admin/sync` as a belt-and-suspenders fallback.

If any law fails to sync, a failure digest email is sent to `SYNC_NOTIFY_EMAIL` via Resend.

To trigger a sync manually:
```bash
curl -X POST https://mike-backend.fly.dev/admin/sync \
  -H "x-admin-secret: <SYNC_ADMIN_SECRET>"
```

## Prerequisites

- Node.js 20+
- A Supabase project (Postgres + pgvector enabled)
- A Cloudflare R2 bucket (or any S3-compatible bucket)
- At least one LLM provider key: Anthropic, Google Gemini, or OpenAI
- LibreOffice installed locally for DOCX→PDF conversion

## Database Setup

For a **new** database, run the full schema in the Supabase SQL editor:
```
backend/migrations/001_document_chunks.sql
backend/migrations/002_reindex_chunks.sql
backend/migrations/003_user_api_keys.sql
backend/migrations/004_law_chunks.sql
```

For an **existing** database, apply only the migrations that haven't been run yet.

## Environment Variables

### `backend/.env`

```bash
PORT=3001
FRONTEND_URL=http://localhost:3000

SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SECRET_KEY=your-supabase-service-role-key

R2_ENDPOINT_URL=https://your-account-id.r2.cloudflarestorage.com
R2_ACCESS_KEY_ID=your-r2-access-key
R2_SECRET_ACCESS_KEY=your-r2-secret-key
R2_BUCKET_NAME=mike

# LLM providers — set at instance level or leave blank for per-user keys
# ANTHROPIC_API_KEY=...
# GEMINI_API_KEY=...
# OPENAI_API_KEY=...

USER_API_KEYS_ENCRYPTION_SECRET=a-random-64-char-hex-string

# Law sync
SYNC_ADMIN_SECRET=a-random-64-char-hex-string  # protects POST /admin/sync
RESEND_API_KEY=re_...                           # Resend API key for failure alerts
SYNC_NOTIFY_EMAIL=you@example.com              # receives alerts when sync fails
SYNC_NOTIFY_FROM=Mike Sync <noreply@yourdomain.com>  # optional sender override

# Laws to index — comma-separated popular titles (name-based auto-resolution)
# Use year/number:label syntax only for laws that cannot be resolved by name.
RETSINFORMATION_LAWS=aftaleloven,selskabsloven,konkursloven,...

# EU regulations — comma-separated CELEX numbers with optional :label
EURLEX_REGULATIONS=32022R2554:DORA,32014R1286:PRIIPs
```

### `frontend/.env.local`

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY=your-supabase-anon-key
SUPABASE_SECRET_KEY=your-supabase-service-role-key
NEXT_PUBLIC_API_BASE_URL=http://localhost:3001
```

Supabase values come from the project dashboard. Use the legacy JWT-style anon and service role keys (not the newer `sb_...` format) if prompted.

## Running Locally

```bash
npm install --prefix backend
npm install --prefix frontend

npm run dev --prefix backend   # http://localhost:3001
npm run dev --prefix frontend  # http://localhost:3000
```

### Running a law sync locally

```bash
npm run sync:retsinformation --prefix backend
npm run sync:eurlex --prefix backend
```

## Deployment

### Backend (Fly.io)

```bash
cd backend
fly deploy
```

Secrets required on Fly.io (set with `fly secrets set KEY=value`):
`SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `FRONTEND_URL`, `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`, `USER_API_KEYS_ENCRYPTION_SECRET`, `SYNC_ADMIN_SECRET`, `RESEND_API_KEY`, `SYNC_NOTIFY_EMAIL`, `RETSINFORMATION_LAWS`, `EURLEX_REGULATIONS`

### Frontend (Vercel)

Import the repo in Vercel, set root directory to `frontend`, and add these environment variables:
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY`, `SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_API_BASE_URL`, `R2_ENDPOINT_URL`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`

### GitHub Actions (weekly sync)

Add two repository secrets:
- `BACKEND_URL` → `https://mike-backend.fly.dev`
- `SYNC_ADMIN_SECRET` → same value as on Fly.io

The workflow (`.github/workflows/law-sync.yml`) runs every Sunday at 02:00 UTC and can also be triggered manually from the Actions tab.

## First Run

1. Sign up in the app.
2. If no provider key is set in `backend/.env`, open **Account → Models & API Keys** and add an Anthropic, Gemini, or OpenAI key.
3. Create a project, upload documents, and start chatting.

## Useful Commands

```bash
npm run build --prefix backend     # TypeScript compile check
npm run build --prefix frontend    # Next.js production build
npm run test --prefix backend      # Vitest unit tests
npm run lint --prefix frontend     # ESLint
```

## Troubleshooting

**Sign-up confirmation email never arrives.** For local development, disable email confirmation in Supabase → Authentication → Providers → Email. For production, configure custom SMTP in Supabase.

**Model picker shows a missing-key warning.** Add a key for that provider in Account → Models & API Keys, or set the provider key in `backend/.env` and restart.

**DOCX conversion fails.** Install LibreOffice and restart the backend.

**Law sync sends a failure alert email.** Check Fly.io logs (`fly logs --app mike-backend`) for the specific error. Laws that fail retain their previous version in the database until the next successful sync.
