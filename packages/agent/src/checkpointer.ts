import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let postgresSaver: PostgresSaver | null = null;

/**
 * LangGraph checkpointer. Uses Postgres when DATABASE_URL is set (required for
 * durable HITL / interrupt resume in production). Falls back to in-memory for local dev.
 */
export async function getCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    return new MemorySaver();
  }
  if (!postgresSaver) {
    postgresSaver = PostgresSaver.fromConnString(url);
    await postgresSaver.setup();
  }
  return postgresSaver;
}
