-- Vector store for chunked document content (used by the retsinformation
-- ingestion pipeline and future RAG search).
-- Requires the pgvector extension — enable it in your Supabase dashboard
-- under Database → Extensions before running this migration.

create extension if not exists vector with schema extensions;

create table if not exists public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  content text not null,
  embedding extensions.vector(1536),
  metadata jsonb not null default '{}'::jsonb,
  source text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists document_chunks_source_idx
  on public.document_chunks(source);

create index if not exists document_chunks_metadata_idx
  on public.document_chunks using gin (metadata);

create index if not exists document_chunks_embedding_idx
  on public.document_chunks using ivfflat (embedding extensions.vector_cosine_ops)
  with (lists = 100);

-- RPC for similarity search — returns the closest chunks to a query vector.
create or replace function public.match_document_chunks(
  query_embedding extensions.vector(1536),
  match_count int default 10,
  filter_source text default null,
  filter_metadata jsonb default null
)
returns table (
  id uuid,
  content text,
  metadata jsonb,
  source text,
  similarity float
)
language plpgsql
as $$
begin
  return query
  select
    dc.id,
    dc.content,
    dc.metadata,
    dc.source,
    1 - (dc.embedding <=> query_embedding) as similarity
  from public.document_chunks dc
  where
    (filter_source is null or dc.source = filter_source)
    and (filter_metadata is null or dc.metadata @> filter_metadata)
  order by dc.embedding <=> query_embedding
  limit match_count;
end;
$$;
