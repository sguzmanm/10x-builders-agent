import { StateGraph, Annotation, Command, interrupt, messagesStateReducer } from "@langchain/langgraph";
import type { RunnableConfig } from "@langchain/core/runnables";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import {
  addMessage,
  createToolCall,
  findExistingPendingToolCall,
  updateToolCallStatus,
} from "@agents/db";
import { toolRequiresConfirmation } from "./tools/catalog";
import { getCheckpointer } from "./checkpointer";
import { createCompactionNode } from "./nodes/compaction_node";
import { createMemoryInjectionNode } from "./nodes/memory_injection_node";
import { createLangfuseConfig } from "./observability";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  compactionCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
});

export interface AgentInput {
  message?: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
  resumeDecision?: "approve" | "reject";
}

export interface PendingConfirmationPayload {
  tool_call_id: string;
  tool_name: string;
  message: string;
  args: Record<string, unknown>;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
  pendingConfirmation?: PendingConfirmationPayload | null;
}

const MAX_TOOL_ITERATIONS = 6;

const TIMEZONE = "America/Bogota";

function buildSystemMessage(basePrompt: string): string {
  const now = new Date().toLocaleString("es-CO", {
    timeZone: TIMEZONE,
    dateStyle: "full",
    timeStyle: "long",
  });
  return `${basePrompt}\n\nFecha y hora actual: ${now} (${TIMEZONE}).`;
}

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const {
    message,
    userId,
    sessionId,
    systemPrompt,
    db,
    enabledTools,
    integrations,
    githubToken,
    resumeDecision,
  } = input;
  if (!message && !resumeDecision) {
    throw new Error("runAgent requires either message or resumeDecision");
  }

  const model = createChatModel();
  const lcTools = buildLangChainTools({
    db,
    userId,
    sessionId,
    enabledTools,
    integrations,
    githubToken,
  });

  const modelWithTools = lcTools.length > 0 ? model.bindTools(lcTools) : model;
  if (message) {
    await addMessage(db, sessionId, "user", message);
  }

  const toolCallNames: string[] = [];
  const consecutiveFailures = { value: 0 };
  const compactionNode = createCompactionNode(consecutiveFailures);
  const memoryInjectionNode = createMemoryInjectionNode({ db, userId });

  async function agentNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke([
      new SystemMessage(buildSystemMessage(state.systemPrompt)),
      ...state.messages,
    ], config);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State,
    config?: RunnableConfig
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const results: BaseMessage[] = [];
    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (!matchingTool) {
        results.push(
          new ToolMessage({
            content: JSON.stringify({ error: `Tool not found: ${tc.name}` }),
            tool_call_id: tc.id!,
          })
        );
        continue;
      }

      const needsConfirmation = toolRequiresConfirmation(tc.name);
      if (needsConfirmation) {
        const existing = await findExistingPendingToolCall(db, state.sessionId, tc.name);
        const record = existing
          ?? await createToolCall(db, state.sessionId, tc.name, tc.args, true);
        const decision = interrupt<PendingConfirmationPayload, "approve" | "reject">({
          tool_call_id: record.id,
          tool_name: tc.name,
          message: buildConfirmationMessage(tc.name, tc.args),
          args: tc.args,
        });

        if (decision === "reject") {
          await updateToolCallStatus(db, record.id, "rejected", {
            message: "Action rejected by user",
          });
          results.push(
            new ToolMessage({
              content: JSON.stringify({ message: "Action cancelled by user." }),
              tool_call_id: tc.id!,
            })
          );
          continue;
        }

        await updateToolCallStatus(db, record.id, "approved");
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args, config);
        const resultStr = String(result);
        let parsedResult: Record<string, unknown> = { result: resultStr };
        try {
          parsedResult = JSON.parse(resultStr) as Record<string, unknown>;
        } catch {
          // Keep stringified fallback
        }
        await updateToolCallStatus(
          db,
          record.id,
          parsedResult.error ? "failed" : "executed",
          parsedResult
        );
        results.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id! }));
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (matchingTool as any).invoke(tc.args, config);
      const resultStr = String(result);
      results.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id! }));
    }
    return { messages: results };
  }

  function shouldContinue(state: typeof GraphState.State): string {
    const lastMsg = state.messages[state.messages.length - 1];
    if (lastMsg instanceof AIMessage && lastMsg.tool_calls?.length) {
      const iterations = state.messages.filter(
        (m) => m instanceof AIMessage && (m as AIMessage).tool_calls?.length
      ).length;
      if (iterations >= MAX_TOOL_ITERATIONS) return "end";
      return "tools";
    }
    return "end";
  }

  const graph = new StateGraph(GraphState)
    .addNode("memory_injection", memoryInjectionNode)
    .addNode("compaction", compactionNode)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "memory_injection")
    .addEdge("memory_injection", "compaction")
    .addEdge("compaction", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addEdge("tools", "compaction");

  const checkpointer = await getCheckpointer();
  const app = graph.compile({ checkpointer });
  const invokeConfig: RunnableConfig = {
    configurable: { thread_id: sessionId },
    ...createLangfuseConfig({
      runName: resumeDecision ? "agent.resume" : "agent.message",
      userId,
      sessionId,
      tags: [resumeDecision ? "resume" : "message"],
      metadata: {
        toolCount: lcTools.length,
        hasGithubIntegration: Boolean(githubToken),
        resumeDecision: resumeDecision ?? null,
      },
    }),
  };
  const finalState = resumeDecision
    ? await app.invoke(new Command({ resume: resumeDecision }), invokeConfig)
    : await app.invoke(
      {
        messages: [new HumanMessage(message as string)],
        sessionId,
        userId,
        systemPrompt,
      },
      invokeConfig
    );

  let responseText: string;
  const interrupts = (finalState as Record<string, unknown>).__interrupt__;
  if (Array.isArray(interrupts) && interrupts.length > 0) {
    const firstInterrupt = interrupts[0] as { value?: PendingConfirmationPayload };
    const payload = firstInterrupt?.value;
    if (payload) {
      await addMessage(
        db,
        sessionId,
        "assistant",
        payload.message,
        {
          tool_call_id: payload.tool_call_id,
          structured_payload: payload as unknown as Record<string, unknown>,
        }
      );
      return {
        response: payload.message,
        toolCalls: toolCallNames,
        pendingConfirmation: payload,
      };
    }
  }

  const finalMessages = Array.isArray(finalState.messages) ? finalState.messages : [];
  const lastMessage = finalMessages[finalMessages.length - 1];
  if (!lastMessage) {
    const errorMessage = resumeDecision
      ? "Graph resumed without messages. Checkpoint state missing or stale thread."
      : "Agent finished without messages.";
    throw new Error(errorMessage);
  }
  responseText =
    typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);

  await addMessage(db, sessionId, "assistant", responseText);

  return { response: responseText, toolCalls: toolCallNames, pendingConfirmation: null };
}

