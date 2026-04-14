import { encoding_for_model } from "tiktoken";
import { MAX_TURNS } from "./config.js";

const enc = encoding_for_model("gpt-4o");

export function estimateTokens(text) {
  return enc.encode(text).length;
}

// ===== Token estimation (simple version, replace with tiktoken in prod) =====
// function estimateTokens(text) {
//   // rough: 1 token ≈ 4 chars (English), adjust if needed
//   return Math.ceil(text.length / 4);
// }

export function countMessageTokens(messages) {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content || ""), 0);
}

export function trimMessagesByTokens(messages, maxTokens = 8000) {
  const system = messages.find((m) => m.role === "system");
  let rest = messages.filter((m) => m.role !== "system");

  let result = system ? [system] : [];

  // keep from latest backwards
  for (let i = rest.length - 1; i >= 0; i--) {
    const msg = rest[i];
    result.splice(system ? 1 : 0, 0, msg);

    if (countMessageTokens(result) > maxTokens) {
      result.splice(system ? 1 : 0, 1);
      break;
    }
  }

  return result;
}

export function trimMessagesByTurns(messages) {
  const system = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  const trimmed = rest.slice(-MAX_TURNS * 2); // user + assistant

  return system ? [system, ...trimmed] : trimmed;
}
