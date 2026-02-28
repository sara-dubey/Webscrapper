import { setLlmConfiguredMode } from "../observability/metrics.js";

function lower(value) {
  return String(value || "").trim().toLowerCase();
}

function cleanApiKind(value, fallback = "openai") {
  const kind = lower(value);
  if (kind === "openai" || kind === "anthropic" || kind === "gemini") return kind;
  return fallback;
}

function resolveLlmMode() {
  const mode = lower(process.env.LLM_MODE);
  if (mode === "local" || mode === "api") return mode;
  return "";
}

function modeFromProvider(provider) {
  const p = lower(provider);
  if (p === "ollama") return "local";
  if (p === "none") return "none";
  return "api";
}

function resolveApiChatKind() {
  return cleanApiKind(
    process.env.API_LLM_CHAT_KIND || process.env.RAG_API_CHAT_KIND || process.env.API_LLM_KIND,
    "openai"
  );
}

function resolveApiEmbedKind() {
  return cleanApiKind(
    process.env.API_LLM_EMBED_KIND || process.env.RAG_API_EMBED_KIND || process.env.API_LLM_KIND,
    "openai"
  );
}

function resolveEmbeddingProvider() {
  const mode = resolveLlmMode();
  if (mode === "local") return "ollama";
  if (mode === "api") return "api";
  const explicit = lower(process.env.RAG_EMBEDDING_PROVIDER);
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OLLAMA_EMBED_MODEL || process.env.RAG_OLLAMA_EMBED_MODEL) return "ollama";
  return "none";
}

function resolveChatProvider() {
  const mode = resolveLlmMode();
  if (mode === "local") return "ollama";
  if (mode === "api") return "api";
  const explicit = lower(process.env.RAG_CHAT_PROVIDER);
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return "openai";
  if (process.env.OLLAMA_CHAT_MODEL || process.env.RAG_OLLAMA_CHAT_MODEL) return "ollama";
  return "none";
}

function currentConfiguredMode() {
  const explicit = resolveLlmMode();
  if (explicit) return explicit;
  return modeFromProvider(resolveChatProvider());
}

export function getResolvedLlmConfig() {
  const embedProvider = resolveEmbeddingProvider();
  const chatProvider = resolveChatProvider();
  const mode = currentConfiguredMode();
  setLlmConfiguredMode(mode);
  return {
    mode,
    embedding: {
      provider: embedProvider,
      mode: modeFromProvider(embedProvider),
    },
    chat: {
      provider: chatProvider,
      mode: modeFromProvider(chatProvider),
    },
    api: {
      chatKind: resolveApiChatKind(),
      embedKind: resolveApiEmbedKind(),
    },
  };
}

