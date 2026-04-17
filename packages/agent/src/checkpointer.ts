import { MemorySaver } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";

let postgresSaver: PostgresSaver | null = null;
let memorySaver: MemorySaver | null = null;

/**
 * LangGraph checkpointer. Uses Postgres when DATABASE_URL is set (required for
 * durable HITL / interrupt resume in production). Falls back to in-memory for local dev.
 *
 * Both savers are module-level singletons so checkpoint state survives across
 * multiple runAgent() calls within the same process lifetime.
 */
export async function getCheckpointer(): Promise<PostgresSaver | MemorySaver> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (!memorySaver) memorySaver = new MemorySaver();
    return memorySaver;
  }
  if (!postgresSaver) {
    postgresSaver = PostgresSaver.fromConnString(url);
    await postgresSaver.setup();
  }
  return postgresSaver;
}
