import { redis } from '../main';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const HISTORY_KEY_PREFIX = 'ultron:chat_history:';
const MAX_HISTORY_LEN = 15;
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

export async function getChatHistory(phoneNumber: string): Promise<ChatMessage[]> {
  try {
    if (!redis.isOpen) {
      return [];
    }
    const key = `${HISTORY_KEY_PREFIX}${phoneNumber}`;
    const data = await redis.lRange(key, 0, -1);
    return data.map((item) => JSON.parse(item) as ChatMessage);
  } catch (error) {
    return [];
  }
}

export async function addChatMessage(phoneNumber: string, message: ChatMessage): Promise<void> {
  try {
    if (!redis.isOpen) {
      return;
    }
    const key = `${HISTORY_KEY_PREFIX}${phoneNumber}`;
    const serialized = JSON.stringify(message);
    await redis.rPush(key, serialized);
    await redis.lTrim(key, -MAX_HISTORY_LEN, -1);
    await redis.expire(key, TTL_SECONDS);
  } catch (error) {
    // Fail silently
  }
}

let fallbackMasterKnowledge = '';

export async function updateMasterKnowledge(text: string): Promise<void> {
  try {
    if (!redis.isOpen) {
      fallbackMasterKnowledge = fallbackMasterKnowledge ? `${fallbackMasterKnowledge}\n${text}` : text;
      return;
    }
    const current = await redis.get('ultron:master_knowledge');
    const updated = current ? `${current}\n${text}` : text;
    await redis.set('ultron:master_knowledge', updated);
  } catch (error) {
    // Fail silently
  }
}

export async function getMasterKnowledge(): Promise<string> {
  try {
    if (!redis.isOpen) {
      return fallbackMasterKnowledge;
    }
    return (await redis.get('ultron:master_knowledge')) || fallbackMasterKnowledge;
  } catch (error) {
    return fallbackMasterKnowledge;
  }
}

