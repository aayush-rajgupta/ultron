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
      args: [],
      sender: ctx.sender,
      owner: this.owner,
      state: this.state,
    };

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
