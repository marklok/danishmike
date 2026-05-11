-- Encrypted API key storage — allows users to bring their own API keys
-- for Claude, Gemini, and OpenAI. Keys are encrypted at rest using
-- AES-256-GCM with a server-side secret (USER_API_KEYS_ENCRYPTION_SECRET).

create table if not exists public.user_api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null,
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

alter table public.user_api_keys enable row level security;

create policy "Users can manage their own API keys"
  on public.user_api_keys
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
