import { encoding_for_model } from "tiktoken";

const enc = encoding_for_model("gpt-5.4");

export function estimateTokens(text) {
  return enc.encode(text).length;
}
