-- Replace IVFFlat with HNSW — IVFFlat requires ~60MB maintenance_work_mem
-- to build (even at lists=10), which exceeds the Supabase free tier limit of 32MB.
-- HNSW builds incrementally so memory stays low, and search quality is better.

drop index if exists document_chunks_embedding_idx;

create index document_chunks_embedding_idx
  on public.document_chunks using hnsw (embedding extensions.vector_cosine_ops)
  with (m = 16, ef_construction = 64);
