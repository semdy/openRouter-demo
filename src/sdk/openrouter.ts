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

type SSEFrame = {
  event: string;
  data: string;
};

function parseSSEFrame(frame: string): SSEFrame | null {
  const lines = frame.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) return null;

  return {
    event,
    data: dataLines.join("\n"),
  };
}

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

    const res = await fetch("/api/conversation", {
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

    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }

    const reader = res.body?.getReader();

    if (!reader) throw new Error("No reader");

    const decoder = new TextDecoder();

    let streamBuffer = "";

    this.handleReceivedMessage({ role: "assistant", content: streamBuffer });

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        streamBuffer += decoder.decode(value, { stream: true });

        const frames = streamBuffer.split(/\r?\n\r?\n/);
        streamBuffer = frames.pop() ?? "";

        for (const frame of frames) {
          if (!frame.trim()) continue;

          const parsedFrame = parseSSEFrame(frame);
          if (!parsedFrame) continue;

          const data = JSON.parse(parsedFrame.data);

          if (parsedFrame.event === "delta") {
            this.handleReceivedChunk(data.content);
          } else if (parsedFrame.event === "error") {
            throw new Error(data.message);
          } else if (parsedFrame.event === "end") {
            this.options.onCompletionDone?.();
            return;
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
