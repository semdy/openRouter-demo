<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import { useRoute, useRouter } from "vue-router";
import type { ParsedNode } from "markstream-vue";
import MarkdownRender, {
  getMarkdown,
  parseMarkdownToStructure,
} from "markstream-vue";
import {
  ChatSession,
  deleteConversation,
  fetchConversationMessages,
  fetchConversations,
  getOrCreateClientId,
  updateConversationTitle,
  type ConversationListItem,
  type ConversationMessageItem,
  type Message,
} from "@/sdk/openrouter";
import { v4 as uuid } from "uuid";
import "markstream-vue/index.css";

type MessageWithNodes = Message & {
  nodes?: ParsedNode[];
};

const route = useRoute();
const router = useRouter();
const md = getMarkdown();

const messagesByConversation = ref<Record<string, MessageWithNodes[]>>({});
const conversations = ref<ConversationListItem[]>([]);
const conversationsLoading = ref(false);
const conversationsError = ref("");
const conversationMessagesError = ref("");
const messageLoading = ref(false);
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const deletingConversationId = ref<string | null>(null);
const editingConversationId = ref<string | null>(null);
const editingTitleValue = ref("");
const editingOriginalTitleValue = ref("");
const savingTitleConversationId = ref<string | null>(null);
const input = ref("");
const loading = ref(false);
const draftConversationId = ref(uuid());
const clientId = getOrCreateClientId();

const routeConversationId = computed(() => {
  const raw = route.params.conversationId;
  if (typeof raw !== "string") {
    return null;
  }

  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
});

const activeConversationId = computed(() => {
  return routeConversationId.value ?? draftConversationId.value;
});

let chatSession: ChatSession | null = null;
let conversationEventSource: EventSource | null = null;

const currentMessages = computed(() => {
  return messagesByConversation.value[activeConversationId.value] ?? [];
});

const activeConversation = computed(() => {
  return conversations.value.find(
    (conversation) => conversation.id === activeConversationId.value,
  );
});

function ensureConversationMessages(conversationId: string) {
  if (!messagesByConversation.value[conversationId]) {
    messagesByConversation.value[conversationId] = [];
  }

  return messagesByConversation.value[conversationId];
}

function toMessageWithNodes(
  message: ConversationMessageItem,
): MessageWithNodes {
  const normalized: MessageWithNodes = {
    role: message.role,
    content: message.content,
    messageId: message.messageId,
    status: message.status,
    metadata: message.metadata ?? {},
  };

  if (normalized.role === "assistant") {
    normalized.nodes = parseMarkdownToStructure(normalized.content, md);
  }

  return normalized;
}

function mergeContinuedMessagesIfNeeded(
  messages: ConversationMessageItem[],
): ConversationMessageItem[] {
  const result: ConversationMessageItem[] = [];
  const messagesById = new Map(
    messages.map((message) => [message.messageId, message]),
  );
  const childrenMap = new Map<string, ConversationMessageItem[]>();

  for (const msg of messages) {
    if (msg.parentMessageId) {
      if (!childrenMap.has(msg.parentMessageId)) {
        childrenMap.set(msg.parentMessageId, []);
      }
      childrenMap.get(msg.parentMessageId)!.push(msg);
    }
  }

  const compareMessages = (
    left: ConversationMessageItem,
    right: ConversationMessageItem,
  ) => {
    const leftIndex = left.messageIndex ?? Number.MAX_SAFE_INTEGER;
    const rightIndex = right.messageIndex ?? Number.MAX_SAFE_INTEGER;
    if (leftIndex !== rightIndex) {
      return leftIndex - rightIndex;
    }

    return (
      new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime()
    );
  };

  for (const msg of messages) {
    if (msg.parentMessageId && messagesById.has(msg.parentMessageId)) {
      continue;
    }

    if (msg.role !== "assistant") {
      result.push(msg);
      continue;
    }

    const children = childrenMap.get(msg.messageId);
    if (!children || children.length === 0) {
      result.push(msg);
      continue;
    }

    let mergedContent = msg.content;
    let tailMessage = msg;
    let currentMessage = msg;

    while (true) {
      const nextChildren = [
        ...(childrenMap.get(currentMessage.messageId) ?? []),
      ].sort(compareMessages);
      const nextMessage = nextChildren.at(-1);
      if (!nextMessage) {
        break;
      }
      mergedContent += nextMessage.content;
      tailMessage = nextMessage;
      currentMessage = nextMessage;
    }

    const merged: ConversationMessageItem = {
      ...tailMessage,
      content: mergedContent,
      metadata: {
        ...(msg.metadata ?? {}),
        ...(tailMessage.metadata ?? {}),
      },
    };

    result.push(merged);
  }

  return result;
}

