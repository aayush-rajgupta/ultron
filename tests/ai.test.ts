import test from 'node:test';
import assert from 'node:assert/strict';
import { PluginRuntime, generateAiResponse } from '../src/plugins';

// Backup original environment and fetch
const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

test.afterEach(() => {
  process.env = { ...originalEnv };
  globalThis.fetch = originalFetch;
});

test('generateAiResponse - success on first provider (Gemini)', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini,OpenAI";
  process.env.GEMINI_API_KEY = "mock-gemini-key";
  process.env.OPENAI_API_KEY = "mock-openai-key";

  const transitions: string[] = [];
  const onTransition = async (status: string) => {
    transitions.push(status);
  };

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      return {
        ok: true,
        json: async () => ({
          candidates: [{ content: { parts: [{ text: "Hello from Gemini!" }] } }]
        })
      } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateAiResponse("test prompt", onTransition);
  assert.equal(res.text, "Hello from Gemini!");
  assert.equal(res.providerUsed, "Gemini");
  assert.deepEqual(transitions, [
    "⏳ [Gemini] Thinking..."
  ]);
});

test('generateAiResponse - failover from Gemini to OpenAI', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini,OpenAI";
  process.env.GEMINI_API_KEY = "mock-gemini-key";
  process.env.OPENAI_API_KEY = "mock-openai-key";

  const transitions: string[] = [];
  const onTransition = async (status: string) => {
    transitions.push(status);
  };

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('generativelanguage.googleapis.com')) {
      return {
        ok: false,
        status: 429,
        text: async () => "Rate limit exceeded"
      } as any;
    }
    if (urlStr.includes('api.openai.com')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hello from OpenAI!" } }]
        })
      } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateAiResponse("test prompt", onTransition);
  assert.equal(res.text, "Hello from OpenAI!");
  assert.equal(res.providerUsed, "OpenAI");
  assert.deepEqual(transitions, [
    "⏳ [Gemini] Thinking...",
    "⏳ [Gemini] Rate-limited. Trying OpenAI...",
    "⏳ [OpenAI] Thinking..."
  ]);
});

test('generateAiResponse - skip provider if API key is missing', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini,OpenAI";
  delete process.env.GEMINI_API_KEY;
  process.env.OPENAI_API_KEY = "mock-openai-key";

  const transitions: string[] = [];
  const onTransition = async (status: string) => {
    transitions.push(status);
  };

  globalThis.fetch = async (url, options) => {
    const urlStr = typeof url === 'string' ? url : url.toString();
    if (urlStr.includes('api.openai.com')) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Hello from OpenAI after skip!" } }]
        })
      } as any;
    }
    throw new Error("Unexpected URL: " + urlStr);
  };

  const res = await generateAiResponse("test prompt", onTransition);
  assert.equal(res.text, "Hello from OpenAI after skip!");
  assert.equal(res.providerUsed, "OpenAI");
  assert.deepEqual(transitions, [
    "⏳ [Gemini] Thinking...",
    "⏳ [Gemini] API key missing. Trying OpenAI...",
    "⏳ [OpenAI] Thinking..."
  ]);
});

test('generateAiResponse - all providers fail', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini,OpenAI";
  process.env.GEMINI_API_KEY = "mock-gemini-key";
  process.env.OPENAI_API_KEY = "mock-openai-key";

  globalThis.fetch = async (url, options) => {
    return {
      ok: false,
      status: 500,
      text: async () => "Internal server error"
    } as any;
  };

  await assert.rejects(
    async () => {
      await generateAiResponse("test prompt");
    },
    (err: Error) => {
      assert.match(err.message, /All Providers Failed/);
      assert.match(err.message, /- \*Gemini\*: HTTP 500: Internal server error/);
      assert.match(err.message, /- \*OpenAI\*: HTTP 500: Internal server error/);
      return true;
    }
  );
});

test('PluginRuntime - dispatch AI command', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEY = "mock-gemini-key";

  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Hello via dispatch!" }] } }]
      })
    } as any;
  };

  const runtime = new PluginRuntime("owner");
  const response = await runtime.dispatch("ai", {
    sender: "owner",
    owner: "owner",
    args: ["say", "hello"]
  } as any);

  assert.match(response, /AI Response \(Gemini\)/);
  assert.match(response, /Hello via dispatch!/);
});

test('PluginRuntime - dispatch AI command usage error', async () => {
  const runtime = new PluginRuntime("owner");
  const response = await runtime.dispatch("ai", {
    sender: "owner",
    owner: "owner",
    args: []
  } as any);

  assert.equal(response, "Usage: !ai <prompt>");
});

test('generateAiResponse - uses FIRST_CONTACT_SYSTEM_PROMPT when isFirstContact is true', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEY = "mock-gemini-key";

  let capturedBody: any = null;
  globalThis.fetch = async (url, options) => {
    const bodyStr = options?.body as string;
    capturedBody = JSON.parse(bodyStr);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Hello!" }] } }]
      })
    } as any;
  };

  await generateAiResponse("test prompt", [], "PushName", "12345", true);
  
  assert.ok(capturedBody);
  const systemInstruction = capturedBody.systemInstruction?.parts?.[0]?.text || "";
  assert.match(systemInstruction, /ULTRON/);
  assert.match(systemInstruction, /exactly one wave emoji/);
  
  await generateAiResponse("test prompt", [], "PushName", "12345", false);
  
  const systemInstruction2 = capturedBody.systemInstruction?.parts?.[0]?.text || "";
  assert.match(systemInstruction2, /NO EMOJIS/);
});

test('generateAiResponse - retrieves and injects master knowledge into system prompt', async () => {
  process.env.AI_PROVIDER_PRIORITY = "Gemini";
  process.env.GEMINI_API_KEY = "mock-gemini-key";

  const { updateMasterKnowledge } = await import('../src/services/memory');
  const { redis } = await import('../src/main');
  
  if (redis.isOpen) {
    await redis.del('ultron:master_knowledge');
  }

  await updateMasterKnowledge("Aayush is a KIIT student.");

  let capturedBody: any = null;
  globalThis.fetch = async (url, options) => {
    const bodyStr = options?.body as string;
    capturedBody = JSON.parse(bodyStr);
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Hello!" }] } }]
      })
    } as any;
  };

  await generateAiResponse("test prompt", [], "PushName", "12345", false);
  
  assert.ok(capturedBody);
  const systemInstruction = capturedBody.systemInstruction?.parts?.[0]?.text || "";
  assert.match(systemInstruction, /FACTS ABOUT AAYUSH: Aayush is a KIIT student\./);

  if (redis.isOpen) {
    await redis.del('ultron:master_knowledge');
  }
});


