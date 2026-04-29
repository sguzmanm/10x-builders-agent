import { CallbackHandler } from "@langfuse/langchain";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { RunnableConfig } from "@langchain/core/runnables";
import { NodeSDK } from "@opentelemetry/sdk-node";

interface LangfuseConfigParams {
  runName: string;
  userId: string;
  sessionId: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

function isLangfuseConfigured(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

interface LangfuseRuntimeState {
  sdk?: NodeSDK;
  started?: boolean;
  warnedMissingEnv?: boolean;
}

const LANGFUSE_RUNTIME_STATE = Symbol.for("agents.langfuse.runtime");

function getRuntimeState(): LangfuseRuntimeState {
  const globalWithState = globalThis as typeof globalThis & {
    [LANGFUSE_RUNTIME_STATE]?: LangfuseRuntimeState;
  };

  globalWithState[LANGFUSE_RUNTIME_STATE] ??= {};
  return globalWithState[LANGFUSE_RUNTIME_STATE];
}

function ensureLangfuseTracingStarted(): boolean {
  const state = getRuntimeState();

  if (!isLangfuseConfigured()) {
    if (!state.warnedMissingEnv) {
      console.warn(
        "[langfuse] LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are required to export traces"
      );
      state.warnedMissingEnv = true;
    }
    return false;
  }

  if (state.started) return true;

  state.sdk = new NodeSDK({
    spanProcessors: [
      new LangfuseSpanProcessor({
        exportMode: "immediate",
      }),
    ],
  });
  state.sdk.start();
  state.started = true;

  process.once("beforeExit", () => {
    state.sdk?.shutdown().catch((error) => {
      console.warn("[langfuse] failed to shut down tracing cleanly", error);
    });
  });

  return true;
}

export function createLangfuseConfig({
  runName,
  userId,
  sessionId,
  tags = [],
  metadata = {},
}: LangfuseConfigParams): RunnableConfig {
  const allTags = ["10x-builders-agent", "langgraph", ...tags];
  const traceMetadata = { ...metadata, userId, sessionId };
  const tracingStarted = ensureLangfuseTracingStarted();

  return {
    runName,
    tags: allTags,
    metadata: traceMetadata,
    callbacks: tracingStarted
      ? [
          new CallbackHandler({
            userId,
            sessionId,
            tags: allTags,
            traceMetadata,
          }),
        ]
      : undefined,
  };
}
