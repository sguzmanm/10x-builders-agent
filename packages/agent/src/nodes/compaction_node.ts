import { appendFileSync } from "fs";
import { resolve } from "path";
import {
  AIMessage,
  HumanMessage,
  RemoveMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatOpenAI } from "@langchain/openai";

const CONTEXT_WINDOW_TOKENS = 128_000;
const COMPACTION_THRESHOLD = 0.8;
const KEEP_LAST_TOOL_RESULTS = 5;
const MAX_CIRCUIT_BREAKER = 3;

const LOG_FILE = resolve(
  process.env.COMPACTION_LOG_FILE ?? "compaction.log"
);

interface CompactionState {
  messages: BaseMessage[];
  compactionCount: number;
  sessionId: string;
}

type LogEvent =
  | "MICRO_SKIP"
  | "MICRO_APPLY"
  | "BELOW_THRESHOLD"
  | "LLM_COMPACT_START"
  | "LLM_COMPACT_SUCCESS"
  | "LLM_COMPACT_FAIL"
  | "CIRCUIT_BREAKER";

function writeLog(
  event: LogEvent,
  sessionId: string,
  data: Record<string, unknown>
): void {
  const entry =
    JSON.stringify({ ts: new Date().toISOString(), event, sessionId, ...data }) +
    "\n";
  try {
    appendFileSync(LOG_FILE, entry, "utf8");
  } catch {
    // Non-fatal: if the log file can't be written we don't want to break the agent
  }
}

function estimateTokens(messages: BaseMessage[]): number {
  const totalChars = messages.reduce((sum, m) => {
    const content =
      typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return sum + content.length;
  }, 0);
  return Math.ceil(totalChars / 4);
}

/**
 * Stage 1: Replace old tool results with a cleared placeholder, keeping the
 * last KEEP_LAST_TOOL_RESULTS intact.  Returns updated ToolMessage objects
 * carrying the same IDs so messagesStateReducer applies them in-place.
 * Returns an empty array when no changes are needed.
 */
function microcompact(messages: BaseMessage[]): ToolMessage[] {
  const toolIndices = messages
    .map((m, i) => (m instanceof ToolMessage ? i : -1))
    .filter((i) => i !== -1);

  if (toolIndices.length <= KEEP_LAST_TOOL_RESULTS) return [];

  const toClear = new Set(
    toolIndices.slice(0, toolIndices.length - KEEP_LAST_TOOL_RESULTS)
  );

  return messages
    .filter((_, i) => toClear.has(i))
    .map((m) => {
      const tm = m as ToolMessage;
      return new ToolMessage({
        content: "[tool result cleared]",
        tool_call_id: tm.tool_call_id,
        id: tm.id,
      });
    });
}

function createCompactionModel(): ChatOpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("Missing OPENROUTER_API_KEY");

  return new ChatOpenAI({
    modelName: "anthropic/claude-3-haiku",
    temperature: 0,
    configuration: {
      baseURL: "https://openrouter.ai/api/v1",
      defaultHeaders: { "HTTP-Referer": "https://agents.local" },
    },
    apiKey,
  });
}

const COMPACTION_SYSTEM_PROMPT = `You are a conversation summarizer. Analyze the full conversation history and produce a structured summary with exactly these 9 sections:

1. **Objective**: Main goal and sub-goals the user is pursuing
2. **Progress**: Completed steps and milestones, in order
3. **Decisions**: Key choices made and their rationale
4. **Code & Files**: Files created/modified, their purpose, and key implementation details
5. **Tool Results**: Important outputs from tool executions (errors, successes, key data)
6. **Blockers**: Current issues, errors, or pending items requiring resolution
7. **Context**: Background information, constraints, and user preferences
8. **Next Steps**: What must happen next to achieve the objective
9. **State**: Current environment state (files, variables, configurations)

Be comprehensive but concise. Preserve exact file paths, error messages, variable names, command outputs, and all technical details critical for continuity.`;

async function llmCompact(messages: BaseMessage[]): Promise<string> {
  const model = createCompactionModel();

  const conversationText = messages
    .map((m) => {
      const role =
        m instanceof HumanMessage
          ? "Human"
          : m instanceof AIMessage
            ? "Assistant"
            : "Tool";
      const content =
        typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      return `[${role}]: ${content}`;
    })
    .join("\n\n");

  const response = await model.invoke([
    new SystemMessage(COMPACTION_SYSTEM_PROMPT),
    new HumanMessage(
      `Please summarize this conversation:\n\n${conversationText}`
    ),
  ]);

  let summary =
    typeof response.content === "string"
      ? response.content
      : JSON.stringify(response.content);

  summary = summary.replace(/<analysis>[\s\S]*?<\/analysis>/g, "").trim();

  return summary;
}

