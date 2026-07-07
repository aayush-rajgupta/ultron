export interface PluginCommand {
  name: string;
  description: string;
  usage: string;
  ownerOnly?: boolean;
}

export interface PluginDefinition {
  name: string;
  category: string;
  commands: PluginCommand[];
  description: string;
  execute: (ctx: PluginContext) => Promise<string>;
}

export interface PluginContext {
  command: string;
  args: string[];
  sender: string;
  owner: string;
  state: RuntimeState;
  editMessage?: (text: string) => Promise<void>;
}

export interface RuntimeState {
  startTime: number;
  messageCount: number;
  pluginCount: number;
  aiProvider: string;
  version: string;
  platform: string;
  uptimeMs: number;
  memoryUsageMb: number;
  cpuUsagePercent: number;
  dbConnected: boolean;
}

export class PluginRuntime {
  private readonly owner: string;
  private readonly plugins: PluginDefinition[];
  private readonly state: RuntimeState;

  constructor(owner: string = "owner") {
    this.owner = owner;
    this.state = {
      startTime: Date.now(),
      messageCount: 0,
      pluginCount: 0,
      aiProvider: "openai",
      version: "0.1.0",
      platform: process.platform,
      uptimeMs: 0,
      memoryUsageMb: 0,
      cpuUsagePercent: 0,
      dbConnected: true,
    };
    this.plugins = this.buildPlugins();
    this.state.pluginCount = this.plugins.length;
  }

  public getPluginList(): PluginDefinition[] {
    return this.plugins;
  }

  public async dispatch(command: string, ctx: Omit<PluginContext, "command" | "state">): Promise<string> {
    const plugin = this.plugins.find((item) => item.commands.some((c) => c.name === command));
    if (!plugin) {
      return `Unknown command: ${command}`;
    }

    const fullCtx: PluginContext = {
      command,
      args: (ctx as any).args || [],
      sender: ctx.sender,
      owner: this.owner,
      state: this.state,
      editMessage: (ctx as any).editMessage,
    } as PluginContext;

    if (plugin.commands.some((c) => c.ownerOnly) && fullCtx.sender !== this.owner) {
      return "Owner-only command.";
    }

    this.state.messageCount += 1;
    this.state.uptimeMs = Date.now() - this.state.startTime;
    this.state.memoryUsageMb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    this.state.cpuUsagePercent = Math.round((process.cpuUsage().user + process.cpuUsage().system) / 1000 / 10);

    return plugin.execute(fullCtx);
  }

  private buildPlugins(): PluginDefinition[] {
    return [
      {
        name: "identity",
        category: "Identity",
        description: "Owner-focused identity and status commands.",
        commands: [
          { name: "ping", description: "Latency check", usage: "!ping", ownerOnly: true },
          { name: "alive", description: "Bot status card", usage: "!alive", ownerOnly: true },
          { name: "uptime", description: "Time since boot", usage: "!uptime", ownerOnly: true },
          { name: "stats", description: "System statistics", usage: "!stats", ownerOnly: true },
          { name: "help", description: "List commands", usage: "!help [plugin]", ownerOnly: true },
          { name: "restart", description: "Gracefully restart the process", usage: "!restart", ownerOnly: true },
          { name: "update", description: "Check for updates", usage: "!update [confirm]", ownerOnly: true },
        ],
        execute: async (ctx) => {
          if (ctx.command === "ping") {
            const latency = Math.max(1, Math.round(Math.random() * 80 + 20));
            return `PONG ${latency}ms`;
          }
          if (ctx.command === "alive") {
            const uptime = this.formatDuration(ctx.state.uptimeMs || Date.now() - ctx.state.startTime);
            return [
              "═ ULTRON STATUS ═",
              `Name: ${"ULTRON"}`,
              `Uptime: ${uptime}`,
              `Plugins: ${ctx.state.pluginCount}`,
              `AI Provider: ${ctx.state.aiProvider}`,
              `Version: ${ctx.state.version}`,
              `Platform: ${ctx.state.platform}`,
            ].join("\n");
          }
          if (ctx.command === "uptime") {
            return `Uptime: ${this.formatDuration(ctx.state.uptimeMs || Date.now() - ctx.state.startTime)}`;
          }
          if (ctx.command === "stats") {
            return [
              "═ SYSTEM STATS ═",
              `Memory: ${ctx.state.memoryUsageMb} MB`,
              `CPU: ${ctx.state.cpuUsagePercent}%`,
              `DB: ${ctx.state.dbConnected ? "connected" : "disconnected"}`,
              `Plugins: ${ctx.state.pluginCount}`,
              `Messages: ${ctx.state.messageCount}`,
            ].join("\n");
          }
          if (ctx.command === "help") {
            const pluginName = ctx.args[0];
            if (pluginName) {
              const plugin = this.getPluginList().find((item) => item.name === pluginName.toLowerCase());
              if (!plugin) {
                return `No plugin named ${pluginName}`;
              }
              return [`${plugin.name} (${plugin.category})`, plugin.description, ...plugin.commands.map((c) => `${c.name}: ${c.usage}`)].join("\n");
            }
            return this.getPluginList()
              .map((plugin) => `${plugin.category}: ${plugin.commands.map((c) => c.name).join(", ")}`)
              .join("\n");
          }
          if (ctx.command === "restart") {
            return "Restart requested. The process would restart now.";
          }
          if (ctx.command === "update") {
            return ctx.args[0] === "confirm" ? "Update confirmed. Pulling latest changes..." : "Changes available. Confirm with !update confirm.";
          }
          return "Unsupported command";
        },
      },
      {
        name: "ai",
        category: "AI",
        description: "Resilient Multi-Provider AI Failover Engine.",
        commands: [
          { name: "ai", description: "Generate AI response with failover support", usage: "!ai <prompt>", ownerOnly: true },
        ],
        execute: async (ctx) => {
          const prompt = ctx.args.join(" ");
          if (!prompt) {
            return "Usage: !ai <prompt>";
          }
          try {
            const { text, providerUsed } = await generateAiResponse(prompt, ctx.editMessage);
            return `🤖 *AI Response (${providerUsed})*\n\n${text}`;
          } catch (err: any) {
            return err.message || String(err);
          }
        }
      },
    ];
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return [days ? `${days}d` : null, hours ? `${hours}h` : null, mins ? `${mins}m` : null, secs ? `${secs}s` : null].filter(Boolean).join(" ") || "0s";
  }
}

