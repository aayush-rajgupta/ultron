import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import {
  generateAiResponse,
  resetGeminiPoolState,
  getAgenticTools
} from '../src/services/ai';
import { addUserHistory } from '../src/services/memory';

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
  resetGeminiPoolState();
});

test('Agentic Tools - dynamically declares registered plugins', async () => {
  const tools = await getAgenticTools();
  // Tools should contain googleSearch and plugin function declarations
  assert.ok(tools.length >= 2);
  assert.ok(tools[0].googleSearch);
  assert.ok(tools[1].functionDeclarations);
  
  const decls = tools[1].functionDeclarations;
  const pingDecl = decls.find((d: any) => d.name === 'cmd_ping');
  assert.ok(pingDecl);
  assert.equal(pingDecl.name, 'cmd_ping');
  assert.match(pingDecl.description, /ping/i);
});

test('Agentic Tool-Calling Loop - executes cmd_ping successfully', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";

  const fetchCalls: { url: string; body: any }[] = [];

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const body = options?.body ? JSON.parse(options.body as string) : null;
    fetchCalls.push({ url: urlStr, body });

    if (urlStr.includes('embedContent')) {
      return {
        ok: true,
        json: async () => ({
          embedding: { values: [0.1, 0.2, 0.3] }
        })
      } as any;
    }

    const generateCalls = fetchCalls.filter(c => c.url.includes('generateContent'));
    if (generateCalls.length === 1) {
      // Model decides to run cmd_ping
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  name: "cmd_ping",
                  args: {}
                }
              }]
            }
          }]
        })
      } as any;
    } else {
      // Model observes the PONG output and answers
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "The latency check responded with Pong." }] } }]
        })
      } as any;
    }
  };

  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  const res = await generateAiResponse("run ping test");
  assert.equal(res.text, "The latency check responded with Pong.");

  const genCalls = fetchCalls.filter(c => c.url.includes('generateContent'));
  assert.equal(genCalls.length, 2);
  
  // The second generateContent turn contains the command execution result
  const secondContents = genCalls[1].body.contents;
  const lastTurn = secondContents[secondContents.length - 1];
  assert.equal(lastTurn.role, "user");
  assert.ok(lastTurn.parts[0].functionResponse);
  assert.equal(lastTurn.parts[0].functionResponse.name, "cmd_ping");
  assert.match(lastTurn.parts[0].functionResponse.response.result, /Pong/i);
});

test('Agentic Safety - blocks owner-only commands for strangers', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";
  process.env.OWNER_JID = "916263506758@s.whatsapp.net";

  const fetchCalls: { url: string; body: any }[] = [];

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    const body = options?.body ? JSON.parse(options.body as string) : null;
    fetchCalls.push({ url: urlStr, body });

    if (urlStr.includes('embedContent')) {
      return {
        ok: true,
        json: async () => ({
          embedding: { values: [0.1, 0.2, 0.3] }
        })
      } as any;
    }

    const generateCalls = fetchCalls.filter(c => c.url.includes('generateContent'));
    if (generateCalls.length === 1) {
      // Model tries to run cmd_afk (ownerOnly)
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  name: "cmd_afk",
                  args: { args: ["Busy"] }
                }
              }]
            }
          }]
        })
      } as any;
    } else {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "I cannot do that as it is owner-only." }] } }]
        })
      } as any;
    }
  };

  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Call generator with stranger phone number
  const res = await generateAiResponse(
    "Set AFK to Busy",
    [],
    "Stranger",
    "919999999999", // Stranger
    false,
    undefined,
    "919999999999@s.whatsapp.net"
  );
  assert.equal(res.text, "I cannot do that as it is owner-only.");

  const genCalls = fetchCalls.filter(c => c.url.includes('generateContent'));
  const secondContents = genCalls[1].body.contents;
  const lastTurn = secondContents[secondContents.length - 1];
  assert.equal(lastTurn.parts[0].functionResponse.response.result, "Owner-only command.");
});

test('History Sync - addUserHistory respects createdAt and skipEmbedding', async () => {
  mainModule.setPrismaConnected(true);

  let prismaCreatedArgs: any = null;
  const mockPrisma = {
    userHistory: {
      create: async (args: any) => {
        prismaCreatedArgs = args.data;
        return { id: "test-cuid" };
      }
    }
  };

  const originalPrisma = mainModule.prisma;
  (mainModule as any).prisma = mockPrisma;

  const testDate = new Date(Date.now() - 100000);
  
  // Call addUserHistory with skipEmbedding = true and a custom date
  await addUserHistory("918888888888", "user", "Hello master", testDate, true);

  assert.ok(prismaCreatedArgs);
  assert.equal(prismaCreatedArgs.userId, "918888888888");
  assert.equal(prismaCreatedArgs.role, "user");
  assert.equal(prismaCreatedArgs.content, "Hello master");
  assert.deepEqual(prismaCreatedArgs.embedding, []); // empty because skipEmbedding is true
  assert.equal(prismaCreatedArgs.createdAt.getTime(), testDate.getTime());

  (mainModule as any).prisma = originalPrisma;
});