export function createCompactionNode(failuresRef: { value: number }) {
  return async function compactionNode(
    state: CompactionState
  ): Promise<Partial<CompactionState>> {
    const { messages, sessionId } = state;

    // Stage 1: microcompact (free, always runs)
    const microUpdates = microcompact(messages);

    if (microUpdates.length > 0) {
      writeLog("MICRO_APPLY", sessionId, {
        cleared: microUpdates.length,
        totalToolMessages: messages.filter((m) => m instanceof ToolMessage).length,
        clearedIds: microUpdates.map((u) => ({
          id: u.id,
          tool_call_id: u.tool_call_id,
        })),
      });
    } else {
      writeLog("MICRO_SKIP", sessionId, {
        toolMessageCount: messages.filter((m) => m instanceof ToolMessage).length,
        keepLast: KEEP_LAST_TOOL_RESULTS,
      });
    }

    // Compute effective messages for token estimation
    const updatesById = new Map(microUpdates.map((u) => [u.id, u]));
    const effectiveMessages =
      microUpdates.length > 0
        ? messages.map((m) => updatesById.get(m.id) ?? m)
        : messages;

    const tokenEstimate = estimateTokens(effectiveMessages);
    const tokenThreshold = Math.floor(CONTEXT_WINDOW_TOKENS * COMPACTION_THRESHOLD);

    if (tokenEstimate < tokenThreshold) {
      writeLog("BELOW_THRESHOLD", sessionId, {
        tokenEstimate,
        tokenThreshold,
        contextWindowTokens: CONTEXT_WINDOW_TOKENS,
        thresholdPct: COMPACTION_THRESHOLD,
        messageCount: effectiveMessages.length,
      });
      return microUpdates.length > 0 ? { messages: microUpdates } : {};
    }

    // Circuit breaker: too many consecutive LLM failures
    if (failuresRef.value >= MAX_CIRCUIT_BREAKER) {
      writeLog("CIRCUIT_BREAKER", sessionId, {
        consecutiveFailures: failuresRef.value,
        maxAllowed: MAX_CIRCUIT_BREAKER,
        tokenEstimate,
        action: "skipping LLM compaction, returning micro updates only",
      });
      return microUpdates.length > 0 ? { messages: microUpdates } : {};
    }

    // Stage 2: LLM compaction
    writeLog("LLM_COMPACT_START", sessionId, {
      tokenEstimate,
      tokenThreshold,
      messageCount: effectiveMessages.length,
      consecutiveFailures: failuresRef.value,
      compactionCount: state.compactionCount,
    });

    try {
      const summary = await llmCompact(effectiveMessages);

      // Remove every existing message (by ID) and inject the compact summary
      const removeAll = effectiveMessages
        .filter((m) => m.id != null)
        .map((m) => new RemoveMessage({ id: m.id as string }));

      // Preserve the last human question as a fresh message (no ID → new entry)
      const lastHuman = [...effectiveMessages]
        .reverse()
        .find((m) => m instanceof HumanMessage);
      const freshHuman = lastHuman
        ? new HumanMessage(
            typeof lastHuman.content === "string"
              ? lastHuman.content
              : JSON.stringify(lastHuman.content)
          )
        : null;

      const compacted: BaseMessage[] = [
        ...removeAll,
        new SystemMessage(`[CONVERSATION SUMMARY]\n\n${summary}`),
        ...(freshHuman ? [freshHuman] : []),
      ];

      failuresRef.value = 0;

      writeLog("LLM_COMPACT_SUCCESS", sessionId, {
        removedMessages: removeAll.length,
        summaryLength: summary.length,
        summaryPreview: summary.slice(0, 500) + (summary.length > 500 ? "…" : ""),
        newCompactionCount: state.compactionCount + 1,
        preservedHumanMessage: freshHuman
          ? (typeof freshHuman.content === "string"
              ? freshHuman.content.slice(0, 120)
              : "[non-string content]")
          : null,
      });

      return {
        messages: compacted,
        compactionCount: state.compactionCount + 1,
      };
    } catch (err) {
      failuresRef.value += 1;

      writeLog("LLM_COMPACT_FAIL", sessionId, {
        error: err instanceof Error ? err.message : String(err),
        consecutiveFailures: failuresRef.value,
        maxAllowed: MAX_CIRCUIT_BREAKER,
        willCircuitBreakNext: failuresRef.value >= MAX_CIRCUIT_BREAKER,
      });

      return microUpdates.length > 0 ? { messages: microUpdates } : {};
    }
  };
}
