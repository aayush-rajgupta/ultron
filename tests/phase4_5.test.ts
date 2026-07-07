import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import { PluginRuntime } from '../src/plugins';

const originalEnv = { ...process.env };
const originalSocket = mainModule.socket;
const originalPrismaConnected = mainModule.prismaConnected;
const originalRedisConnected = mainModule.redisConnected;

test.beforeEach(() => {
  mainModule.setPrismaConnected(false);
  mainModule.setRedisConnected(false);
});

test.afterEach(() => {
  process.env = { ...originalEnv };
  mainModule.setSocket(originalSocket);
  mainModule.setPrismaConnected(originalPrismaConnected);
  mainModule.setRedisConnected(originalRedisConnected);
  mainModule.fallbackChatState.clear();
  mainModule.sentGateMessages.clear();
  mainModule.processedMessageIds.clear();
  mainModule.setAfkState(false, "", 0);
});

test('PluginRuntime - neofetch telemetry command', async () => {
  const runtime = new PluginRuntime('owner');
  const result = await runtime.dispatch('neofetch', {
    sender: 'owner',
    owner: 'owner',
    args: []
  } as any);

  assert.match(result, /ULTRON OS NEOFETCH/);
  assert.match(result, /Platform:/);
  assert.match(result, /Architecture:/);
  assert.match(result, /NodeJS Version:/);
  assert.match(result, /RAM Usage:/);
});

test('PluginRuntime - alive detailed status command', async () => {
  const runtime = new PluginRuntime('owner');
  const result = await runtime.dispatch('alive', {
    sender: 'owner',
    owner: 'owner',
    args: []
  } as any);

  assert.match(result, /ULTRON STATUS/);
  assert.match(result, /Uptime:/);
  assert.match(result, /Database:/);
  assert.match(result, /Cache:/);
  assert.match(result, /AFK State:/);
  assert.match(result, /DM Gate:/);
});

test('PluginRuntime - animations commands (type, loading, clock, vapor, mock, slap)', async () => {
  const runtime = new PluginRuntime('owner');
  const editedFrames: string[] = [];
  const context = {
    sender: 'owner',
    owner: 'owner',
    editMessage: async (text: string) => {
      editedFrames.push(text);
    }
  };

  // 1. Vapor
  const vaporRes = await runtime.dispatch('vapor', { ...context, args: ['hello', 'world'] } as any);
  assert.equal(vaporRes, 'h e l l o   w o r l d');

  // 2. Mock
  const mockRes = await runtime.dispatch('mock', { ...context, args: ['hello'] } as any);
  assert.equal(mockRes.toLowerCase(), 'hello');

  // 3. Slap
  const slapRes = await runtime.dispatch('slap', { ...context, args: ['Alice'] } as any);
  assert.match(slapRes, /Aayush/);
  assert.match(slapRes, /slapped Alice|hit Alice|drop-kicked Alice/);

  // 4. Typewriter typing animation
  editedFrames.length = 0;
  const typeRes = await runtime.dispatch('type', { ...context, args: ['cat'] } as any);
  assert.equal(typeRes, 'cat');
  assert.deepEqual(editedFrames, ['c|', 'ca|', 'cat|']);

  // 5. Loading bar animation
  editedFrames.length = 0;
  const loadingRes = await runtime.dispatch('loading', { ...context, args: [] } as any);
  assert.equal(loadingRes, 'System fully initialized.');
  assert.equal(editedFrames.length, 6);
  assert.match(editedFrames[0], /0%/);
  assert.match(editedFrames[5], /100%/);

  // 6. Clock emojis matrix
  editedFrames.length = 0;
  const clockRes = await runtime.dispatch('clock', { ...context, args: [] } as any);
  assert.match(clockRes, /Live Server Time/);
  assert.equal(editedFrames.length, 12);
  assert.match(editedFrames[0], /🕐/);
  assert.match(editedFrames[11], /🕛/);
});

test('Central Logger Hook - forwards DM from unapproved user to LOG_GROUP_JID', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);
  
  process.env.LOG_GROUP_JID = "1203630248@g.us";

  // Mock OpenAI/AI call
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

  // Incoming DM from unapproved user
  const msg = {
    key: { id: "msg-log-dm", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello logger" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 2);
  const gateMessage = sentMessages.find(m => m.jid === "919999999999@s.whatsapp.net");
  const logMessage = sentMessages.find(m => m.jid === "1203630248@g.us");

  assert.ok(gateMessage);
  assert.match(gateMessage.text, /AI Bouncer Response/);

  assert.ok(logMessage);
  assert.match(logMessage.text, /ULTRON LOG ENGINE/);
  assert.match(logMessage.text, /Incoming DM from unapproved user/);
  assert.match(logMessage.text, /hello logger/);
});

