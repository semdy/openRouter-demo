<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { ParsedNode } from "markstream-vue";
import MarkdownRender, {
  getMarkdown,
  parseMarkdownToStructure,
} from "markstream-vue";
import {
  ChatSession,
  fetchConversations,
  type ConversationListItem,
  type Message,
} from "@/sdk/openrouter";
import { v4 as uuid } from "uuid";
import "markstream-vue/index.css";

type MessageWithNodes = Message & {
  nodes?: ParsedNode[];
};

const md = getMarkdown();
const messagesByConversation = ref<Record<string, MessageWithNodes[]>>({});
const conversations = ref<ConversationListItem[]>([]);
const conversationsLoading = ref(false);
const conversationsError = ref("");
const nextCursor = ref<string | null>(null);
const loadingMore = ref(false);
const input = ref("");
const loading = ref(false);
const activeConversationId = ref<string>(uuid());

let chatSession = createChatSession(activeConversationId.value);
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

function createChatSession(conversationId: string) {
  return new ChatSession({
    conversationId,
    onReceiveMessage(message: Message) {
      const conversationMessages = ensureConversationMessages(conversationId);
      conversationMessages.push(message);
      loading.value = true;
    },
    onReceiveChunk(chunk: string) {
      const conversationMessages = ensureConversationMessages(conversationId);
      const lastAssistantMsg =
        conversationMessages[conversationMessages.length - 1];
      if (!lastAssistantMsg) return;

      lastAssistantMsg.content += chunk;
      lastAssistantMsg.nodes = parseMarkdownToStructure(
        lastAssistantMsg.content,
        md,
      );
    },
    onCompletionError(error) {
      console.error(error);
    },
    onCompletionFinally() {
      loading.value = false;
    },
  });
}

function previewConversation(conversation: ConversationListItem) {
  return (
    conversation.title || conversation.lastMessageContent || "New conversation"
  );
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
  conversationEventSource = new EventSource("/api/conversations/stream");

  conversationEventSource.addEventListener("conversation_updated", (event) => {
    const messageEvent = event as MessageEvent<string>;
    const data = JSON.parse(messageEvent.data) as {
      conversation: ConversationListItem;
    };

    upsertConversation(data.conversation, true);
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
      error instanceof Error ? error.message : "Failed to load conversations";
  } finally {
    conversationsLoading.value = false;
    loadingMore.value = false;
  }
}

function startNewConversation() {
  chatSession.abort();
  activeConversationId.value = uuid();
  chatSession = createChatSession(activeConversationId.value);
  ensureConversationMessages(activeConversationId.value);
  input.value = "";
  loading.value = false;
}

function selectConversation(conversationId: string) {
  if (conversationId === activeConversationId.value) return;

  chatSession.abort();
  activeConversationId.value = conversationId;
  chatSession = createChatSession(conversationId);
  ensureConversationMessages(conversationId);
  loading.value = false;
}

async function send() {
  const msg = input.value.trim();
  if (!msg || loading.value) return;

  input.value = "";
  ensureConversationMessages(activeConversationId.value);
  await chatSession.send(msg);
}

await loadConversations();
ensureConversationMessages(activeConversationId.value);

onMounted(() => {
  startConversationStream();
});

onBeforeUnmount(() => {
  chatSession.abort();
  conversationEventSource?.close();
});
</script>

<template>
  <div class="chat-shell">
    <aside class="conversation-panel">
      <div class="panel-header">
        <div>
          <p class="eyebrow">Conversations</p>
          <h2>Recent chats</h2>
        </div>
        <button
          class="new-chat-button"
          type="button"
          @click="startNewConversation"
        >
          New Chat
        </button>
      </div>

      <p v-if="conversationsError" class="panel-state error">
        {{ conversationsError }}
      </p>
      <p v-else-if="conversationsLoading" class="panel-state">
        Loading conversations...
      </p>
      <div v-else class="conversation-list">
        <button
          v-for="conversation in conversations"
          :key="conversation.id"
          type="button"
          class="conversation-item"
          :class="{ active: conversation.id === activeConversationId }"
          @click="selectConversation(conversation.id)"
        >
          <div class="conversation-item-header">
            <span class="conversation-title">
              {{ previewConversation(conversation) }}
            </span>
            <span class="conversation-time">
              {{ formatTime(conversation.lastMessageAt) }}
            </span>
          </div>
          <p class="conversation-preview">
            {{ conversation.lastMessageContent || "No messages yet" }}
          </p>
        </button>

        <button
          v-if="nextCursor"
          type="button"
          class="load-more-button"
          :disabled="loadingMore"
          @click="loadConversations(true)"
        >
          {{ loadingMore ? "Loading..." : "Load More" }}
        </button>
      </div>
    </aside>

    <section class="chat-panel">
      <div class="chat-header">
        <div>
          <p class="eyebrow">Active conversation</p>
          <h1>{{ activeConversation?.title || "New conversation" }}</h1>
        </div>
      </div>

      <div class="chat-messages">
        <div v-if="currentMessages.length === 0" class="empty-state">
          <h3>Start a new conversation</h3>
          <p>Ask a question and the chat list will update automatically.</p>
        </div>

        <div v-else class="chat-render">
          <template v-for="message in currentMessages" :key="message.messageId">
            <div v-if="message.role === 'user'" class="chat-message user">
              <div class="chat-content">{{ message.content }}</div>
            </div>
            <MarkdownRender
              v-else
              class="chat-message assistant"
              :nodes="message.nodes"
              is-dark
            />
          </template>
        </div>
      </div>

      <div class="chat-input">
        <form @submit.prevent="send">
          <input v-model="input" type="text" placeholder="Ask anything..." />
          <button type="submit" :disabled="loading">
            {{ loading ? "Thinking..." : "Send" }}
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
  padding: 24px 18px;
  border-right: 1px solid rgba(35, 52, 53, 0.12);
  background: rgba(255, 252, 246, 0.84);
  backdrop-filter: blur(16px);
}

.panel-header,
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
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

.new-chat-button,
.load-more-button,
.chat-input button {
  border: none;
  border-radius: 999px;
  background: linear-gradient(135deg, #134e4a, #0f766e);
  color: #f7f5ef;
  cursor: pointer;
  font-weight: 700;
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
  background: rgba(191, 54, 12, 0.1);
  color: #9a3412;
}

.conversation-list {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow-y: auto;
}

.conversation-item {
  display: flex;
  flex-direction: column;
  gap: 10px;
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

.conversation-item-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.conversation-title {
  font-weight: 700;
  color: #123533;
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
}

.chat-header {
  padding: 24px 28px 14px;
}

.chat-messages {
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
  box-shadow: 0 16px 30px rgba(15, 118, 110, 0.16);
}

.chat-message.assistant {
  max-width: min(85%, 780px);
  padding: 18px 20px;
  border-radius: 24px 24px 24px 10px;
  background: rgba(255, 255, 255, 0.82);
  box-shadow: 0 16px 32px rgba(37, 66, 63, 0.08);
}

.chat-input {
  padding: 18px 28px 28px;
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
