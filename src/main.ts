import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  WASocket,
} from '@whiskeysockets/baileys';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils';
import { useMultiFileAuthState } from '@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';

// Save original console functions
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const originalInfo = console.info;

// ANSI color codes
const colors = {
  gray: '\x1b[90m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
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
    originalLog(`${timeStr} ${catStr} ${message}`, ...args);
  },
  system(message: string, ...args: any[]) { this.log('SYSTEM', message, ...args); },
  whatsapp(message: string, ...args: any[]) { this.log('WHATSAPP', message, ...args); },
  command(message: string, ...args: any[]) { this.log('COMMAND', message, ...args); },
  warn(message: string, ...args: any[]) { this.log('WARNING', message, ...args); },
  error(message: string, ...args: any[]) { this.log('ERROR', message, ...args); }
};

// Global tracking for recent session JID
let lastSessionJid: string | undefined;
let lastLoggedResyncTime = 0;
let lastLoggedDecryptErrorTime = 0;

function safeStringify(arg: any): string {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return arg.message + '\n' + arg.stack;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function handleNoisyLog(message: string) {
  const now = Date.now();
  const target = lastSessionJid ? lastSessionJid.split('@')[0] : 'unknown';

  if (message.includes('Closing open session') || message.includes('Closing session:')) {
    if (now - lastLoggedResyncTime > 2000) {
      customLogger.whatsapp(`Session resync for ${target}`);
      lastLoggedResyncTime = now;
    }
  } else if (message.includes('Bad MAC') || message.includes('Failed to decrypt message') || message.includes('Session error')) {
    if (now - lastLoggedDecryptErrorTime > 2000) {
      customLogger.whatsapp(`Decryption recovery (Bad MAC) for ${target}`);
      lastLoggedDecryptErrorTime = now;
    }
  }
}

// Override console methods to filter libsignal noise
console.log = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (
    combined.includes('Bad MAC') ||
    combined.includes('Failed to decrypt message') ||
    combined.includes('Closing open session') ||
    combined.includes('Closing session:') ||
    combined.includes('SessionEntry')
  ) {
    handleNoisyLog(combined);
    return;
  }
  originalLog(...args);
};

console.warn = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (
    combined.includes('Bad MAC') ||
    combined.includes('Failed to decrypt message') ||
    combined.includes('Closing open session') ||
    combined.includes('Closing session:') ||
    combined.includes('SessionEntry')
  ) {
    handleNoisyLog(combined);
    return;
  }
  originalWarn(...args);
};

console.info = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (
    combined.includes('Bad MAC') ||
    combined.includes('Failed to decrypt message') ||
    combined.includes('Closing open session') ||
    combined.includes('Closing session:') ||
    combined.includes('SessionEntry')
  ) {
    handleNoisyLog(combined);
    return;
  }
  originalInfo(...args);
};

console.error = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (
    combined.includes('Bad MAC') ||
    combined.includes('Failed to decrypt message') ||
    combined.includes('Closing open session') ||
    combined.includes('Closing session:') ||
    combined.includes('SessionEntry')
  ) {
    handleNoisyLog(combined);
    return;
  }
  originalError(...args);
};

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ultron' } } });
const redis = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: false,
    ...(redisUrl.startsWith('rediss://') ? { tls: true } : {}),
  },
});

let initialized = false;
let socket: WASocket | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnecting = false;
let authState: any | undefined;
let activeSocketId = 0;
let messagesReceived = 0;
let processedMessageIds = new Set<string>();
const bootTimestampMs = Date.now();

function ensureDirectories(): void {
  const authDir = path.join(process.cwd(), 'auth');
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }
}

async function initRedis(): Promise<void> {
  redis.on('error', () => undefined);
  await redis.connect();
}

