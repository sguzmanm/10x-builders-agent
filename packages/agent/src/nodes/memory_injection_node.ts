import { HumanMessage } from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import { searchMemories, incrementRetrievalCount } from "@agents/db";
import { generateEmbedding } from "../embeddings";

interface MemoryInjectionState {
  messages: import("@langchain/core/messages").BaseMessage[];
  systemPrompt: string;
  userId: string;
}

export function createMemoryInjectionNode(params: {
  db: DbClient;
  userId: string;
}) {
  const { db, userId } = params;

  return async function memoryInjectionNode(
    state: MemoryInjectionState
  ): Promise<Partial<MemoryInjectionState>> {
    const userMessage = state.messages.find((m) => m instanceof HumanMessage);
    if (!userMessage) return {};

    const inputText =
      typeof userMessage.content === "string"
        ? userMessage.content
        : JSON.stringify(userMessage.content);

    let embedding: number[];
    try {
      embedding = await generateEmbedding(inputText);
    } catch {
      return {};
    }

    let memories: Awaited<ReturnType<typeof searchMemories>>;
    try {
      memories = await searchMemories(db, { userId, embedding, limit: 8 });
    } catch {
      return {};
    }

    if (memories.length === 0) return {};

    const ids = memories.map((m) => m.id);
    incrementRetrievalCount(db, ids).catch(() => {});

    const memoryBlock = memories
      .map((m) => `[${m.type}] ${m.content}`)
      .join("\n");

    const updatedSystemPrompt = `${state.systemPrompt}\n\n[MEMORIA DEL USUARIO]\n${memoryBlock}`;

    return { systemPrompt: updatedSystemPrompt };
  };
}
