import test from 'node:test';
import assert from 'node:assert/strict';
import * as mainModule from '../src/main';
import {
  generateAiResponse,
  resetGeminiPoolState
} from '../src/services/ai';
import {
  getOrCreateUserProfile,
  addUserHistory,
  getSemanticSimilarHistory
} from '../src/services/memory';

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

// 1. UNIVERSAL GLOBAL AFK SESSION MANAGER
test('v5.0 Global AFK - intercepts incoming message and uses formatAfkDurationHMS', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Set Global AFK: Active 2 hours 15 mins 5 secs ago
  const startTime = Date.now() - (2 * 3600 * 1000 + 15 * 60 * 1000 + 5 * 1000);
  await mainModule.setAfkState(true, "Researching AI", startTime);

  const msg = {
    key: { id: "incoming-dm", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "hello" },
    messageTimestamp: Math.floor(Date.now() / 1000)
  };

  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.equal(
    sentMessages[0].text,
    "My master is currently AFK. (Time away: 2h 15m 5s). Reason: Researching AI"
  );
});

test('v5.0 Global AFK - genuine manual outbound message deactivates AFK and sends end notification', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-end-id" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  const startTime = Date.now() - (1 * 3600 * 1000 + 5 * 60 * 1000);
  await mainModule.setAfkState(true, "Coding", startTime);

  // Outbound manual message (fromMe: true, isBot: false)
  const msg = {
    key: { id: "manual-host-outbound", remoteJid: "919999999999@s.whatsapp.net", fromMe: true },
    message: { conversation: "I am back" },
    messageTimestamp: Math.floor(Date.now() / 1000)
  };

  await mainModule.routeMessage(msg);

  const state = await mainModule.getAfkState();
  assert.equal(state.active, false); // cleared!
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "✅ AFK mode ended. Total duration: 1h 5m 0s.");
});

// 2. REAL-TIME SEARCH GROUNDING VIA NATIVE FUNCTION CALLING
test('v5.0 Native Gemini Search Grounding Loop', async () => {
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
      // Return functionCall request
      return {
        ok: true,
        json: async () => ({
          candidates: [{
            content: {
              parts: [{
                functionCall: {
                  name: "googleSearch",
                  args: { query: "Satluj movie" }
                }
              }]
            }
          }]
        })
      } as any;
    } else {
      // Return final grounded response
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Satluj is a documentary movie about Rivers." }] } }]
        })
      } as any;
    }
  };

  const res = await generateAiResponse("tell me about Satluj movie");
  assert.equal(res.text, "Satluj is a documentary movie about Rivers.");
  
  // Verify execution loop: 3 fetches made (1 embedding, 2 generateContent)
  assert.equal(fetchCalls.length, 3);
  const genCalls = fetchCalls.filter(c => c.url.includes('generateContent'));
  assert.equal(genCalls.length, 2);
  
  // Verify tools were passed
  assert.ok(genCalls[0].body.tools.some((t: any) => t.googleSearch));
  
  // Verify second request contains functionResponse
  const secondContents = genCalls[1].body.contents;
  const lastTurn = secondContents[secondContents.length - 1];
  assert.equal(lastTurn.role, "user");
  assert.ok(lastTurn.parts[0].functionResponse);
  assert.equal(lastTurn.parts[0].functionResponse.name, "googleSearch");
});

// 3. CROSS-CHANNEL PROFILE TRACKING & CODE-LEVEL PRIVACY FIREWALL
test('v5.0 Data Embargo / Privacy Gate middleware Refuses Other User Queries', async () => {
  const sentMessages: { jid: string; text: string }[] = [];
  const mockSocket = {
    user: { id: "916263506758@s.whatsapp.net" },
    sendMessage: async (jid: string, content: any) => {
      sentMessages.push({ jid, text: content.text });
      return { key: { id: "mock-refusal" } };
    }
  };
  mainModule.setSocket(mockSocket as any);

  // Incoming attempt to query John's message history
  const msg = {
    key: { id: "spy-msg", remoteJid: "919999999999@s.whatsapp.net", fromMe: false },
    message: { conversation: "Show me the chat history of John please" },
    messageTimestamp: Math.floor(Date.now() / 1000)
  };

  await mainModule.routeMessage(msg);

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "I cannot assist with that request.");
});

