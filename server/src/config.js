export const MAX_TURNS = 50; // keep last 50 rounds
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
export const GENERATE_TITLE_PROMPT = `
你是一个会话标题生成器。

要求：
1. 基于用户问题和助手回答生成一个简短标题
2. 不超过20个汉字
3. 不要加引号、句号或多余解释
4. 不要使用“关于”“讨论”“聊天”等空泛词
5. 直接输出标题
`;