test('Central Logger Hook - forwards DM from unapproved user with @lid JID to LOG_GROUP_JID', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);
  
  process.env.LOG_GROUP_JID = "1203630248@g.us";

  // Mock OpenAI/AI call
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

  // Incoming DM from unapproved user with @lid JID
  const msg = {
    key: { id: "msg-log-dm-lid", remoteJid: "919999999999@lid", fromMe: false },
    message: { conversation: "hello logger via lid" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 2);
  const gateMessage = sentMessages.find(m => m.jid === "919999999999@lid");
  const logMessage = sentMessages.find(m => m.jid === "1203630248@g.us");

  assert.ok(gateMessage);
  assert.match(gateMessage.text, /AI Bouncer Response/);

  assert.ok(logMessage);
  assert.match(logMessage.text, /ULTRON LOG ENGINE/);
  assert.match(logMessage.text, /Incoming DM from unapproved user/);
  assert.match(logMessage.text, /hello logger via lid/);
});

test('PluginRuntime - typewriter animation frame cap is enforced', async () => {
  const runtime = new PluginRuntime('owner');
  const editedFrames: string[] = [];
  const context = {
    sender: 'owner',
    owner: 'owner',
    editMessage: async (text: string) => {
      editedFrames.push(text);
    }
  };

  const longText = "This is a very long string designed to exceed the 15 frame mutation limit to verify that the step computation works correctly.";
  const typeRes = await runtime.dispatch('type', { ...context, args: [longText] } as any);
  assert.equal(typeRes, longText);
  assert.ok(editedFrames.length <= 15);
});

test('Central Logger Hook - media payload safety', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);
  
  process.env.LOG_GROUP_JID = "1203630248@g.us";

  const msg = {
    key: { id: "msg-media-log", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: {
      imageMessage: {
        // missing caption
      }
    },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  const logMessage = sentMessages.find(m => m.jid === "1203630248@g.us");
  assert.ok(logMessage);
  assert.match(logMessage.text, /\[Media or Empty Message\]/);
});

test('ensureJidSuffix - verification and idempotency', () => {
  const ensureJidSuffix = mainModule.ensureJidSuffix;
  assert.equal(ensureJidSuffix("919999999999"), "919999999999@s.whatsapp.net");
  assert.equal(ensureJidSuffix("919999999999@s.whatsapp.net"), "919999999999@s.whatsapp.net");
  assert.equal(ensureJidSuffix("919999999999:1@s.whatsapp.net"), "919999999999@s.whatsapp.net");
  assert.equal(ensureJidSuffix("919999999999@c.us"), "919999999999@s.whatsapp.net");
  assert.equal(ensureJidSuffix("1203630248@g.us"), "1203630248@g.us");
});

test('extractContactInfo - extracts metadata correctly', () => {
  const extractContactInfo = mainModule.extractContactInfo;
  const msg = {
    key: { remoteJid: "919999999999:2@s.whatsapp.net" },
    pushName: "Alice"
  };
  const info = extractContactInfo(msg);
  assert.equal(info.rawJid, "919999999999:2@s.whatsapp.net");
  assert.equal(info.phoneNumber, "919999999999");
  assert.equal(info.pushName, "Alice");
});

test('routeMessage - !update command saves knowledge and edits the message', async () => {
  const sentMessages: { jid: string; text: string; editKey?: any }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text, editKey: content.edit });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  const { getMasterKnowledge } = await import('../src/services/memory');

  const msg = {
    key: { id: "msg-update-command", remoteJid: "916263506758@s.whatsapp.net", fromMe: true },
    message: { conversation: "!update Aayush passed Class 12 with high marks." },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "✅ Master Knowledge updated.");
  assert.deepEqual(sentMessages[0].editKey, msg.key);

  const updatedKnowledge = await getMasterKnowledge();
  assert.match(updatedKnowledge, /Aayush passed Class 12 with high marks\./);
});

test('routeMessage - !urgent command triggers emergency override and cooldown', async () => {
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

  // Mock env variables so transporter creation succeeds or fails gracefully without blocking
  process.env.SMTP_EMAIL = "test@gmail.com";
  process.env.SMTP_PASSWORD = "password";

  // First !urgent trigger
  const msg1 = {
    key: { id: "msg-urgent-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "!urgent" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);

  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].text, /Emergency Override Triggered/);

  // Second !urgent trigger (should trigger cooldown)
  const msg2 = {
    key: { id: "msg-urgent-2", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "!urgent" },
    messageTimestamp: Math.floor((Date.now() + 12000) / 1000)
  };
  await mainModule.routeMessage(msg2);

  assert.equal(sentMessages.length, 2);
  assert.match(sentMessages[1].text, /Emergency alert already sent/);
});

