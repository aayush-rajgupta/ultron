import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const originalSocket = mainModule.socket;
const originalPrismaConnected = mainModule.prismaConnected;
const originalRedisConnected = mainModule.redisConnected;

test.beforeEach(() => {
  mainModule.setPrismaConnected(false);
  mainModule.setRedisConnected(false);
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
  mainModule.setSocket(originalSocket);
  mainModule.setPrismaConnected(originalPrismaConnected);
  mainModule.setRedisConnected(originalRedisConnected);
  mainModule.fallbackChatState.clear();
  mainModule.sentGateMessages.clear();
  mainModule.processedMessageIds.clear();
  mainModule.setAfkState(false, "", 0);
});

test('getDynamicGreeting - computes correct timezone greeting (Asia/Kolkata)', () => {
  const originalGetHours = Date.prototype.getHours;
  const originalGetMinutes = Date.prototype.getMinutes;

  // Mock to 9:30 AM IST
  Date.prototype.getHours = () => 9;
  Date.prototype.getMinutes = () => 30;
  assert.equal(mainModule.getDynamicGreeting(), "Good morning");

  // Mock to 2:30 PM IST
  Date.prototype.getHours = () => 14;
  Date.prototype.getMinutes = () => 30;
  assert.equal(mainModule.getDynamicGreeting(), "Good afternoon");

  // Mock to 8:30 PM IST
  Date.prototype.getHours = () => 20;
  Date.prototype.getMinutes = () => 30;
  assert.equal(mainModule.getDynamicGreeting(), "Good evening");

  // Restore Date prototypes
  Date.prototype.getHours = originalGetHours;
  Date.prototype.getMinutes = originalGetMinutes;
});

test('DM Gating - unapproved sender receives exactly one gate message', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // First message from unapproved user
  const msg1 = {
    key: { id: "msg-unapproved-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /busy with some stuff/);

  // Second message from same user (should be deduplicated)
  const msg2 = {
    key: { id: "msg-unapproved-2", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "second ping" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg2);

  assert.equal(sentMessages.length, 1); // still 1 message (deduplicated)
});

test('DM Gating - approved sender triggers AI auto-response', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Approve the user
  await mainModule.setApprovalState("919999999999@s.whatsapp.net", { approved: true, stopped: false });

  // Mock OpenAI/AI call
  process.env.AI_PROVIDER_PRIORITY = "OpenAI";
  process.env.OPENAI_API_KEY = "mock-key";
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "AI Autoreply: Hello human!" } }]
      })
    } as any;
  };

  const msg = {
    key: { id: "msg-approved-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "What is up?" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "AI Autoreply: Hello human!");
});

test('DM Gating - stopped sender receives no replies', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Set chat to stopped state (manual control)
  await mainModule.setApprovalState("919999999999@s.whatsapp.net", { approved: false, stopped: true });

  const msg = {
    key: { id: "msg-stopped-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 0); // No replies sent
});

test('AFK - auto-reply and deactivation', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Activate AFK (Away for 2 hours 15 minutes)
  const startTime = Date.now() - (2 * 3600 * 1000 + 15 * 60 * 1000);
  await mainModule.setAfkState(true, "Coding session", startTime);

  // Message from non-owner DM
  const msgFromUser = {
    key: { id: "msg-afk-user-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Are you there?" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msgFromUser);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Aayush is currently AFK/);
  assert.match(sentMessages[0].text, /Reason:\* Coding session/);
  assert.match(sentMessages[0].text, /Away for:\* 2 hours 15 minutes/);

  // Message from owner (should auto-deactivate AFK)
  const msgFromOwner = {
    key: { id: "msg-afk-owner-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: true },
    message: { conversation: "I am back now" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msgFromOwner);

  const afkState = await mainModule.getAfkState();
  assert.equal(afkState.isAfk, false); // AFK state deactivated!
});
