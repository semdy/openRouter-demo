<script setup lang="ts">
import { ref } from "vue";
import type { ParsedNode } from "markstream-vue";
import MarkdownRender, {
  getMarkdown,
  parseMarkdownToStructure,
} from "markstream-vue";
import { v4 as uuidv4 } from "uuid";
import { ChatSession, type Message as AIMessage } from "../sdk/openrouter";
import "markstream-vue/index.css";

type Message = AIMessage & {
  msgId: number | string;
};
type MessageWithNodes = Message & { nodes?: ParsedNode[] };

const messages = ref<MessageWithNodes[]>([]);
const buffer = ref("");
const input = ref("");
const loading = ref(false);
const md = getMarkdown();

let msgId = 0;

const chatSession = new ChatSession({
  conversationId: "ff9700b2-a894-47c5-b88e-1dcb858e2f0c", // uuidv4(),
  onReceiveMessage(message: AIMessage) {
    buffer.value = "";
    messages.value.push({ ...message, msgId: msgId++ });
    loading.value = true;
  },
  onReceiveChunk(chunk: string) {
    buffer.value += chunk;
    const lastAssistantMsg = messages.value[messages.value.length - 1];
    lastAssistantMsg.content = buffer.value;
    lastAssistantMsg.nodes = parseMarkdownToStructure(buffer.value, md);
  },
  onCompletionFinally() {
    loading.value = false;
  },
});

async function send() {
  const msg = input.value;
  input.value = "";
  await chatSession.send(msg);
}
</script>

<template>
  <div class="chat-container">
    <div class="chat-messages">
      <div class="chat-render">
        <template v-for="message in messages" :key="message.msgId">
          <div v-if="message.role === 'user'" class="chat-message user">
            <div class="chat-content">{{ message.content }}</div>
          </div>
          <MarkdownRender
            class="chat-message assistant"
            :nodes="message.nodes"
            is-dark
            v-if="message.role === 'assistant'"
          />
        </template>
      </div>
    </div>
    <div class="chat-input">
      <form @submit.prevent="send">
        <input type="text" v-model="input" placeholder="Type your message..." />
        <button type="submit" :disabled="loading">Send</button>
      </form>
    </div>
  </div>
</template>

<style>
.chat-container {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

.chat-messages {
  flex: 1;
  display: flex;
  flex-direction: column-reverse;
  overflow-y: auto;
  scroll-behavior: smooth;
  overscroll-behavior: contain;
  height: 100%;
}

.chat-render {
  flex: 1;
  padding: 24px 32px;
}

.chat-message.user {
  display: flex;
  justify-content: flex-end;
  padding: 24px;
}

.chat-message.user .chat-content {
  padding: 10px 16px;
  background-color: #323232d9;
  border-radius: 22px;
}

.chat-input {
  display: flex;
  padding: 10px;
}

.chat-input form {
  flex: 1;
  display: flex;
}

.chat-input input {
  flex: 1;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 4px;
}

.chat-input button {
  margin-left: 10px;
  padding: 10px 20px;
  background-color: #007bff;
  color: white;
  border: none;
  border-radius: 4px;
  cursor: pointer;
}

.chat-input button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}
</style>
