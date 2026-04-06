import { StateGraph, Annotation, MemorySaver } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { DbClient } from "@agents/db";
import type { UserToolSetting, UserIntegration } from "@agents/types";
import { createChatModel } from "./model";
import { buildLangChainTools } from "./tools/adapters";
import { getSessionMessages, addMessage } from "@agents/db";

const GraphState = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  sessionId: Annotation<string>(),
  userId: Annotation<string>(),
  systemPrompt: Annotation<string>(),
  hasPendingConfirmation: Annotation<boolean>({
    reducer: (_prev, next) => next,
    default: () => false,
  }),
});

export interface AgentInput {
  message: string;
  userId: string;
  sessionId: string;
  systemPrompt: string;
  db: DbClient;
  enabledTools: UserToolSetting[];
  integrations: UserIntegration[];
  githubToken?: string;
}

export interface AgentOutput {
  response: string;
  toolCalls: string[];
}

const MAX_TOOL_ITERATIONS = 6;

export async function runAgent(input: AgentInput): Promise<AgentOutput> {
  const { message, userId, sessionId, systemPrompt, db, enabledTools, integrations, githubToken } = input;

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

  const history = await getSessionMessages(db, sessionId, 30);
  const priorMessages: BaseMessage[] = history.map((m) => {
    if (m.role === "user") return new HumanMessage(m.content);
    if (m.role === "assistant") return new AIMessage(m.content);
    return new HumanMessage(m.content);
  });

  await addMessage(db, sessionId, "user", message);

  const toolCallNames: string[] = [];

  async function agentNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const response = await modelWithTools.invoke(state.messages);
    return { messages: [response] };
  }

  async function toolExecutorNode(
    state: typeof GraphState.State
  ): Promise<Partial<typeof GraphState.State>> {
    const lastMsg = state.messages[state.messages.length - 1];
    if (!(lastMsg instanceof AIMessage) || !lastMsg.tool_calls?.length) {
      return {};
    }

    const { ToolMessage } = await import("@langchain/core/messages");
    const results: BaseMessage[] = [];
    let foundPending = false;
    for (const tc of lastMsg.tool_calls) {
      const matchingTool = lcTools.find((t) => t.name === tc.name);
      toolCallNames.push(tc.name);
      if (matchingTool) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (matchingTool as any).invoke(tc.args);
        const resultStr = String(result);
        results.push(new ToolMessage({ content: resultStr, tool_call_id: tc.id! }));
        try {
          const parsed = JSON.parse(resultStr);
          if (parsed.pending_confirmation) foundPending = true;
        } catch {
          // not JSON
        }
      }
    }
    return { messages: results, hasPendingConfirmation: foundPending };
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

  function afterTools(state: typeof GraphState.State): string {
    if (state.hasPendingConfirmation) return "end";
    return "agent";
  }

  const graph = new StateGraph(GraphState)
    .addNode("agent", agentNode)
    .addNode("tools", toolExecutorNode)
    .addEdge("__start__", "agent")
    .addConditionalEdges("agent", shouldContinue, {
      tools: "tools",
      end: "__end__",
    })
    .addConditionalEdges("tools", afterTools, {
      agent: "agent",
      end: "__end__",
    });

  const checkpointer = new MemorySaver();
  const app = graph.compile({ checkpointer });

  const initialMessages: BaseMessage[] = [
    new SystemMessage(systemPrompt),
    ...priorMessages,
    new HumanMessage(message),
  ];

  const finalState = await app.invoke(
    { messages: initialMessages, sessionId, userId, systemPrompt },
    { configurable: { thread_id: sessionId } }
  );

  let responseText: string;

  if (finalState.hasPendingConfirmation) {
    const toolMessages = finalState.messages.filter(
      (m: BaseMessage) => m.constructor.name === "ToolMessage"
    );
    const lastToolMsg = toolMessages[toolMessages.length - 1];
    responseText = typeof lastToolMsg?.content === "string"
      ? lastToolMsg.content
      : JSON.stringify(lastToolMsg?.content ?? "");
  } else {
    const lastMessage = finalState.messages[finalState.messages.length - 1];
    responseText =
      typeof lastMessage.content === "string"
        ? lastMessage.content
        : JSON.stringify(lastMessage.content);
  }

  await addMessage(db, sessionId, "assistant", responseText);

  return { response: responseText, toolCalls: toolCallNames };
}