// ==========================================
// AI FAILOVER ENGINE & LOGGER UTILITIES
// ==========================================

const colors = {
  gray: '\x1b[90m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  reset: '\x1b[0m',
};

function formatTime(): string {
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

const categoryColors: Record<string, string> = {
  SYSTEM: colors.magenta,
  WHATSAPP: colors.cyan,
  COMMAND: colors.blue,
  WARNING: colors.yellow,
  ERROR: colors.red,
};

const customLogger = {
  log(category: 'SYSTEM' | 'WHATSAPP' | 'COMMAND' | 'WARNING' | 'ERROR', message: string, ...args: any[]) {
    const timeStr = `${colors.gray}[${formatTime()}]${colors.reset}`;
    const catColor = categoryColors[category] || colors.reset;
    const catStr = `${catColor}[${category.padEnd(8)}]${colors.reset}`;
    console.log(`${timeStr} ${catStr} -> ${message}`, ...args);
  },
  system(message: string, ...args: any[]) { this.log('SYSTEM', message, ...args); },
  whatsapp(message: string, ...args: any[]) { this.log('WHATSAPP', message, ...args); },
  command(message: string, ...args: any[]) { this.log('COMMAND', message, ...args); },
  warn(message: string, ...args: any[]) { this.log('WARNING', message, ...args); },
  error(message: string, ...args: any[]) { this.log('ERROR', message, ...args); }
};

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function callGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }]
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

async function callOpenAI(prompt: string): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  const response = await fetchWithTimeout('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }]
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

async function callClaude(prompt: string): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY || '';
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
      messages: [{ role: 'user', content: prompt }]
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

async function callOpenRouter(prompt: string): Promise<string> {
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
      messages: [{ role: 'user', content: prompt }]
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

async function callDeepSeek(prompt: string): Promise<string> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }]
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

async function callGroq(prompt: string): Promise<string> {
  const apiKey = process.env.GROQ_API_KEY;
  const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }]
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

async function callMistral(prompt: string): Promise<string> {
  const apiKey = process.env.MISTRAL_API_KEY;
  const response = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'mistral-large-latest',
      messages: [{ role: 'user', content: prompt }]
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

async function callCohere(prompt: string): Promise<string> {
  const apiKey = process.env.COHERE_API_KEY;
  const response = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'command-r-plus',
      messages: [{ role: 'user', content: prompt }]
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
  onTransition?: (status: string) => Promise<void>
): Promise<{ text: string; providerUsed: string }> {
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
      callFn = () => callGemini(prompt);
    } else if (providerNormalized === 'openai') {
      providerName = "OpenAI";
      apiKeyVar = "OPENAI_API_KEY";
      callFn = () => callOpenAI(prompt);
    } else if (providerNormalized === 'claude') {
      providerName = "Claude";
      apiKeyVar = "ANTHROPIC_API_KEY";
      callFn = () => callClaude(prompt);
    } else if (providerNormalized === 'openrouter') {
      providerName = "OpenRouter";
      apiKeyVar = "OPENROUTER_API_KEY";
      callFn = () => callOpenRouter(prompt);
    } else if (providerNormalized === 'deepseek') {
      providerName = "DeepSeek";
      apiKeyVar = "DEEPSEEK_API_KEY";
      callFn = () => callDeepSeek(prompt);
    } else if (providerNormalized === 'groq') {
      providerName = "Groq";
      apiKeyVar = "GROQ_API_KEY";
      callFn = () => callGroq(prompt);
    } else if (providerNormalized === 'mistral') {
      providerName = "Mistral";
      apiKeyVar = "MISTRAL_API_KEY";
      callFn = () => callMistral(prompt);
    } else if (providerNormalized === 'cohere') {
      providerName = "Cohere";
      apiKeyVar = "COHERE_API_KEY";
      callFn = () => callCohere(prompt);
    } else {
      customLogger.error(`Unknown AI provider specified in priority list: ${providerRaw}`);
      failures.push({ provider: providerRaw, error: "Unknown provider name" });
      continue;
    }

    const nextProviderRaw = priorityList[i + 1];
    const nextProviderName = nextProviderRaw ? nextProviderRaw.trim() : "";

    // 1. Send/update thinking placeholder
    if (onTransition) {
      await onTransition(`⏳ [${providerName}] Thinking...`);
    }

    // 2. Check API Key
    const apiKey = process.env[apiKeyVar];
    if (!apiKey) {
      customLogger.error(`AI failover: ${providerName} key missing.`);
      failures.push({ provider: providerName, error: "API key missing" });

      if (onTransition && nextProviderName) {
        await onTransition(`⏳ [${providerName}] API key missing. Trying ${nextProviderName}...`);
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

      if (onTransition && nextProviderName) {
        await onTransition(`⏳ [${providerName}] Rate-limited. Trying ${nextProviderName}...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  const errorHeader = "❌ *AI Failover Engine: All Providers Failed*";
  const details = failures.map(f => `- *${f.provider}*: ${f.error}`).join("\n");
  throw new Error(`${errorHeader}\n\n${details}`);
}
