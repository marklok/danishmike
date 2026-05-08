-- Rebuild the IVFFlat index with fewer lists to reduce memory requirement.

drop index if exists document_chunks_embedding_idx;

create index document_chunks_embedding_idx
  on public.document_chunks using ivfflat (embedding extensions.vector_cosine_ops)
  with (lists = 20);