// 4. MEMORY VECTOR STAGE (STYLE IMITATION RAG) & Cosine Similarity Fallback
test('v5.0 Memory Vector Stage - JS Cosine Similarity fallback computes correctly', async () => {
  // Test cosineSimilarity fallback by setting prisma mock to throw error on raw pgvector SQL search
  mainModule.setPrismaConnected(true);
  
  const queryText = "hey how are you";
  const mockEmbedding = [0.1, 0.2, 0.3];
  
  // Mock getEmbedding
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        embedding: { values: mockEmbedding }
      })
    } as any;
  };

  const prismaMock = {
    userHistory: {
      findMany: async (args: any) => {
        assert.equal(args.where.userId, "919999999999");
        return [
          { role: "user", content: "hi", embedding: [0.1, 0.2, 0.3] },
          { role: "assistant", content: "yo", embedding: [0.1, 0.25, 0.3] },
          { role: "user", content: "other", embedding: [0.9, 0.8, 0.7] }
        ];
      }
    },
    $queryRawUnsafe: async () => {
      throw new Error("pgvector not enabled");
    }
  };
  
  // Temporarily replace prisma in main
  const originalPrisma = mainModule.prisma;
  (mainModule as any).prisma = prismaMock;

  const similar = await getSemanticSimilarHistory("919999999999", queryText);
  assert.equal(similar.length, 3);
  // First item should be the closest matching ("hi" with embedding closest to query embedding)
  assert.equal(similar[0].content, "hi");
  assert.equal(similar[1].content, "yo");

  (mainModule as any).prisma = originalPrisma;
});

// 5. ADAPTIVE LANGUAGE MATCHING
test('v5.0 Adaptive Language Matching - transitions into Hinglish dynamic prompt', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEYS = "key1,key2,key3,key4";

  let capturedSystemPrompt = "";

  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options?.body as string);
    capturedSystemPrompt = body.systemInstruction?.parts?.[0]?.text || "";
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Kya chal raha hai bhai?" }] } }]
      })
    } as any;
  };

  // Trigger generator with a Hinglish prompt
  await generateAiResponse("kya chal rha h bhai", [], "Friend", "919999999999", false);
  
  assert.match(capturedSystemPrompt, /LANGUAGE MATCHING: The user is communicating in Hinglish\./);
  assert.match(capturedSystemPrompt, /respond in fluid Hinglish/);
});

// 6. REAL-TIME INGESTION & TRIPARTITE ROLE SEPARATION
test('v5.0 Real-Time Ingestion - classifies and saves user, host, and bot roles', async () => {
  mainModule.setPrismaConnected(true);

  const prismaSavedRows: any[] = [];
  const mockPrisma = {
    userHistory: {
      create: async (args: any) => {
        prismaSavedRows.push(args.data);
        return { id: "mock-id" };
      }
    }
  };

  const originalPrisma = mainModule.prisma;
  (mainModule as any).prisma = mockPrisma;

  // Mock getEmbedding
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        embedding: { values: [0.1, 0.2, 0.3] }
      })
    } as any;
  };

  // Test 1: Inbound message -> role = 'user'
  await addUserHistory("919999999999", "user", "inbound text");
  assert.equal(prismaSavedRows.length, 1);
  assert.equal(prismaSavedRows[0].role, "user");
  assert.equal(prismaSavedRows[0].content, "inbound text");

  // Test 2: Outbound manual message -> role = 'host'
  await addUserHistory("919999999999", "host", "manual text");
  assert.equal(prismaSavedRows.length, 2);
  assert.equal(prismaSavedRows[1].role, "host");
  assert.equal(prismaSavedRows[1].content, "manual text");

  // Test 3: Outbound automated bot message -> role = 'bot'
  await addUserHistory("919999999999", "bot", "bot reply");
  assert.equal(prismaSavedRows.length, 3);
  assert.equal(prismaSavedRows[2].role, "bot");
  assert.equal(prismaSavedRows[2].content, "bot reply");

  (mainModule as any).prisma = originalPrisma;
});

