import { ChatOpenAI } from "@langchain/openai";
import type { DbClient } from "@agents/db";
import { getSessionMessages, saveMemory, searchMemories } from "@agents/db";
import { generateEmbedding } from "./embeddings";

interface MemoryItem {
  type: "episodic" | "semantic" | "procedural";
  content: string;
}

function buildExtractionPrompt(transcript: string): string {
  return `Extract only facts that will still be true in the next session. Classify each as episodic, semantic, or procedural. Return a JSON array with objects having "type" and "content" fields. If nothing is worth remembering, return [].

Conversation transcript:
${transcript}

Return only valid JSON, no explanation.`;
}

function formatTranscript(
  messages: Awaited<ReturnType<typeof getSessionMessages>>
): string {
  return messages
    .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");
}

export async function flushSessionMemory(params: {
  db: DbClient;
  userId: string;
  sessionId: string;
}): Promise<void> {
  const { db, userId, sessionId } = params;

  console.log("[memory_flush] starting for session", sessionId, "user", userId);

  const messages = await getSessionMessages(db, sessionId, 200);
  console.log("[memory_flush] loaded", messages.length, "messages");
  if (messages.length === 0) return;

  const transcript = formatTranscript(messages);

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[memory_flush] OPENROUTER_API_KEY not set");
    return;
  }

  const model = new ChatOpenAI({
    modelName: "anthropic/claude-3-5-haiku",
    temperature: 0,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://agents.local" },
    },
    apiKey,
  });

  let rawResponse: string;
  try {
    const response = await model.invoke([
      { role: "user", content: buildExtractionPrompt(transcript) },
    ]);
    rawResponse =
      typeof response.content === "string"
        ? response.content
        : JSON.stringify(response.content);
    console.log("[memory_flush] LLM raw response:", rawResponse.slice(0, 300));
  } catch (error) {
    console.error("[memory_flush] LLM call failed", error);
    return;
  }

  let items: MemoryItem[];
  try {
    const jsonMatch = rawResponse.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      console.warn("[memory_flush] no JSON array found in response");
      return;
    }
    items = JSON.parse(jsonMatch[0]) as MemoryItem[];
    if (!Array.isArray(items) || items.length === 0) {
      console.log("[memory_flush] LLM returned empty memory list");
      return;
    }
    console.log("[memory_flush] extracted", items.length, "memory items");
  } catch (error) {
    console.error("[memory_flush] JSON parse failed", error);
    return;
  }

  const results = await Promise.allSettled(
    items
      .filter(
        (item) =>
          item.content &&
          ["episodic", "semantic", "procedural"].includes(item.type)
      )
      .map(async (item) => {
        const embedding = await generateEmbedding(item.content);
        const duplicates = await searchMemories(db, { userId, embedding, limit: 1, minSimilarity: 0.92 });
        if (duplicates.length > 0) {
          console.log("[memory_flush] skipping duplicate:", item.content.slice(0, 60));
          return item.content;
        }
        await saveMemory(db, {
          userId,
          type: item.type,
          content: item.content,
          embedding,
        });
        return item.content;
      })
  );

  const saved = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected");
  console.log("[memory_flush] saved", saved, "memories");
  for (const f of failed) {
    console.error("[memory_flush] save failed:", (f as PromiseRejectedResult).reason);
  }
}