function migrateConversationMessages(
  fromConversationId: string,
  toConversationId: string,
) {
  if (fromConversationId === toConversationId) {
    return;
  }

  const fromMessages = messagesByConversation.value[fromConversationId];
  if (!fromMessages) {
    return;
  }

  messagesByConversation.value[toConversationId] =
    messagesByConversation.value[toConversationId] ?? fromMessages;
  delete messagesByConversation.value[fromConversationId];
}

function getLastMessage(conversationId: string) {
  const conversationMessages = ensureConversationMessages(conversationId);
  const lastMsg = conversationMessages[conversationMessages.length - 1];

  return lastMsg;
}

function createChatSession(
  conversationId?: string,
  draftId = draftConversationId.value,
) {
  return new ChatSession({
    conversationId,
    clientId,
    onReceiveMessage(message: Message) {
      const conversationMessages = ensureConversationMessages(draftId);
      conversationMessages.push(message);
      loading.value = true;
    },
    onReceiveChunk(chunk: string, messageId: string) {
      const lastAssistantMsg = getLastMessage(draftId);
      if (!lastAssistantMsg) return;
      if (!lastAssistantMsg.content) {
        lastAssistantMsg.messageId = messageId;
      }
      lastAssistantMsg.content += chunk;
      lastAssistantMsg.status = "streaming";
      lastAssistantMsg.nodes = parseMarkdownToStructure(
        lastAssistantMsg.content,
        md,
      );
    },
    onCompletionError(error) {
      console.error(error);

      const lastMsg = getLastMessage(draftId);
      if (!lastMsg) return;

      const isAbortError = error.name === "AbortError";

      if (lastMsg.role === "assistant") {
        if (lastMsg.content?.trim() === "") {
          messagesByConversation.value[activeConversationId.value].pop();
        } else {
          lastMsg.status = isAbortError ? "interrupted" : "error";
        }
      }

      if (!isAbortError) {
        conversationMessagesError.value = error.message;
      }
    },
    onCompletionDone() {
      const lastAssistantMsg = getLastMessage(draftId);
      if (!lastAssistantMsg) return;
      lastAssistantMsg.status = "completed";
      updateConversationSummary(draftId, lastAssistantMsg.content);
    },
    onCompletionFinally() {
      loading.value = false;
    },
  });
}

function resetChatSession(draftId: string) {
  chatSession?.abort();
  chatSession = createChatSession(undefined, draftId);
  loading.value = false;
}

