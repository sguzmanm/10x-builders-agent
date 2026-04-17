import type { DbClient } from "../client";

export interface Memory {
  id: string;
  user_id: string;
  type: "episodic" | "semantic" | "procedural";
  content: string;
  embedding: number[] | null;
  retrieval_count: number;
  created_at: string;
  last_retrieved_at: string | null;
}

export async function saveMemory(
  db: DbClient,
  params: {
    userId: string;
    type: "episodic" | "semantic" | "procedural";
    content: string;
    embedding: number[];
  }
): Promise<Memory> {
  const { data, error } = await db
    .from("memories")
    .insert({
      user_id: params.userId,
      type: params.type,
      content: params.content,
      embedding: JSON.stringify(params.embedding),
    })
    .select()
    .single();
  if (error) throw error;
  return data as Memory;
}

export async function searchMemories(
  db: DbClient,
  params: { userId: string; embedding: number[]; limit?: number; minSimilarity?: number }
): Promise<Memory[]> {
  const { data, error } = await db.rpc("search_memories", {
    p_user_id: params.userId,
    p_embedding: JSON.stringify(params.embedding),
    p_limit: params.limit ?? 8,
    p_min_similarity: params.minSimilarity ?? 0,
  });
  if (error) throw error;
  return (data ?? []) as Memory[];
}

export async function incrementRetrievalCount(
  db: DbClient,
  ids: string[]
): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await db.rpc("increment_memory_retrievals", {
    p_ids: ids,
  });
  if (error) throw error;
}
