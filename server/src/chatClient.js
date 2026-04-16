import { OpenRouter } from "@openrouter/sdk";

export const chatClient = new OpenRouter({
  apiKey: process.env.OPENROUTER_API_KEY,
});