function previewConversation(conversation: ConversationListItem) {
  return conversation.title || conversation.lastMessageContent || "新聊天";
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function upsertConversation(
  conversation: ConversationListItem,
  moveToTop = false,
) {
  const existingIndex = conversations.value.findIndex(
    (item) => item.id === conversation.id,
  );

  if (existingIndex === -1) {
    conversations.value = [conversation, ...conversations.value];
    return;
  }

  const existingConversation = conversations.value[existingIndex];
  const updated = [...conversations.value];
  updated.splice(existingIndex, 1);
  const merged = {
    ...existingConversation,
    ...conversation,
  };

  if (moveToTop) {
    updated.unshift(merged);
  } else {
    updated.splice(existingIndex, 0, merged);
  }

  conversations.value = updated;
}

function startConversationStream() {
  conversationEventSource?.close();
  conversationEventSource = new EventSource(
    `/api/chat/conversations/stream?clientId=${encodeURIComponent(clientId)}`,
  );

  conversationEventSource.addEventListener("conversation_updated", (event) => {
    const messageEvent = event as MessageEvent<string>;
    const data = JSON.parse(messageEvent.data) as ConversationListItem;
    upsertConversation(data, true);
  });

  conversationEventSource.onerror = () => {
    conversationEventSource?.close();
    conversationEventSource = null;
    window.setTimeout(() => {
      startConversationStream();
    }, 2000);
  };
}

async function loadConversations(loadMore = false) {
  if (loadMore) {
    if (!nextCursor.value || loadingMore.value) return;
    loadingMore.value = true;
  } else {
    conversationsLoading.value = true;
    conversationsError.value = "";
  }

  try {
    const result = await fetchConversations(
      loadMore ? (nextCursor.value ?? undefined) : undefined,
    );
    nextCursor.value = result.nextCursor;

    if (loadMore) {
      const existingIds = new Set(conversations.value.map((item) => item.id));
      conversations.value = [
        ...conversations.value,
        ...result.items.filter((item) => !existingIds.has(item.id)),
      ];
    } else {
      conversations.value = result.items;
    }
  } catch (error) {
    conversationsError.value =
      error instanceof Error ? error.message : "聊天记录加载失败";
  } finally {
    conversationsLoading.value = false;
    loadingMore.value = false;
  }
}

function hoistConversationById(conversationId: string) {
  const index = conversations.value.findIndex(
    (conversation) => conversation.id === conversationId,
  );
  if (index > 0) {
    const conversation = conversations.value[index];
    conversations.value.splice(index, 1);
    conversations.value.unshift(conversation);
  }
}

async function loadConversationMessages(conversationId: string) {
  messageLoading.value = true;
  conversationMessagesError.value = "";
  try {
    const result = await fetchConversationMessages(conversationId);
    if (result.items.length === 0) {
      return;
    }
    messagesByConversation.value[conversationId] =
      mergeContinuedMessagesIfNeeded(result.items).map(toMessageWithNodes);
  } catch (error) {
    conversationMessagesError.value =
      error instanceof Error ? error.message : "聊天消息加载失败";
  } finally {
    messageLoading.value = false;
  }
}

function startNewConversation() {
  input.value = "";
  conversationMessagesError.value = "";
  draftConversationId.value = uuid();
  if (routeConversationId.value !== null) {
    router.push("/");
    return;
  }
  ensureConversationMessages(draftConversationId.value);
  resetChatSession(draftConversationId.value);
}

function selectConversation(conversationId: string) {
  if (conversationId === routeConversationId.value) return;
  router.push(`/${conversationId}`);
}

function updateConversationSummary(conversationId: string, summary: string) {
  const conversation = conversations.value.find((c) => c.id === conversationId);
  if (!conversation) return;

  conversation.lastMessageContent = summary;
}

async function removeConversation(conversationId: string) {
  if (!confirm("确定要删除该聊天吗？")) {
    return;
  }

  if (deletingConversationId.value) {
    return;
  }

  deletingConversationId.value = conversationId;
  conversationsError.value = "";
  try {
    await deleteConversation(conversationId);
    conversations.value = conversations.value.filter(
      (conversation) => conversation.id !== conversationId,
    );
    delete messagesByConversation.value[conversationId];

    if (routeConversationId.value === conversationId) {
      draftConversationId.value = uuid();
      router.push("/");
    }
  } catch (error) {
    conversationsError.value =
      error instanceof Error ? error.message : "聊天删除失败";
  } finally {
    deletingConversationId.value = null;
  }
}

function startEditConversationTitle(conversation: ConversationListItem) {
  editingConversationId.value = conversation.id;
  editingOriginalTitleValue.value = previewConversation(conversation);
  editingTitleValue.value = editingOriginalTitleValue.value;
  nextTick(() => {
    const inputElement = document.getElementById(
      `conversation-title-input-${conversation.id}`,
    ) as HTMLInputElement | null;
    inputElement?.focus();
    inputElement?.select();
  });
}

function cancelEditConversationTitle() {
  editingConversationId.value = null;
  editingTitleValue.value = "";
  editingOriginalTitleValue.value = "";
}

async function submitEditConversationTitle(conversationId: string) {
  if (savingTitleConversationId.value) {
    return;
  }

  const conversation = conversations.value.find(
    (item) => item.id === conversationId,
  );
  if (!conversation) {
    cancelEditConversationTitle();
    return;
  }

  const nextTitle = editingTitleValue.value.trim();
  if (!nextTitle) {
    cancelEditConversationTitle();
    return;
  }

  if (nextTitle === editingOriginalTitleValue.value) {
    cancelEditConversationTitle();
    return;
  }

  savingTitleConversationId.value = conversationId;
  conversationsError.value = "";
  try {
    const result = await updateConversationTitle(conversationId, nextTitle);
    upsertConversation(result, false);
    cancelEditConversationTitle();
  } catch (error) {
    conversationsError.value =
      error instanceof Error ? error.message : "聊天标题更新失败";
  } finally {
    savingTitleConversationId.value = null;
  }
}

async function send() {
  // stop generation
  if (loading.value) {
    chatSession?.abort();
    loading.value = false;
    return;
  }

  const msg = input.value.trim();
  if (!msg || loading.value) return;

  const currentRouteConversationId = routeConversationId.value;
  const currentDraftConversationId = draftConversationId.value;

  input.value = "";
  ensureConversationMessages(activeConversationId.value);
  const persistedConversationId = await chatSession?.send(msg);
  if (!currentRouteConversationId && persistedConversationId) {
    migrateConversationMessages(
      currentDraftConversationId,
      persistedConversationId,
    );
    router.push(`/${persistedConversationId}`);
  }
  if (currentRouteConversationId) {
    hoistConversationById(currentRouteConversationId);
  }
}

async function continueSend(incompleteMessage: Message) {
  if (loading.value) return;
  const lastAssistantMsg = getLastMessage(activeConversationId.value);
  if (lastAssistantMsg) {
    lastAssistantMsg.status = "streaming";
  }
  await chatSession?.continue(
    incompleteMessage.content,
    incompleteMessage.messageId,
  );
}

watch(
  activeConversationId,
  async (conversationId) => {
    ensureConversationMessages(conversationId);
    const draftId = routeConversationId.value
      ? conversationId
      : draftConversationId.value;
    const persistedConversationId = routeConversationId.value ?? undefined;
    chatSession?.abort();
    chatSession = createChatSession(persistedConversationId, draftId);
    loading.value = false;
    if (routeConversationId.value) {
      await loadConversationMessages(conversationId);
    }
  },
  { immediate: true },
);

await loadConversations();

onMounted(() => {
  startConversationStream();
});

onBeforeUnmount(() => {
  chatSession?.abort();
  conversationEventSource?.close();
});
</script>

<template>
  <div class="chat-shell">
    <aside class="conversation-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">聊天</p>
          <h2>最近聊天</h2>
        </div>
        <button
          class="new-chat-button"
          type="button"
          @click="startNewConversation"
        >
          新聊天
        </button>
      </div>

      <p v-if="conversationsError" class="panel-state error">
        {{ conversationsError }}
      </p>
      <p v-else-if="conversationsLoading" class="panel-state loading">
        聊天记录加载中...
      </p>
      <div class="conversation-list">
        <div
          v-for="conversation in conversations"
          :key="conversation.id"
          class="conversation-item-wrapper"
          :class="{ active: conversation.id === activeConversationId }"
        >
          <button
            type="button"
            class="conversation-item"
            :class="{ active: conversation.id === activeConversationId }"
            @click="selectConversation(conversation.id)"
          >
            <div class="conversation-item-header">
              <span
                v-if="editingConversationId !== conversation.id"
                class="conversation-title"
                @dblclick.stop.prevent="
                  startEditConversationTitle(conversation)
                "
              >
                {{ previewConversation(conversation) }}
              </span>
              <input
                v-else
                :id="`conversation-title-input-${conversation.id}`"
                v-model="editingTitleValue"
                class="conversation-title-input"
                type="text"
                :disabled="savingTitleConversationId === conversation.id"
                @click.stop
                @keydown.enter.prevent="
                  submitEditConversationTitle(conversation.id)
                "
                @keydown.esc.prevent="cancelEditConversationTitle"
                @blur="submitEditConversationTitle(conversation.id)"
              />
              <span class="conversation-time">
                {{ formatTime(conversation.lastMessageAt) }}
              </span>
            </div>
            <p class="conversation-preview">
              {{ conversation.lastMessageContent || "暂无消息内容" }}
            </p>
          </button>
          <button
            type="button"
            class="conversation-delete-button"
            :disabled="deletingConversationId === conversation.id"
            @click.stop="removeConversation(conversation.id)"
          >
            X
          </button>
        </div>

        <button
          v-if="nextCursor"
          type="button"
          class="load-more-button"
          :disabled="loadingMore"
          @click="loadConversations(true)"
        >
          {{ loadingMore ? "加载中..." : "加载更多" }}
        </button>
      </div>
    </aside>

    <section class="chat-panel">
      <div class="chat-header">
        <div>
          <p class="eyebrow">当前聊天</p>
          <h1>{{ activeConversation?.title || "新聊天" }}</h1>
        </div>
      </div>

      <div class="chat-messages">
        <p v-if="conversationMessagesError" class="panel-state error">
          {{ conversationMessagesError }}
        </p>
        <div v-if="messageLoading" class="panel-state loading">加载中...</div>
        <div v-if="currentMessages.length === 0" class="empty-state">
          <h3>开始新聊天</h3>
          <p>提问后，聊天列表会自动更新。</p>
        </div>

        <div v-else class="chat-render">
          <template v-for="message in currentMessages" :key="message.messageId">
            <div v-if="message.role === 'user'" class="chat-message user">
              <div class="chat-content">{{ message.content }}</div>
            </div>

            <div v-else class="chat-message assistant">
              <MarkdownRender
                :nodes="message.nodes"
                class="chat-message-render"
                is-dark
              />
              <button
                v-if="message.status === 'error' && message.content"
                type="button"
                title="继续生成"
                @click="continueSend(message)"
                class="continue-btn"
              >
                <svg viewBox="0 0 1024 1024" width="20" height="20">
                  <path
                    d="M512 316.928v111.835429l182.857143-154.038858L512 124.342857V219.428571a292.571429 292.571429 0 1 0 292.571429 292.571429 48.786286 48.786286 0 1 0-97.499429 0A195.072 195.072 0 1 1 512 316.928zM512 1024A512 512 0 1 1 512 0a512 512 0 0 1 0 1024z"
                    fill="#FF5E5B"
                  ></path>
                </svg>
              </button>
            </div>
          </template>
        </div>
      </div>

      <div class="chat-input">
        <form @submit.prevent="send">
          <input v-model="input" type="text" placeholder="有问题，尽管问" />
          <button type="submit" :disabled="!input && !loading">
            {{ loading ? "停止" : "发送" }}
          </button>
        </form>
      </div>
    </section>
  </div>
</template>

<style>
.chat-shell {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  height: 100%;
  background:
    radial-gradient(circle at top left, rgba(19, 78, 74, 0.2), transparent 32%),
    linear-gradient(180deg, #f7f5ef 0%, #f1ede5 100%);
  color: #1b1f1e;
}

.conversation-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 16px 0;
  border-right: 1px solid rgba(35, 52, 53, 0.12);
  background: rgba(255, 252, 246, 0.84);
  backdrop-filter: blur(16px);
  overflow: hidden;
}

.panel-header,
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding-left: 16px;
  padding-right: 16px;
}

