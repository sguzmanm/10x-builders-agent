CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  type              TEXT        NOT NULL CHECK (type IN ('episodic','semantic','procedural')),
  content           TEXT        NOT NULL,
  embedding         vector(1536),
  retrieval_count   INT         NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_retrieved_at TIMESTAMPTZ
);

CREATE INDEX ON memories USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE OR REPLACE FUNCTION search_memories(
  p_user_id  UUID,
  p_embedding vector(1536),
  p_limit    INT DEFAULT 8
)
RETURNS SETOF memories
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM memories
  WHERE user_id = p_user_id
    AND embedding IS NOT NULL
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;

CREATE OR REPLACE FUNCTION increment_memory_retrievals(p_ids UUID[])
RETURNS void
LANGUAGE sql
AS $$
  UPDATE memories
  SET retrieval_count = retrieval_count + 1,
      last_retrieved_at = NOW()
  WHERE id = ANY(p_ids);
$$;
