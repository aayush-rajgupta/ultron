import { redis } from '../main';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const HISTORY_KEY_PREFIX = 'ultron:chat_history:';
const MAX_HISTORY_LEN = 15;
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

export async function getChatHistory(jid: string): Promise<ChatMessage[]> {
  try {
    if (!redis.isOpen) {
      return [];
    }
    const key = `${HISTORY_KEY_PREFIX}${jid}`;
    const data = await redis.lRange(key, 0, -1);
    return data.map((item) => JSON.parse(item) as ChatMessage);
  } catch (error) {
    return [];
  }
}

export async function addChatMessage(jid: string, message: ChatMessage): Promise<void> {
  try {
    if (!redis.isOpen) {
      return;
    }
    const key = `${HISTORY_KEY_PREFIX}${jid}`;
    const serialized = JSON.stringify(message);
    await redis.rPush(key, serialized);
    await redis.lTrim(key, -MAX_HISTORY_LEN, -1);
    await redis.expire(key, TTL_SECONDS);
  } catch (error) {
    // Fail silently
  }
}