.eyebrow {
  margin: 0 0 6px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #52706f;
}

.panel-header h2,
.chat-header h1 {
  margin: 0;
  font-size: 22px;
  line-height: 1.1;
}

.conversation-panel .panel-state {
  margin-left: 16px;
  margin-right: 16px;
}

.new-chat-button,
.load-more-button,
.chat-input button {
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, #134e4a, #0f766e);
  color: #f7f5ef;
  cursor: pointer;
  font-weight: bold;
}

.new-chat-button,
.load-more-button {
  padding: 10px 14px;
}

.panel-state {
  margin: 0;
  padding: 12px 14px;
  border-radius: 16px;
  background: rgba(15, 118, 110, 0.08);
  color: #245754;
}

.panel-state.error {
  position: sticky;
  top: 0;
  background: #f1e2d9;
  color: #9a3412;
  margin-bottom: 10px;
  z-index: 1000;
}

.chat-messages .panel-state.loading {
  position: absolute;
  left: 28px;
  right: 28px;
  top: 0;
}

.chat-message-render {
  --ms-text-body: 0.9375rem;
  --ms-text-h1: 2rem;
  --ms-text-h2: 1.25rem;
}

.conversation-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  padding-left: 16px;
  padding-right: 16px;
  min-height: 0;
  overflow-y: auto;
}

