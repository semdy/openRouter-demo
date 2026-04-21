import { v4 as uuid } from "uuid";

export type Message = {
  role: "system" | "user" | "assistant";
  content: string;
  messageId: string;
  status?: "streaming" | "interrupted" | "error" | "completed";
  metadata: Record<string, unknown>;
  name?: string;
};

export type ChatSessionOptions = {
  conversationId?: string;
  clientId?: string;
  onReceiveMessage?: (message: Message) => void;
  onReceiveChunk?: (chunk: string, messageId: string) => void;
  onCompletionError?: (error: Error) => void;
  onCompletionDone?: () => void;
  onCompletionFinally?: () => void;
};

export type ConversationListItem = {
  id: string;
  userId: string | null;
  title: string | null;
  summary: string | null;
  updatedAt: string;
  lastMessageAt: string;
  createdAt: string;
  lastMessageRole: "assistant" | "user" | "system" | null;
  lastMessageContent: string | null;
};

export type ConversationListResponse = {
  items: ConversationListItem[];
  nextCursor: string | null;
};

export type ConversationMessageItem = Message & {
  parentMessageId?: string | null;
  conversationId?: string;
  messageIndex: number | null;
  model: string | null;
  createdAt: string;
};

export type ConversationMessagesResponse = {
  conversationId: string;
  items: ConversationMessageItem[];
};

type SSEFrame = {
  event: string;
  data: string;
};

const CHAT_CLIENT_ID_STORAGE_KEY = "chat_client_id";

export function getOrCreateClientId() {
  const cached = window.localStorage
    .getItem(CHAT_CLIENT_ID_STORAGE_KEY)
    ?.trim();

  if (cached) {
    return cached;
  }

  const next = uuid();
  window.localStorage.setItem(CHAT_CLIENT_ID_STORAGE_KEY, next);
  return next;
}

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

export async function fetchConversations(cursor?: string, pageSize = 20) {
  const params = new URLSearchParams();
  params.set("pageSize", String(pageSize));
  if (cursor) {
    params.set("cursor", cursor);
  }

  params.set("clientId", getOrCreateClientId());

  const query = params.toString();
  const res = await fetch(`/api/chat/conversations${query ? `?${query}` : ""}`);
  if (!res.ok) {
    throw new Error(`Failed to fetch conversations: ${res.status}`);
  }

  return (await res.json()) as ConversationListResponse;
}

export async function fetchConversationMessages(conversationId: string) {
  const res = await fetch(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}/messages`,
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch conversation messages: ${res.status}`);
  }

  return (await res.json()) as ConversationMessagesResponse;
}

export async function deleteConversation(conversationId: string) {
  const res = await fetch(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "DELETE",
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to delete conversation: ${res.status}`);
  }

  return (await res.json()) as {
    ok: boolean;
    conversationId: string;
    deletedMessages: number;
  };
}

export async function updateConversationTitle(
  conversationId: string,
  title: string,
) {
  const res = await fetch(
    `/api/chat/conversations/${encodeURIComponent(conversationId)}`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ title }),
    },
  );
  if (!res.ok) {
    throw new Error(`Failed to update conversation title: ${res.status}`);
  }

  return (await res.json()) as ConversationListItem;
}

export class ChatSession {
  controller: AbortController | null = null;
  options: ChatSessionOptions = {} as ChatSessionOptions;
  constructor(options: ChatSessionOptions) {
    if (options) {
      this.options = options;
    }
  }

  async send(userPrompt: string, continuationMessageId?: string) {
    this.abort();

    const continuation = !!continuationMessageId;

    if (!continuation) {
      this.handleReceivedMessage({
        role: "user",
        content: userPrompt,
        messageId: uuid(),
        status: "completed",
        metadata: {
          continuation,
        },
      });
    }

    this.controller = new AbortController();

    const requestBody: {
      prompt: string;
      clientId: string;
      conversationId?: string;
      continuation?: boolean;
      continuationMessageId?: string;
    } = {
      prompt: userPrompt,
      clientId: this.options.clientId ?? getOrCreateClientId(),
      conversationId: this.options.conversationId ?? undefined,
      continuation,
      continuationMessageId,
    };

    const res = await fetch("/api/chat/completions", {
      method: "POST",
      signal: this.controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      throw new Error(`Request failed with status ${res.status}`);
    }

    const assignedConversationId = res.headers.get("X-Conversation-Id")?.trim();

    const reader = res.body?.getReader();

    if (!reader) throw new Error("No reader");

    const decoder = new TextDecoder();

    let streamBuffer = "";

    if (!continuation) {
      this.handleReceivedMessage({
        role: "assistant",
        content: streamBuffer,
        messageId: uuid(),
        status: "streaming",
        metadata: {},
      });
    }

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
            this.handleReceivedChunk(data.content, data.messageId);
          } else if (parsedFrame.event === "error") {
            this.handleReceivedChunk(data.message, data.messageId);
            const error = new Error(data.message);
            (error as Error & { messageId?: string }).messageId =
              data.messageId;
            throw error;
          } else if (parsedFrame.event === "end") {
            this.options.onCompletionDone?.();
          }
        }
      }
    } catch (error) {
      this.options.onCompletionError?.(error as unknown as Error);
    } finally {
      this.controller = null;
      this.options.onCompletionFinally?.();
    }

    return assignedConversationId;
  }

  continue(incompleteContent: string, incompleteMessageId: string) {
    if (!incompleteContent || !incompleteContent.trim()) {
      throw new Error("No incomplete content to continue");
    }
    return this.send(incompleteContent, incompleteMessageId);
  }

  handleReceivedMessage(message: Message) {
    this.options.onReceiveMessage?.(message);
  }

  handleReceivedChunk(content: string, messageId: string) {
    this.options.onReceiveChunk?.(content, messageId);
  }

  abort() {
    this.controller?.abort();
  }
}
