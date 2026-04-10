import { OpenRouter } from "@openrouter/sdk";

const client = new OpenRouter({
  apiKey: "your-openrouter-api-key",
});

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
};

export class ChatSession {
  messages: Message[] = [];
  options: {
    onReceiveMessage?: (message: Message) => void;
    onReceiveChunk?: (chunk: string) => void;
  } = {};

  constructor(options = {}) {
    this.options = options;
  }

  addSystemPrompt(systemPrompt: string) {
    this.messages.push({ role: "system", content: systemPrompt });
  }

  async send(userPrompt: string) {
    this.handleReceivedMessage({ role: "user", content: userPrompt });

    let response = "";

    try {
      const stream = await client.chat.send({
        chatRequest: {
          models: ["openai/gpt-5", "anthropic/claude-opus-4.6-fast"],
          messages: this.messages.slice(-100), // 只保留最近100轮对话消息
          maxCompletionTokens: 50,
          stream: true,
        },
      });

      this.handleReceivedMessage({ role: "assistant", content: response });

      for await (const chunk of stream) {
        if ("error" in chunk) {
          console.error(`Stream error: ${chunk.error?.message}`);
          if (chunk.choices?.[0]?.finishReason === "error") {
            console.log("Stream terminated due to error");
          }
          return;
        }

        const content = chunk.choices?.[0]?.delta?.content;
        if (content) {
          response += content;
          this.options.onReceiveChunk?.(content);
        }
      }

      this.appendContentToAssistantMessage(response);
    } catch (error: any) {
      console.error(`Error: ${error.message ?? "Unknown error"}`);
    }
  }

  getContext() {
    return this.messages;
  }

  handleReceivedMessage(message: Message) {
    this.messages.push(message);
    this.options.onReceiveMessage?.(message);
  }

  appendContentToAssistantMessage(content: string) {
    this.messages[this.messages.length - 1].content = content;
  }
}