.conversation-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
  padding: 14px;
  border: 1px solid rgba(35, 52, 53, 0.08);
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.76);
  text-align: left;
  cursor: pointer;
  transition:
    transform 160ms ease,
    border-color 160ms ease,
    box-shadow 160ms ease;
}

.conversation-item:hover,
.conversation-item.active {
  border-color: rgba(15, 118, 110, 0.35);
  box-shadow: 0 14px 30px rgba(15, 118, 110, 0.08);
}

.conversation-item-wrapper {
  position: relative;
}

.conversation-delete-button {
  position: absolute;
  top: 8px;
  right: 8px;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 999px;
  background: rgba(185, 28, 28, 0.12);
  color: #991b1b;
  font-size: 12px;
  line-height: 1;
  opacity: 0;
  pointer-events: none;
  cursor: pointer;
  transition:
    opacity 120ms ease,
    transform 120ms ease;
}

.conversation-item-wrapper:hover .conversation-delete-button {
  opacity: 1;
  pointer-events: auto;
}

.conversation-delete-button:hover {
  transform: scale(1.05);
  background: rgba(185, 28, 28, 0.2);
}

.conversation-item-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.conversation-title {
  font-weight: 700;
  color: #123533;
  cursor: text;
}

.conversation-title-input {
  width: 100%;
  min-width: 0;
  font-weight: 700;
  color: #123533;
  border: 1px solid rgba(15, 118, 110, 0.35);
  border-radius: 8px;
  padding: 4px 8px;
  background: rgba(255, 255, 255, 0.96);
}

