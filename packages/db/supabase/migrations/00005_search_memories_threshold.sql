CREATE OR REPLACE FUNCTION search_memories(
  p_user_id        UUID,
  p_embedding      vector(1536),
  p_limit          INT   DEFAULT 8,
  p_min_similarity FLOAT DEFAULT 0
)
RETURNS SETOF memories
LANGUAGE sql STABLE
AS $$
  SELECT *
  FROM memories
  WHERE user_id = p_user_id
    AND embedding IS NOT NULL
    AND 1 - (embedding <=> p_embedding) >= p_min_similarity
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;
