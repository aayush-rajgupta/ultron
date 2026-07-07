import { customLogger } from '../main';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const FIRST_CONTACT_SYSTEM_PROMPT = `You are ULTRON v3.0, an automated AI assistant userbot for Aayush Raj Gupta.
CRITICAL RULE 1: You MUST start your response with exactly this phrase: 'Hi, this is ULTRON v3.0, Aayush Raj Gupta's AI assistant userbot.'
CRITICAL RULE 2: After the introduction, politely explain in one short sentence that Aayush is currently occupied, and ask them to leave a message.
CRITICAL RULE 3: Inform them that if it is a life-or-death emergency, they can reply with '!urgent' to send an instant alert to his phone.
CRITICAL RULE 4: ABSOLUTELY ZERO EMOJIS. You are strictly forbidden from using any emojis at all in this first message.`;

const SYSTEM_PROMPT = `You are ULTRON, Aayush Raj Gupta's AI assistant.
 - Emojis: NO EMOJIS. You are strictly forbidden from using any emojis whatsoever.
 - Length Limit: Your responses must never exceed 1 or 2 short sentences.
 - Tone: Neutral, direct, and slightly professional. Do not act friendly.
 - Context: You are ULTRON, Aayush Raj Gupta's AI assistant. If asked where he is, use the "FACTS ABOUT AAYUSH" to inform your brief answer.
 - EMERGENCY PROTOCOL: If the user states they are in a real emergency, life-or-death situation, or urgently need to reach Aayush, you MUST instruct them to reply with the exact word '!urgent'. This will trigger a direct alarm to his phone.`;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGemini(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const systemMsg = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT;
  const systemInstructionPart = {
    parts: [{ text: systemMsg }]
  };
  const contents = messages
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }]
    }));

  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: systemInstructionPart,
        contents
      })
    }
  );
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Empty or invalid candidate response");
  return text;
}

