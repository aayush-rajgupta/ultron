import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import { PluginRuntime } from '../src/plugins';

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

test('DM Gating - unapproved sender triggers AI bouncer response', async () => {
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

  // Mock OpenAI/AI call
  process.env.AI_PROVIDER_PRIORITY = "OpenAI";
  process.env.OPENAI_API_KEY = "mock-key";
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "AI Bouncer: Please wait for my master." } }]
      })
    } as any;
  };

  const msg1 = {
    key: { id: "msg-unapproved-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg1);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "AI Bouncer: Please wait for my master.");
});

test('DM Gating - approved sender is ignored (manual chat)', async () => {
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

  const msg = {
    key: { id: "msg-approved-1", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "What is up?" },
    messageTimestamp: Math.floor((Date.now() + 10000) / 1000)
  };
  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 0); // ignored for manual chat
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

test('PluginRuntime - dispatch approve, stop, and afk commands', async () => {
  const runtime = new PluginRuntime('owner');

  // Test afk command execution
  const afkResult = await runtime.dispatch('afk', {
    sender: 'owner',
    owner: 'owner',
    args: ['Working', 'on', 'tests']
  } as any);
  assert.match(afkResult, /Activated/);
  assert.match(afkResult, /Working on tests/);

  const afkState = await mainModule.getAfkState();
  assert.equal(afkState.isAfk, true);
  assert.equal(afkState.reason, 'Working on tests');

  // Test approve command execution (should fail if not direct message)
  const approveFail = await runtime.dispatch('approve', {
    sender: 'owner',
    owner: 'owner',
    chatJid: '12345@g.us',
    args: []
  } as any);
  assert.match(approveFail, /direct message chat/);

  // Test approve command execution (success)
  const approveResult = await runtime.dispatch('approve', {
    sender: 'owner',
    owner: 'owner',
    chatJid: '919999999999@s.whatsapp.net',
    args: []
  } as any);
  assert.match(approveResult, /deactivated/);

  const approvalState = await mainModule.getApprovalState('919999999999@s.whatsapp.net');
  assert.equal(approvalState.approved, true);
  assert.equal(approvalState.stopped, false);

  // Test stop command execution (success)
  const stopResult = await runtime.dispatch('stop', {
    sender: 'owner',
    owner: 'owner',
    chatJid: '919999999999@s.whatsapp.net',
    args: []
  } as any);
  assert.match(stopResult, /paused/);

  const stoppedState = await mainModule.getApprovalState('919999999999@s.whatsapp.net');
  assert.equal(stoppedState.approved, false);
  assert.equal(stoppedState.stopped, true);
});
