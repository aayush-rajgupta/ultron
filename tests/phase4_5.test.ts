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
  assert.match(gateMessage.text, /busy with some stuff/);

  assert.ok(logMessage);
  assert.match(logMessage.text, /ULTRON LOG ENGINE/);
  assert.match(logMessage.text, /Incoming DM from unapproved user/);
  assert.match(logMessage.text, /hello logger/);
});

test('Central Logger Hook - forwards explicit group mention to LOG_GROUP_JID', async () => {
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

  // Group message with mention
  const msg = {
    key: { id: "msg-log-mention", remoteJid: "9112345678-1412@g.us", fromMe: false, participant: "919999999999@s.whatsapp.net" },
    message: {
      extendedTextMessage: {
        text: "hey @916263506758 how is it going?",
        contextInfo: {
          mentionedJid: ["916263506758@s.whatsapp.net"]
        }
      }
    },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].jid, "1203630248@g.us");
  assert.match(sentMessages[0].text, /ULTRON LOG ENGINE/);
  assert.match(sentMessages[0].text, /Explicit group mention/);
  assert.match(sentMessages[0].text, /hey @916263506758 how is it going\?/);
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