async function callOpenAI(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callClaude(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
  const systemMsg = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT;
  const filteredMessages = messages
    .filter(msg => msg.role !== 'system')
    .map(msg => ({
      role: msg.role === 'assistant' ? 'assistant' : 'user',
      content: msg.content
    }));

  const response = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-3-5-sonnet-latest',
      max_tokens: 4096,
      system: systemMsg,
      messages: filteredMessages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.content?.[0]?.text;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callOpenRouter(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://github.com/aayush-rajgupta/ultron',
      'X-Title': 'Ultron'
    },
    body: JSON.stringify({
      model: 'meta-llama/llama-3.1-8b-instruct',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callDeepSeek(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callGroq(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callMistral(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  const response = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

async function callCohere(messages: ChatMessage[]): Promise<string> {
  const apiKey = process.env.COHERE_API_KEY;
  const response = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'command-r-plus',
      messages
    })
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  }
  const data = await response.json() as any;
  const text = data.message?.content?.[0]?.text;
  if (!text) throw new Error("Empty or invalid response content");
  return text;
}

export async function generateAiResponse(
  prompt: string,
  historyOrOnTransition?: any,
  onTransitionOrPushName?: any,
  phoneNumber?: string,
  isFirstContact?: boolean
): Promise<{ text: string; providerUsed: string }> {
  let history: ChatMessage[] = [];
  let onTransitionFn: ((status: string) => Promise<void>) | undefined = undefined;
  let currentPushName = '';
  let currentPhoneNumber = '';

  if (Array.isArray(historyOrOnTransition)) {
    history = historyOrOnTransition;
    if (typeof onTransitionOrPushName === 'string') {
      currentPushName = onTransitionOrPushName;
      currentPhoneNumber = phoneNumber || '';
    } else if (typeof onTransitionOrPushName === 'function') {
      onTransitionFn = onTransitionOrPushName;
    }
  } else if (typeof historyOrOnTransition === 'function') {
    onTransitionFn = historyOrOnTransition;
  }

  const { getMasterKnowledge } = await import('./memory');
  const masterKnowledge = await getMasterKnowledge();

  let systemPrompt = isFirstContact === true ? FIRST_CONTACT_SYSTEM_PROMPT : SYSTEM_PROMPT;
  if (masterKnowledge) {
    systemPrompt += `\n\nFACTS ABOUT AAYUSH: ${masterKnowledge}`;
  }
  if (currentPushName && currentPhoneNumber) {
    systemPrompt += `\n\nCURRENT CONTEXT: You are talking to a human named ${currentPushName} (Phone: ${currentPhoneNumber}).`;
  }

  // Prepend system prompt to the messages list
  const fullMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...history,
    { role: 'user', content: prompt }
  ];

  const priorityStr = process.env.AI_PROVIDER_PRIORITY || "Gemini,OpenAI,Claude,OpenRouter,DeepSeek,Groq,Mistral,Cohere";
  const priorityList = priorityStr.split(",").map(p => p.trim()).filter(Boolean);
  const failures: { provider: string; error: string }[] = [];

  for (let i = 0; i < priorityList.length; i++) {
    const providerRaw = priorityList[i];
    const providerNormalized = providerRaw.toLowerCase();

    let providerName = providerRaw;
    let apiKeyVar = "";
    let callFn: () => Promise<string> = async () => "";

    if (providerNormalized === 'gemini') {
      providerName = "Gemini";
      apiKeyVar = "GEMINI_API_KEY";
      callFn = () => callGemini(fullMessages);
    } else if (providerNormalized === 'openai') {
      providerName = "OpenAI";
      apiKeyVar = "OPENAI_API_KEY";
      callFn = () => callOpenAI(fullMessages);
    } else if (providerNormalized === 'claude') {
      providerName = "Claude";
      apiKeyVar = "ANTHROPIC_API_KEY";
      callFn = () => callClaude(fullMessages);
    } else if (providerNormalized === 'openrouter') {
      providerName = "OpenRouter";
      apiKeyVar = "OPENROUTER_API_KEY";
      callFn = () => callOpenRouter(fullMessages);
    } else if (providerNormalized === 'deepseek') {
      providerName = "DeepSeek";
      apiKeyVar = "DEEPSEEK_API_KEY";
      callFn = () => callDeepSeek(fullMessages);
    } else if (providerNormalized === 'groq') {
      providerName = "Groq";
      apiKeyVar = "GROQ_API_KEY";
      callFn = () => callGroq(fullMessages);
    } else if (providerNormalized === 'mistral') {
      providerName = "Mistral";
      apiKeyVar = "MISTRAL_API_KEY";
      callFn = () => callMistral(fullMessages);
    } else if (providerNormalized === 'cohere') {
      providerName = "Cohere";
      apiKeyVar = "COHERE_API_KEY";
      callFn = () => callCohere(fullMessages);
    } else {
      customLogger.error(`Unknown AI provider specified in priority list: ${providerRaw}`);
      failures.push({ provider: providerRaw, error: "Unknown provider name" });
      continue;
    }

    const nextProviderRaw = priorityList[i + 1];
    const nextProviderName = nextProviderRaw ? nextProviderRaw.trim() : "";

    // 1. Send/update thinking placeholder
    if (onTransitionFn) {
      await onTransitionFn(`⏳ [${providerName}] Thinking...`);
    }

    // 2. Check API Key
    const apiKey = process.env[apiKeyVar];
    if (!apiKey) {
      customLogger.error(`AI failover: ${providerName} key missing.`);
      failures.push({ provider: providerName, error: "API key missing" });

      if (onTransitionFn && nextProviderName) {
        await onTransitionFn(`⏳ [${providerName}] API key missing. Trying ${nextProviderName}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      continue;
    }

    // 3. Make the API Call
    try {
      const text = await callFn();
      return { text, providerUsed: providerName };
    } catch (err: any) {
      const errMsg = err.message || String(err);
      customLogger.error(`AI failover: ${providerName} failed: ${errMsg}`);
      failures.push({ provider: providerName, error: errMsg });

      if (onTransitionFn && nextProviderName) {
        await onTransitionFn(`⏳ [${providerName}] Rate-limited. Trying ${nextProviderName}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  const errorHeader = "❌ *AI Failover Engine: All Providers Failed*";
  const details = failures.map(f => `- *${f.provider}*: ${f.error}`).join("\n");
  throw new Error(`${errorHeader}\n\n${details}`);
}
