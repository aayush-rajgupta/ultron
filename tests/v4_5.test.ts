import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import {
  generateAiResponse,
  generateReservedAiResponse,
  isReservedTask,
  getApiStatusRegistry,
  resetGeminiPoolState
} from '../src/services/ai';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalSocket = mainModule.socket;
const originalPrismaConnected = mainModule.prismaConnected;
const originalRedisConnected = mainModule.redisConnected;

test.beforeEach(() => {
  mainModule.setPrismaConnected(false);
  mainModule.setRedisConnected(false);
  resetGeminiPoolState();
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  mainModule.setSocket(originalSocket);
  mainModule.setPrismaConnected(originalPrismaConnected);
  mainModule.setRedisConnected(originalRedisConnected);
  mainModule.fallbackChatState.clear();
  mainModule.fallbackAfkNotifiedChats.clear();
  mainModule.fallbackGroupCooldowns.clear();
  mainModule.botSentMessageIds.clear();
  mainModule.setAfkState(false, "", 0);
  resetGeminiPoolState();
});

test('v4.5 Gemini Dual-Pool Isolation - General Pool uses keys 1 and 2', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";

  const fetchCalls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      const key = urlStr.split('key=')[1];
      fetchCalls.push(key);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `Response from ${key}` }] } }]
        })
      } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateAiResponse("test message");
  assert.equal(res.text, "Response from key1");
  assert.deepEqual(fetchCalls, ["key1"]);
});

test('v4.5 Gemini Dual-Pool Isolation - Reserved Pool uses keys 3 and 4', async () => {
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";

  const fetchCalls: string[] = [];
  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      const key = urlStr.split('key=')[1];
      fetchCalls.push(key);
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: `Response from ${key}` }] } }]
        })
      } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateReservedAiResponse("test message");
  assert.equal(res.text, "Response from key3");
  assert.deepEqual(fetchCalls, ["key3"]);
});

test('v4.5 Routing Decision - isReservedTask checks attachment type and text keywords', () => {
  // Test attachment JIDs/message types
  const imageMsg = { message: { imageMessage: {} } };
  assert.equal(isReservedTask(imageMsg, "hello"), true);

  const docMsg = { message: { documentMessage: {} } };
  assert.equal(isReservedTask(docMsg, "hello"), true);

  const textMsg = { message: { conversation: "hello" } };
  assert.equal(isReservedTask(textMsg, "hello"), false);

  // Test clean text keywords
  assert.equal(isReservedTask(textMsg, "summarize PDF"), true);
  assert.equal(isReservedTask(textMsg, "!vision describe this"), true);
  assert.equal(isReservedTask(textMsg, "ocr check"), true);
  assert.equal(isReservedTask(textMsg, "please generate image description"), true);
  assert.equal(isReservedTask(textMsg, "just a normal chat message"), false);
});

test('v4.5 API Status Registry - checks cooldowns and failures', async () => {
  // Set mock statuses using reset pool state fallback objects (simulating Redis being down)
  const { fallbackCooldowns, fallbackFailures, fallbackProviderCooldowns, fallbackProviderFailures } = require('../src/services/ai');
  
  // Cool down Gemini Key 2 (index 1)
  fallbackCooldowns[1] = Date.now() + 60000;
  // Fail Gemini Reserved 2 (index 3)
  fallbackFailures[3] = Date.now() + 60000;
  
  // Cool down OpenAI
  fallbackProviderCooldowns["openai"] = Date.now() + 60000;
  // Fail Claude
  fallbackProviderFailures["claude"] = Date.now() + 60000;

  const registry = await getApiStatusRegistry();
  assert.equal(registry["Gemini Key 1"], "Alive");
  assert.equal(registry["Gemini Key 2"], "Limit Reached (Cooling Down)");
  assert.equal(registry["Gemini Reserved 1"], "Alive");
  assert.equal(registry["Gemini Reserved 2"], "Unreachable");
  assert.equal(registry["OpenAI"], "Limit Reached (Cooling Down)");
  assert.equal(registry["Claude"], "Unreachable");
  assert.equal(registry["OpenRouter"], "Alive");
});

test('v4.5 Reserved Pool Fallback Chain - Gemini -> OpenAI -> Claude -> None', async () => {
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";
  process.env.OPENAI_API_KEY = "mock-openai";
  process.env.ANTHROPIC_API_KEY = "mock-claude";

  const calls: string[] = [];

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      const key = urlStr.split('key=')[1];
      calls.push(`gemini-${key}`);
      return { ok: false, status: 500, text: async () => "Internal server error" } as any;
    }
    if (urlStr.includes('api.openai.com')) {
      calls.push("openai");
      return { ok: false, status: 500, text: async () => "Internal server error" } as any;
    }
    if (urlStr.includes('api.anthropic.com') || urlStr.includes('api.anthropic')) {
      calls.push("claude");
      return { ok: true, json: async () => ({ content: [{ text: "Success from Claude!" }] }) } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateReservedAiResponse("test message");
  assert.equal(res.text, "Success from Claude!");
  // Should call gemini reserved keys (key3 and key4), then openai, then claude
  assert.deepEqual(calls, ["gemini-key3", "gemini-key4", "openai", "claude"]);
});

test('v4.5 ping Calculation - measures true processing latency', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Incoming command message
  const msg = {
    key: { id: "msg-ping", remoteJid: "919999999999@s.whatsapp.net", fromMe: true },
    message: { conversation: "!ping" },
    messageTimestamp: Math.floor(Date.now() / 1000)
  };

  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /\*Pong!\* \d+ms/);
});