async function initializeServices(): Promise<void> {
  if (initialized) return;
  initialized = true;

  ensureDirectories();
  try {
    await prisma.$connect();
    customLogger.system('Prisma connected');
  } catch (error) {
    customLogger.warn('Prisma unavailable, continuing without DB', error);
  }

  try {
    await initRedis();
    customLogger.system('Redis connected');
  } catch (error) {
    customLogger.warn('Redis unavailable, continuing without Redis', error);
  }
}

function formatUptime(seconds: number): string {
  const totalSeconds = Math.floor(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (secs > 0 || parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function extractText(message: any): string {
  return (
    message?.message?.conversation
    ?? message?.message?.extendedTextMessage?.text
    ?? message?.message?.imageMessage?.caption
    ?? message?.message?.videoMessage?.caption
    ?? ''
  ).trim();
}

async function getPrismaStatus(): Promise<string> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

async function getRedisStatus(): Promise<string> {
  try {
    await redis.ping();
    return 'connected';
  } catch {
    return 'disconnected';
  }
}

// FIX 1: Detect Uint8Array (not just Buffer) — Baileys' signal key material is often
// plain Uint8Array, and Buffer.isBuffer() misses those, causing silent corruption.
// Using standard function replacer to intercept Buffers before .toJSON() gets called.
function serializeAuthValue(value: unknown): string {
  return JSON.stringify(value, function (key, item) {
    if (this[key] instanceof Uint8Array) {
      return { __type: 'Buffer', data: Buffer.from(this[key]).toString('base64') };
    }
    return item;
  });
}

function deserializeAuthValue(value: string): any {
  return JSON.parse(value, (_key, item) => {
    if (item && typeof item === 'object') {
      if (item.__type === 'Buffer' && typeof item.data === 'string') {
        return Buffer.from(item.data, 'base64');
      }
      if (item.type === 'Buffer' && Array.isArray(item.data)) {
        return Buffer.from(item.data);
      }
    }
    return item;
  });
}

async function readAuthStateEntry(key: string): Promise<any | null> {
  const record = await prisma.authState.findUnique({ where: { key } });
  if (!record) return null;
  return deserializeAuthValue(record.value);
}

async function writeAuthStateEntry(key: string, value: unknown): Promise<void> {
  await prisma.authState.upsert({
    where: { key },
    update: { value: serializeAuthValue(value) },
    create: { key, value: serializeAuthValue(value) },
  });
}

async function removeAuthStateEntry(key: string): Promise<void> {
  await prisma.authState.deleteMany({ where: { key } });
}

function validateCredsBuffer(obj: any, path: string) {
  if (!obj) return;
  if (typeof obj === 'object' && !(obj instanceof Uint8Array || Buffer.isBuffer(obj))) {
    throw new Error(`Sanity Check Failure: Creds path "${path}" is a plain Object, not a Buffer/Uint8Array.`);
  }
}

function sanityCheckCreds(creds: any) {
  if (!creds) return;
  validateCredsBuffer(creds.noiseKey?.private, 'noiseKey.private');
  validateCredsBuffer(creds.noiseKey?.public, 'noiseKey.public');
  validateCredsBuffer(creds.pairingEphemeralKeyPair?.private, 'pairingEphemeralKeyPair.private');
  validateCredsBuffer(creds.pairingEphemeralKeyPair?.public, 'pairingEphemeralKeyPair.public');
  validateCredsBuffer(creds.signedIdentityKey?.private, 'signedIdentityKey.private');
  validateCredsBuffer(creds.signedIdentityKey?.public, 'signedIdentityKey.public');
  validateCredsBuffer(creds.signedPreKey?.keyPair?.private, 'signedPreKey.keyPair.private');
  validateCredsBuffer(creds.signedPreKey?.keyPair?.public, 'signedPreKey.keyPair.public');
}

async function createPrismaAuthState(): Promise<any> {
  const localAuthState = await useMultiFileAuthState(path.join(process.cwd(), 'auth'));
  const persistedCreds = await readAuthStateEntry('creds');
  const creds = persistedCreds ?? localAuthState.state.creds ?? initAuthCreds();

  // Sanity check loaded/initialized credentials
  try {
    sanityCheckCreds(creds);
  } catch (err: any) {
    customLogger.error('Creds verification failed!', err);
    throw err;
  }

  if (!persistedCreds) {
    await writeAuthStateEntry('creds', creds);
  }

  // FIX 3: state object is defined first so saveCreds can reference the LIVE
  // state.creds rather than closing over a possibly-stale local variable.
  const state = {
    creds,
    keys: {
      get: async (type: string, ids: string[]) => {
        if (type === 'session' && ids.length > 0) {
          lastSessionJid = ids[0];
        }
        const data: Record<string, any> = {};
        await Promise.all(ids.map(async (id) => {
          const dbKey = `${type}:${id}`;
          let value = await readAuthStateEntry(dbKey);
          if (!value) {
            const fallback = await localAuthState.state.keys.get(type as any, [id]);
            value = fallback[id];
            if (value) {
              await writeAuthStateEntry(dbKey, value);
            }
          }
          // FIX 2: app-state-sync-key entries must be reconstructed as proto
          // instances, not left as plain deserialized objects.
          if (value && type === 'app-state-sync-key') {
            value = proto.Message.AppStateSyncKeyData.fromObject(value);
          }
          data[id] = value ?? null;
        }));
        return data;
      },
      set: async (data: Record<string, Record<string, unknown>>) => {
        const tasks: Promise<void>[] = [];
        for (const category in data) {
          for (const id in data[category]) {
            const value = data[category][id];
            const dbKey = `${category}:${id}`;
            tasks.push(value ? writeAuthStateEntry(dbKey, value) : removeAuthStateEntry(dbKey));
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  return {
    state,
    saveCreds: async () => {
      await writeAuthStateEntry('creds', state.creds);
    },
  };
}

async function routeMessage(message: any): Promise<void> {
  const messageTimestampMs = Number(message?.messageTimestamp) * 1000;
  const messageId = message?.key?.id;
  if (messageId && processedMessageIds.has(messageId)) {
    return;
  }
  if (messageTimestampMs && messageTimestampMs < bootTimestampMs) {
    return;
  }
  if (messageId) {
    processedMessageIds.add(messageId);
  }

  messagesReceived += 1;
  const text = extractText(message);
  const fromMe = message?.key?.fromMe === true;

  if (fromMe) {
    if (!text.startsWith('!')) {
      return;
    }

    const command = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';
    const chatJid = message?.key?.remoteJid ?? message?.key?.participant;
    if (!chatJid || !socket) return;

    const startedAt = Date.now();
    const placeholder = `⏳ Running !${command}...`;
    const sentMessage = await socket.sendMessage(chatJid, { text: placeholder });
    const editKey = sentMessage?.key;

    let success = false;
    try {
      switch (command) {
        case 'ping': {
          const latencyMs = Date.now() - startedAt;
          const finalText = `*Pong!* ${latencyMs}ms`;
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        case 'alive': {
          const [prismaStatus, redisStatus] = await Promise.all([getPrismaStatus(), getRedisStatus()]);
          const uptime = formatUptime(process.uptime());
          const finalText = [`*ULTRON is alive* 🟢`, `Uptime: ${uptime}`, `Database: ${prismaStatus}`, `Cache: ${redisStatus}`].join('\n');
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        case 'uptime': {
          const finalText = `*Uptime*\n${formatUptime(process.uptime())}`;
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        case 'stats': {
          const [prismaStatus, redisStatus] = await Promise.all([getPrismaStatus(), getRedisStatus()]);
          const usage = process.memoryUsage();
          const finalText = [
            '*System Stats*',
            `⏱ Uptime: ${formatUptime(process.uptime())}`,
            `💾 Memory: ${Math.round(usage.rss / 1024 / 1024)}MB RSS (${Math.round(usage.heapUsed / 1024 / 1024)}MB/${Math.round(usage.heapTotal / 1024 / 1024)}MB heap)`,
            `🗄 Database: ${prismaStatus}`,
            `⚡ Cache: ${redisStatus}`,
            `📩 Messages received: ${messagesReceived}`,
          ].join('\n');
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        case 'help': {
          const finalText = [
            '*Available Commands*',
            '- !ping — check latency',
            '- !alive — bot status',
            '- !uptime — time since boot',
            '- !stats — system stats',
            '- !help — this list',
            '- !update — check for updates (not yet implemented)',
          ].join('\n');
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        case 'update': {
          const finalText = 'Update check not yet implemented — coming in a later phase.';
          if (editKey) {
            await socket.sendMessage(chatJid, { text: finalText, edit: editKey });
          }
          success = true;
          break;
        }
        default: {
          break;
        }
      }

      if (success) {
        const duration = Date.now() - startedAt;
        const senderName = message.pushName ?? message.key.participant?.split('@')[0] ?? chatJid.split('@')[0] ?? 'Me';
        customLogger.command(`!${command} from ${senderName} (${duration}ms)`);
      }
    } catch (error) {
      const duration = Date.now() - startedAt;
      const senderName = message.pushName ?? message.key.participant?.split('@')[0] ?? chatJid.split('@')[0] ?? 'Me';
      customLogger.error(`Command !${command} from ${senderName} failed after ${duration}ms`, error);
    }
    return;
  }

  const sender = message?.key?.remoteJid ?? 'unknown';
  const cleanSender = sender.split('@')[0];
  customLogger.whatsapp(`Incoming from ${cleanSender}: ${text}`);
}

async function closeExistingSocket(): Promise<void> {
  if (!socket) return;
  const currentSocket = socket;
  socket = undefined;
  reconnecting = false;
  activeSocketId += 1;
  try {
    currentSocket.ev.removeAllListeners('connection.update');
    currentSocket.ev.removeAllListeners('creds.update');
    currentSocket.ev.removeAllListeners('messages.upsert');
  } catch {
    // ignore listener cleanup errors
  }
  try {
    (currentSocket as unknown as { ws?: { close?: () => void } }).ws?.close?.();
  } catch {
    // ignore close errors during teardown
  }
}

async function startSocket(): Promise<void> {
  try {
    if (reconnecting) return;
    reconnecting = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    await initializeServices();

    if (socket) {
      await closeExistingSocket();
    }

    const thisSocketId = ++activeSocketId;
    customLogger.system('Starting ULTRON WhatsApp session...');
    if (!authState) {
      authState = await createPrismaAuthState();
    }
    const { state, saveCreds } = authState;
    const { version } = await fetchLatestBaileysVersion();
    const currentSocket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('ULTRON'),
      syncFullHistory: false,
    });
    socket = currentSocket;

    currentSocket.ev.on('connection.update', async (update: any) => {
      if (thisSocketId !== activeSocketId || socket !== currentSocket) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        qrcode.generate(qr, { small: true });
        customLogger.whatsapp('Scan this QR with WhatsApp to log in.');
      }

      if (connection === 'close') {
        const statusCode = (lastDisconnect?.error as any)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        customLogger.whatsapp(`Connection closed: ${statusCode}. Reconnecting: ${shouldReconnect}`);
        customLogger.error('Full disconnect error:', lastDisconnect?.error);
        reconnecting = false;
        if (shouldReconnect && !reconnectTimer) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            if (thisSocketId === activeSocketId && socket === currentSocket) {
              void startSocket();
            }
          }, 2000);
        }
      }

      if (connection === 'open') {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        reconnecting = false;
        customLogger.whatsapp('Connected');
      }
    });

    currentSocket.ev.on('creds.update', saveCreds);

    currentSocket.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      if (type !== 'notify') {
        return;
      }
      for (const message of messages) {
        if (!message.message) continue;
        await routeMessage(message);
      }
    });
  } catch (error) {
    customLogger.error('startSocket failed with error', error);
    reconnecting = false;
    throw error;
  }
}

startSocket().catch((error) => {
  customLogger.error('Startup failed', error);
  process.exit(1);
});