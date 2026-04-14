export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
  name?: string;
};

export type ChatSessionOptions = {
  conversationId: string;
  onReceiveMessage?: (message: Message) => void;
  onReceiveChunk?: (chunk: string) => void;
  onCompletionError?: (error: Error) => void;
  onCompletionDone?: () => void;
  onCompletionFinally?: () => void;
};

export class ChatSession {
  controller: AbortController | null = null;
  options: ChatSessionOptions = {} as ChatSessionOptions;
  constructor(options: ChatSessionOptions) {
    if (options) {
      this.options = options;
    }
    if (!this.options.conversationId) {
      throw new Error("No conversationId provided");
    }
  }

  async send(userPrompt: string) {
    if (this.controller) this.controller.abort();

    this.handleReceivedMessage({ role: "user", content: userPrompt });

    this.controller = new AbortController();

    const res = await fetch("/api/chat", {
      method: "POST",
      signal: this.controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: userPrompt,
        conversationId: this.options.conversationId,
      }),
    });

    const reader = res.body?.getReader();

    if (!reader) throw new Error("No reader");

    const decoder = new TextDecoder();

    let buffer = "";

    this.handleReceivedMessage({ role: "assistant", content: buffer });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;

          const data = JSON.parse(line);

          if (data.type === "content") {
            this.handleReceivedChunk(data.content);
          } else if (data.type === "error") {
            throw new Error(data.message);
          } else if (data.type === "end") {
            console.log("done");
          }
        }
      }
      this.options.onCompletionDone?.();
    } catch (error) {
      console.error(error);
      this.options.onCompletionError?.(error as unknown as Error);
    } finally {
      this.controller = null;
      this.options.onCompletionFinally?.();
    }
  }

  handleReceivedMessage(message: Message) {
    this.options.onReceiveMessage?.(message);
  }

  handleReceivedChunk(content: string) {
    this.options.onReceiveChunk?.(content);
  }

  abort() {
    this.controller?.abort();
  }
}
