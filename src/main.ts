import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import "./style.css";
import App from "./App.vue";
import ChatBot from "./components/ChatBot.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: ChatBot },
    { path: "/:conversationId", component: ChatBot },
  ],
});

createApp(App).use(router).mount("#app");