.conversation-time {
  flex-shrink: 0;
  font-size: 12px;
  color: #6d7f7d;
}

.conversation-preview {
  margin: 0;
  color: #5b6766;
  font-size: 14px;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chat-panel {
  display: flex;
  flex-direction: column;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}

.chat-header {
  padding: 24px 28px 14px;
}

.chat-messages {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 28px 24px;
}

.chat-render {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.empty-state {
  display: grid;
  place-items: center;
  min-height: 100%;
  padding: 40px 24px;
  text-align: center;
  color: #566564;
}

.empty-state h3 {
  margin: 0 0 8px;
  font-size: 28px;
  color: #173d3a;
}

.empty-state p {
  margin: 0;
  max-width: 420px;
  line-height: 1.6;
}

.chat-message.user {
  display: flex;
  justify-content: flex-end;
}

.chat-message.user .chat-content {
  max-width: min(75%, 720px);
  padding: 14px 18px;
  border-radius: 22px 22px 8px 22px;
  background: linear-gradient(135deg, #134e4a, #0f766e);
  color: #f8faf9;
  font-size: var(--ms-text-body, 0.9375rem);
  box-shadow: 0 16px 30px rgba(15, 118, 110, 0.16);
}

.chat-message.assistant {
  position: relative;
  max-width: min(85%, 780px);
  padding: 18px 20px;
  border-radius: 24px 24px 24px 10px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 16px 32px rgba(37, 66, 63, 0.08);
}

.continue-btn {
  position: absolute;
  right: -12px;
  top: 12px;
  padding: 0;
  transform: translateX(100%);
  cursor: pointer;
  background: none;
  border: none;
}

.chat-input {
  padding: 18px 28px 18px;
}

.chat-input form {
  display: flex;
  gap: 12px;
  padding: 12px;
  border: 1px solid rgba(35, 52, 53, 0.1);
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 18px 34px rgba(34, 64, 60, 0.08);
}

.chat-input input {
  flex: 1;
  min-width: 0;
  padding: 10px 12px;
  border: none;
  outline: none;
  background: transparent;
  color: #123533;
  font-size: 15px;
}

.chat-input button {
  padding: 0 20px;
}

.chat-input button:disabled,
.load-more-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@media (max-width: 960px) {
  .chat-shell {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }

  .conversation-panel {
    border-right: none;
    border-bottom: 1px solid rgba(35, 52, 53, 0.12);
  }

  .conversation-list {
    max-height: 240px;
  }

  .chat-header,
  .chat-messages,
  .chat-input {
    padding-left: 18px;
    padding-right: 18px;
  }
}
</style>
