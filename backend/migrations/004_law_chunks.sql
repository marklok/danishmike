-- ---------------------------------------------------------------------------
-- 004_law_chunks.sql
--
-- Dedicated table for Danish law chunks from retsinformation.dk.
-- Replaces the retsinformation rows in document_chunks with a richer schema
-- that supports:
--   • Stable, human-readable chunk IDs (no UUIDs)
--   • Separate official_text / embedding_text fields
--   • Legal structure metadata (chapter, §, stk., litra)
--   • Parent / prev / next navigation
--   • Full-text search index (Danish stemming)
--   • HNSW vector index
--   • Exact citation lookup index
--
-- Run AFTER 001_document_chunks.sql (requires extensions.vector).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Table
-- ---------------------------------------------------------------------------

create table if not exists public.law_chunks (
  -- Stable chunk identifier: dk_{law_id}_p{section}[_s{stk}][_l{litra}]
  -- e.g. "dk_hvidvaskloven_p7_s1"
  id                 text primary key,

  -- Law identification
  law_id             text        not null,   -- slugified popular title, e.g. "hvidvaskloven"
  law_title          text        not null,   -- full official title from API
  short_names        text[]      not null default '{}', -- popular names / acronyms
  accession_number   text,                  -- e.g. "A20250146329"
  canonical_citation text,                  -- e.g. "LBK nr 1463 af 18/11/2025"
  year               integer     not null,
  number             integer     not null,

  -- Legal structure
  chapter_number     text,                  -- e.g. "2"
  chapter_title      text,                  -- e.g. "Risikovurdering"
  section_number     text        not null,  -- e.g. "7"  (§ 7)
  subsection         text,                  -- e.g. "1"  (stk. 1), null = full §
  nr_litra           text,                  -- e.g. "3" or "a" for nr./litra

  -- "section" = full § chunk | "subsection" = stk. chunk | "litra" = nr./litra chunk
  chunk_level        text        not null default 'section'
                       check (chunk_level in ('section', 'subsection', 'litra')),

  -- Navigation (populated during ingestion, used for context expansion)
  parent_id          text        references public.law_chunks(id) on delete set null,
  prev_id            text,                  -- previous sibling chunk id
  next_id            text,                  -- next sibling chunk id

  -- Text content
  official_text      text        not null,  -- exact legal text, never altered
  embedding_text     text        not null,  -- context header + official_text (what we embed)

  -- Vector embedding (null for parent/structural chunks that are stored for
  -- context expansion only, not directly retrieved by similarity search)
  embedding          extensions.vector(1536),

  -- Source & versioning
  source_url         text,
  source_retrieved_at timestamptz not null default now(),
  effective_date     date,
  is_current         boolean     not null default true,

  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Full-text search column (Danish stemming)
-- ---------------------------------------------------------------------------

alter table public.law_chunks
  add column if not exists fts tsvector
    generated always as (
      to_tsvector('danish', coalesce(official_text, ''))
    ) stored;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- HNSW vector index (only index rows that have an embedding)
create index if not exists law_chunks_embedding_idx
  on public.law_chunks using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- Danish FTS
create index if not exists law_chunks_fts_idx
  on public.law_chunks using gin(fts);

-- Exact citation lookup: law_id + section + optional subsection
create index if not exists law_chunks_citation_idx
  on public.law_chunks(law_id, section_number, subsection);

-- General law_id filter
create index if not exists law_chunks_law_id_idx
  on public.law_chunks(law_id);

-- short_names array search (for acronym lookup, e.g. "FIL")
create index if not exists law_chunks_short_names_idx
  on public.law_chunks using gin(short_names);

-- is_current filter (most queries filter on this)
create index if not exists law_chunks_is_current_idx
  on public.law_chunks(is_current) where is_current = true;

-- ---------------------------------------------------------------------------
-- RPC: vector similarity search
-- ---------------------------------------------------------------------------

create or replace function public.match_law_chunks(
  query_embedding  extensions.vector(1536),
  match_count      integer  default 10,
  filter_law_id    text     default null
)
returns table (
  id                 text,
  law_id             text,
  law_title          text,
  short_names        text[],
  canonical_citation text,
  chapter_number     text,
  chapter_title      text,
  section_number     text,
  subsection         text,
  nr_litra           text,
  chunk_level        text,
  parent_id          text,
  official_text      text,
  source_url         text,
  effective_date     date,
  similarity         float
)
language plpgsql
as $$
begin
  return query
  select
    lc.id,
    lc.law_id,
    lc.law_title,
    lc.short_names,
    lc.canonical_citation,
    lc.chapter_number,
    lc.chapter_title,
    lc.section_number,
    lc.subsection,
    lc.nr_litra,
    lc.chunk_level,
    lc.parent_id,
    lc.official_text,
    lc.source_url,
    lc.effective_date,
    1 - (lc.embedding <=> query_embedding) as similarity
  from public.law_chunks lc
  where
    lc.is_current = true
    and lc.embedding is not null
    and (filter_law_id is null or lc.law_id = filter_law_id)
  order by lc.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- RPC: Danish full-text search
-- ---------------------------------------------------------------------------

create or replace function public.search_law_chunks_fts(
  query_text       text,
  match_count      integer  default 10,
  filter_law_id    text     default null
)
returns table (
  id                 text,
  law_id             text,
  law_title          text,
  short_names        text[],
  canonical_citation text,
  chapter_number     text,
  chapter_title      text,
  section_number     text,
  subsection         text,
  nr_litra           text,
  chunk_level        text,
  parent_id          text,
  official_text      text,
  source_url         text,
  effective_date     date,
  rank               float
)
language plpgsql
as $$
begin
  return query
  select
    lc.id,
    lc.law_id,
    lc.law_title,
    lc.short_names,
    lc.canonical_citation,
    lc.chapter_number,
    lc.chapter_title,
    lc.section_number,
    lc.subsection,
    lc.nr_litra,
    lc.chunk_level,
    lc.parent_id,
    lc.official_text,
    lc.source_url,
    lc.effective_date,
    ts_rank(lc.fts, plainto_tsquery('danish', query_text))::float as rank
  from public.law_chunks lc
  where
    lc.is_current = true
    and lc.fts @@ plainto_tsquery('danish', query_text)
    and (filter_law_id is null or lc.law_id = filter_law_id)
  order by rank desc
  limit match_count;
end;
$$;