function buildConfirmationMessage(toolName: string, args: Record<string, unknown>): string {
  if (toolName === "github_create_issue") {
    const owner = String(args.owner ?? "");
    const repo = String(args.repo ?? "");
    const title = String(args.title ?? "");
    return `I need your confirmation to create issue "${title}" in ${owner}/${repo}.`;
  }
  if (toolName === "github_create_repo") {
    const name = String(args.name ?? "");
    const isPrivate = args.private === true;
    return `I need your confirmation to create repository "${name}"${isPrivate ? " (private)" : ""}.`;
  }
  if (toolName === "bash") {
    const terminal = String(args.terminal ?? "").trim() || "default";
    const prompt = String(args.prompt ?? "");
    const preview = prompt.length > 400 ? `${prompt.slice(0, 400)}…` : prompt;
    return `I need your confirmation to run bash in terminal "${terminal}":\n\n${preview}`;
  }
  if (toolName === "write_file") {
    const path = String(args.path ?? "");
    const content = String(args.content ?? "");
    const preview = content.length > 300 ? `${content.slice(0, 300)}…` : content;
    return `Necesito tu confirmacion para crear el archivo "${path}" con este contenido inicial:\n\n${preview}`;
  }
  if (toolName === "edit_file") {
    const path = String(args.path ?? "");
    const oldString = String(args.old_string ?? "");
    const newString = String(args.new_string ?? "");
    const oldPreview = oldString.length > 200 ? `${oldString.slice(0, 200)}…` : oldString;
    const newPreview = newString.length > 200 ? `${newString.slice(0, 200)}…` : newString;
    return `Necesito tu confirmacion para editar "${path}".\n\nBuscar:\n${oldPreview}\n\nReemplazar por:\n${newPreview}`;
  }
  return `I need your confirmation to execute "${toolName}".`;
}
