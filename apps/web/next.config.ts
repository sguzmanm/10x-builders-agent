import type { NextConfig } from "next";

const extraAllowedDevOrigins =
  process.env.NEXT_ALLOWED_DEV_ORIGINS?.split(",")
    .map((h) => h.trim())
    .filter(Boolean) ?? [];

const allowedDevOrigins = ["*.ngrok-free.app","*.ngrok-free.dev", ...extraAllowedDevOrigins];

const nextConfig: NextConfig = {
  transpilePackages: ["@agents/agent", "@agents/db", "@agents/types"],
  serverExternalPackages: [
    "@langchain/core",
    "@langchain/langgraph",
    "@langchain/openai",
    "@langfuse/core",
    "@langfuse/langchain",
    "@langfuse/otel",
    "@langfuse/tracing",
    "@opentelemetry/api",
    "@opentelemetry/sdk-node",
  ],
  allowedDevOrigins,
};

export default nextConfig;
