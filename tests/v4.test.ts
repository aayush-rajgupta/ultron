import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import { generateAiResponse, resetGeminiPoolState } from '../src/services/ai';
import { PluginRuntime } from '../src/plugins';

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

test('v4.0 Gemini Pooling - failover across keys', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEYS = "key1,key2,key3";

  const fetchCalls: string[] = [];

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      const key = urlStr.split('key=')[1];
      fetchCalls.push(key);

      if (key === 'key1') {
        // Return 429 to trigger cooldown
        return {
          ok: false,
          status: 429,
          text: async () => "Rate limit exceeded"
        } as any;
      }
      if (key === 'key2') {
        // Return success
        return {
          ok: true,
          json: async () => ({
            candidates: [{ content: { parts: [{ text: "Success from Key 2!" }] } }]
          })
        } as any;
      }
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateAiResponse("test message");
  assert.equal(res.text, "Success from Key 2!");
  assert.deepEqual(fetchCalls, ["key1", "key2"]);
});

test('v4.0 Bouncer Cooldown - gate message suppressed on repeat', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Set user to unapproved
  await mainModule.setApprovalState("919999999999@s.whatsapp.net", { approved: false, stopped: false });

  // Mock AI response
  process.env.AI_PROVIDER_PRIORITY = "OpenAI";
  process.env.OPENAI_API_KEY = "mock-key";
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "AI Bouncer Response" } }]
      })
    } as any;
  };

  // First message -> gate response sent
  const msg1 = {
    key: { id: "msg-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "AI Bouncer Response");

  // Second message immediately -> gate response suppressed due to 3-hour cooldown
  const msg2 = {
    key: { id: "msg-2", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello again" },
    messageTimestamp: Math.floor((Date.now() + 12000) / 1000)
  };
  await mainModule.routeMessage(msg2);
  assert.equal(sentMessages.length, 1); // No new message sent
});

test('v4.0 Semantic Emergency Confirmation - triggers alert email on affirmation', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Unapproved chat
  await mainModule.setApprovalState("919999999999@s.whatsapp.net", { approved: false, stopped: false });

  // Mock AI response
  process.env.AI_PROVIDER_PRIORITY = "OpenAI";
  process.env.OPENAI_API_KEY = "mock-key";
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Should I notify Aayush immediately?" } }]
      })
    } as any;
  };

  // Send an urgent message
  const msg1 = {
    key: { id: "msg-urgent-trigger", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "There is a medical emergency!" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);

  // Verify the AI asks confirmation
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /notify Aayush/);

  // Verify pending emergency state is true
  const { getChatState } = await import('../src/services/memory');
  let state = await getChatState("919999999999@s.whatsapp.net");
  assert.equal(state.pendingEmergency, true);

  // Send affirmation "yes, please"
  const msg2 = {
    key: { id: "msg-affirmation", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "yes, please do" },
    messageTimestamp: Math.floor((Date.now() + 12000) / 1000)
  };
  await mainModule.routeMessage(msg2);

  // Verify emergency response sent
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /Emergency Override Triggered/);

  // Verify pending emergency is cleared
  state = await getChatState("919999999999@s.whatsapp.net");
  assert.equal(state.pendingEmergency, false);
});

test('v4.0 AFK - host manual message ends AFK, auto-replies do not', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Enable AFK
  await mainModule.setAfkState(true, "Sleeping", Date.now());

  // Stranger messages -> triggers AFK reply
  const msg1 = {
    key: { id: "stranger-msg", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /My master is currently AFK/);

  // The bot's own response should be marked as bot-sent
  await mainModule.markBotSentMessage("bot-sent-id");

  // An outgoing message from the bot (fromMe: true, isBot: true) should NOT clear AFK
  const botMessage = {
    key: { id: "bot-sent-id", remoteJid: "919999999999@s.whatsapp.net", fromMe: true },
    message: { conversation: "My master is currently AFK..." },
    messageTimestamp: Math.floor((Date.now() + 12000) / 1000)
  };
  await mainModule.routeMessage(botMessage);
  let afkState = await mainModule.getAfkState();
  assert.equal(afkState.isAfk, true); // AFK remains active!

  // An outgoing manual message from the host (fromMe: true, isBot: false) should clear AFK
  const hostMessage = {
    key: { id: "host-manual-id", remoteJid: "919999999999@s.whatsapp.net", fromMe: true },
    message: { conversation: "I am replying myself now" },
    messageTimestamp: Math.floor((Date.now() + 14000) / 1000)
  };
  await mainModule.routeMessage(hostMessage);
  afkState = await mainModule.getAfkState();
  assert.equal(afkState.isAfk, false); // AFK deactivated!

  // Verify the end notice was sent
  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /AFK mode ended/);
});

test('v4.0 Group Chats - filters triggers correctly', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any, options: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "bot-msg-123" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Mock AI response
  process.env.AI_PROVIDER_PRIORITY = "OpenAI";
  process.env.OPENAI_API_KEY = "mock-key";
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "AI Reply in Group" } }]
      })
    } as any;
  };

  // 1. A message in group without mention/keyword -> ignored
  const groupMsgIgnored = {
    key: { id: "group-msg-1", remoteJid: "123456789@g.us", participant: "918888888888@s.whatsapp.net", fromMe: false },
    message: { conversation: "Hello people" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(groupMsgIgnored);
  assert.equal(sentMessages.length, 0);

  // 2. A message containing keyword "ultron" -> processed
  const groupMsgKeyword = {
    key: { id: "group-msg-2", remoteJid: "123456789@g.us", participant: "918888888888@s.whatsapp.net", fromMe: false },
    message: { conversation: "Hey ultron, how are you?" },
    messageTimestamp: Math.floor((Date.now() + 12000) / 1000)
  };
  await mainModule.routeMessage(groupMsgKeyword);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "AI Reply in Group");
});
