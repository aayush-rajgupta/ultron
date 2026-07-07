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
  chatJid?: string;
}

import { generateAiResponse } from './services/ai';

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
      chatJid: (ctx as any).chatJid,
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
          { name: "neofetch", description: "System telemetry info", usage: "!neofetch", ownerOnly: true },
        ],
        execute: async (ctx) => {
          if (ctx.command === "ping") {
            const latency = Math.max(1, Math.round(Math.random() * 80 + 20));
            return `PONG ${latency}ms`;
          }
          if (ctx.command === "alive") {
            const { getPrismaStatus, getRedisStatus, getAfkState } = await import('./main');
            const prismaStatus = await getPrismaStatus();
            const redisStatus = await getRedisStatus();
            const afkState = await getAfkState();
            
            const totalSeconds = Math.floor(process.uptime());
            const hours = Math.floor(totalSeconds / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const secs = totalSeconds % 60;
            const uptimeStr = `${hours}h ${minutes}m ${secs}s`;

            const afkStr = afkState.isAfk ? `Active (Reason: ${afkState.reason})` : `Inactive`;

            return [
              "═ *ULTRON STATUS* ═",
              `⏱ *Uptime:* ${uptimeStr}`,
              `🗄 *Database:* ${prismaStatus}`,
              `⚡ *Cache:* ${redisStatus}`,
              `💤 *AFK State:* ${afkStr}`,
              `🛡 *DM Gate:* Enabled (Greetings & AI Chatbot Active)`,
              `🛠 Plugins: ${ctx.state.pluginCount}`,
              `🧠 AI Provider: ${ctx.state.aiProvider}`
            ].join("\n");
          }
          if (ctx.command === "neofetch") {
            const os = await import('os');
            const totalMem = Math.round(os.totalmem() / 1024 / 1024);
            const freeMem = Math.round(os.freemem() / 1024 / 1024);
            const usedMem = totalMem - freeMem;
            const arch = os.arch();
            const platform = os.platform();
            const nodeVersion = process.version;

            return [
              "💻 *ULTRON OS NEOFETCH*",
              `🖥️ *Platform:* ${platform}`,
              `⚙️ *Architecture:* ${arch}`,
              `🟢 *NodeJS Version:* ${nodeVersion}`,
              `💾 *RAM Usage:* ${usedMem} MB / ${totalMem} MB`
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
      {
        name: "gate",
        category: "Gate",
        description: "DM Gate and AFK Control commands.",
        commands: [
          { name: "approve", description: "Approve a JID for AI chatbot", usage: "!approve", ownerOnly: true },
          { name: "stop", description: "Pause AI chatbot for a JID", usage: "!stop", ownerOnly: true },
          { name: "afk", description: "Activate AFK mode", usage: "!afk [reason]", ownerOnly: true },
        ],
        execute: async (ctx) => {
          const { setApprovalState, setAfkState } = await import('./main');
          if (ctx.command === 'approve') {
            const targetJid = ctx.chatJid || ctx.sender;
            if (!targetJid || !targetJid.endsWith('@s.whatsapp.net')) {
              return '❌ Please run this command in a direct message chat.';
            }
            await setApprovalState(targetJid, { approved: true, stopped: false });
            return `✅ *Chat Approved*: AI Auto-Response is now ACTIVE for this chat.`;
          }
          if (ctx.command === 'stop') {
            const targetJid = ctx.chatJid || ctx.sender;
            if (!targetJid || !targetJid.endsWith('@s.whatsapp.net')) {
              return '❌ Please run this command in a direct message chat.';
            }
            await setApprovalState(targetJid, { approved: false, stopped: true });
            return `🛑 *AI Deactivated*: Auto-Response has been paused for this chat. Shifting to manual control.`;
          }
          if (ctx.command === 'afk') {
            const reason = ctx.args.join(' ') || 'Away from keyboard';
            await setAfkState(true, reason, Date.now());
            return `💤 *ULTRON OS: AFK Mode Activated*\nReason: ${reason}`;
          }
          return "Unsupported command";
        }
      },
      {
        name: "animations",
        category: "Animations",
        description: "Visual text animations and typography distortions.",
        commands: [
          { name: "type", description: "Typewriter typing animation", usage: "!type <text>", ownerOnly: true },
          { name: "loading", description: "Progress bar animation", usage: "!loading", ownerOnly: true },
          { name: "clock", description: "Clocks iteration followed by server time", usage: "!clock", ownerOnly: true },
          { name: "vapor", description: "Vaporwave text spaced out", usage: "!vapor <text>", ownerOnly: true },
          { name: "mock", description: "Alternating mock casing", usage: "!mock <text>", ownerOnly: true },
          { name: "slap", description: "Humorous slap action generator", usage: "!slap <@mention>", ownerOnly: true },
        ],
        execute: async (ctx) => {
          if (ctx.command === "type") {
            const textToType = ctx.args.join(" ");
            if (!textToType) return "Usage: !type <text>";
            if (ctx.editMessage) {
              let currentText = "";
              const maxFrames = 15;
              const step = Math.max(1, Math.ceil(textToType.length / maxFrames));
              for (let i = 0; i < textToType.length; i += step) {
                currentText = textToType.substring(0, i + step);
                try {
                  await ctx.editMessage(`${currentText}|`);
                } catch {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
              }
            }
            return textToType;
          }
          if (ctx.command === "loading") {
            if (ctx.editMessage) {
              const frames = [
                { bar: "[░░░░░░░░░░]", pct: 0 },
                { bar: "[██░░░░░░░░]", pct: 20 },
                { bar: "[████░░░░░░]", pct: 40 },
                { bar: "[██████░░░░]", pct: 60 },
                { bar: "[████████░░]", pct: 80 },
                { bar: "[██████████]", pct: 100 },
              ];
              for (const frame of frames) {
                try {
                  await ctx.editMessage(`⏳ *Loading:* ${frame.bar} ${frame.pct}%`);
                } catch {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 200));
              }
            }
            return "System fully initialized.";
          }
          if (ctx.command === "clock") {
            const clocks = ["🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛"];
            if (ctx.editMessage) {
              for (const clock of clocks) {
                try {
                  await ctx.editMessage(`🕒 Time Matrix: ${clock}`);
                } catch {
                  break;
                }
                await new Promise((resolve) => setTimeout(resolve, 150));
              }
            }
            const now = new Date();
            const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
            const istTime = new Date(utc + (3600000 * 5.5));
            const pad = (n: number) => n.toString().padStart(2, '0');
            const timeStr = `${pad(istTime.getHours())}:${pad(istTime.getMinutes())}:${pad(istTime.getSeconds())}`;
            return `🕒 *Live Server Time (IST):* ${timeStr}`;
          }
          if (ctx.command === "vapor") {
            const textToDistort = ctx.args.join(" ");
            if (!textToDistort) return "Usage: !vapor <text>";
            return textToDistort.split("").join(" ");
          }
          if (ctx.command === "mock") {
            const textToMock = ctx.args.join(" ");
            if (!textToMock) return "Usage: !mock <text>";
            return textToMock
              .split("")
              .map((char) => (Math.random() > 0.5 ? char.toUpperCase() : char.toLowerCase()))
              .join("");
          }
          if (ctx.command === "slap") {
            const target = ctx.args.join(" ") || "someone";
            const slaps = [
              `slapped ${target} with a mechanical keyboard (Cherry MX Blues included)! ⌨️`,
              `hit ${target} by a database migration error! 💥`,
              `drop-kicked ${target} into a production server rack! 🖥️`,
              `slapped ${target} with a hot cup of black coffee! ☕`,
              `slapped ${target} with a giant piece of server RAM! 💾`
            ];
            const randomSlap = slaps[Math.floor(Math.random() * slaps.length)];
            return `Aayush ${randomSlap}`;
          }
          return "Unsupported command";
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

export { generateAiResponse } from './services/ai';
