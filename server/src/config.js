export const MAX_TURNS = 10; // keep last 10 rounds
export const MAX_CONCURRENT = 5;
export const CACHE_TTL_SECONDS = 60 * 60;
export const PARTIAL_CACHE_TTL_SECONDS = 60 * 10;
export const MAX_PROMPT_TOKENS = 8000;
export const SYSTEM_PROMPT = "You are a helpful assistant.";
export const CONTINUE_PROMPT = `
继续完成上一个回答。

要求：
1. 从已有内容的末尾继续
2. 不要重复已经输出的内容
3. 保持语气和风格一致
4. 直接续写，不要解释
`;
