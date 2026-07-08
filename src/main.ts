import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  proto,
  WASocket,
  jidNormalizedUser,
} from '@whiskeysockets/baileys';
import { initAuthCreds } from '@whiskeysockets/baileys/lib/Utils/auth-utils';
import { useMultiFileAuthState } from '@whiskeysockets/baileys/lib/Utils/use-multi-file-auth-state';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { PrismaClient } from '@prisma/client';
import { createClient } from 'redis';
import { PluginRuntime, generateAiResponse } from './plugins';

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

export const customLogger = {
  log(category: 'SYSTEM' | 'WHATSAPP' | 'COMMAND' | 'WARNING' | 'ERROR', message: string, ...args: any[]) {
    const timeStr = `${colors.gray}[${formatTime()}]${colors.reset}`;
    const catColor = categoryColors[category] || colors.reset;
    const catStr = `${catColor}[${category.padEnd(8)}]${colors.reset}`;
    originalLog(`${timeStr} ${catStr} -> ${message}`, ...args);
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

// Save original stdout/stderr write functions
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

function shouldFilter(str: string): boolean {
  return (
    str.includes("MessageCounterError") ||
    str.includes("Session error:") ||
    str.includes("Bad MAC") ||
    str.includes("Decryption recovery") ||
    str.includes("libsignal")
  );
}

process.stdout.write = function (chunk: any, encoding?: any, callback?: any): boolean {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  if (shouldFilter(str)) {
    if (callback) callback();
    return true;
  }
  return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
};

process.stderr.write = function (chunk: any, encoding?: any, callback?: any): boolean {
  const str = typeof chunk === 'string' ? chunk : chunk.toString();
  if (shouldFilter(str)) {
    if (callback) callback();
    return true;
  }
  return originalStderrWrite.call(process.stderr, chunk, encoding, callback);
};

// Override console methods to filter libsignal noise
console.log = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (shouldFilter(combined)) {
    handleNoisyLog(combined);
    return;
  }
  originalLog(...args);
};

console.warn = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (shouldFilter(combined)) {
    handleNoisyLog(combined);
    return;
  }
  originalWarn(...args);
};

console.info = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (shouldFilter(combined)) {
    handleNoisyLog(combined);
    return;
  }
  originalInfo(...args);
};

console.error = (...args: any[]) => {
  const combined = args.map(safeStringify).join(' ');
  if (shouldFilter(combined)) {
    handleNoisyLog(combined);
    return;
  }
  originalError(...args);
};

// Handle process-wide errors silently if they are noisy warnings
process.on('uncaughtException', (err: any) => {
  const errMsg = err?.message || String(err);
  const errStack = err?.stack || '';
  if (shouldFilter(errMsg) || shouldFilter(errStack)) {
    return;
  }
  customLogger.error(`Uncaught Exception: ${errMsg}`, err);
});

process.on('unhandledRejection', (reason: any) => {
  const reasonMsg = reason?.message || String(reason);
  const reasonStack = reason?.stack || '';
  if (shouldFilter(reasonMsg) || shouldFilter(reasonStack)) {
    return;
  }
  customLogger.error(`Unhandled Rejection: ${reasonMsg}`, reason);
});

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
export const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/ultron' } } });
export const redis = createClient({
  url: redisUrl,
  socket: {
    reconnectStrategy: false,
    ...(redisUrl.startsWith('rediss://') ? { tls: true } : {}),
  },
});

let initialized = false;
export let socket: WASocket | undefined;
export function setSocket(s: WASocket | undefined) {
  socket = s;
}
let reconnectTimer: NodeJS.Timeout | undefined;
let reconnecting = false;
let authState: any | undefined;
let activeSocketId = 0;
let messagesReceived = 0;
export let processedMessageIds = new Set<string>();
const bootTimestampMs = Date.now();

export let prismaConnected = false;
export let redisConnected = false;
export let hasSentBootNotification = false;

export function setPrismaConnected(b: boolean) {
  prismaConnected = b;
}
export function setRedisConnected(b: boolean) {
  redisConnected = b;
}

function printBanner(): void {
  const banner = `
${colors.cyan}  _   _ _  _____ ___   ___  _  _ ${colors.reset}
${colors.cyan} | | | | ||_   _| _ \\ / _ \\| \\| |${colors.reset}
${colors.blue} | |_| | |__| | |   /| (_) | .\` |${colors.reset}
${colors.blue}  \\___/|____|_| |_|_\\_\\___/|_|\\_|${colors.reset}
  `;
  originalLog(banner);
}

function printStatusTable(dbStatus: string, redisStatus: string, jid: string): void {
  const envMode = process.env.NODE_ENV === 'production' ? 'Production' : 'Development';
  const dbStr = dbStatus === 'connected' ? 'Connected (Neon)' : 'Disconnected';
  const cacheStr = redisStatus === 'connected' ? 'Connected (Upstash)' : 'Disconnected';
  const userStr = jid || 'Not Authorized';

  const line = (label: string, value: string) => {
    const labelPad = label.padEnd(20);
    const valPad = value.padEnd(31);
    return `│ ${colors.cyan}${labelPad}${colors.reset} │ ${colors.green}${valPad}${colors.reset} │`;
  };

  originalLog(`┌──────────────────────┬─────────────────────────────────┐`);
  originalLog(`│                 ${colors.cyan}SYSTEM INITIALIZATION${colors.reset}                  │`);
  originalLog(`├──────────────────────┼─────────────────────────────────┤`);
  originalLog(line('Version / Env', `v0.1.0 (${envMode})`));
  originalLog(line('Database (Prisma)', dbStr));
  originalLog(line('Cache (Redis)', cacheStr));
  originalLog(line('Connected Account', userStr));
  originalLog(`└──────────────────────┴─────────────────────────────────┘`);
}

export function getPhoneFromJid(jid: string): string {
  const clean = jid.trim();
  const userPart = clean.split('@')[0] || '';
  return userPart.split(':')[0] || clean;
}

export interface ContactInfo {
  rawJid: string;
  phoneNumber: string;
  pushName: string;
}

export function extractContactInfo(message: any): ContactInfo {
  const rawJid = message?.key?.remoteJid || '';
  const userPart = rawJid.split('@')[0] || '';
  const phoneNumber = userPart.split(':')[0] || '';
  const pushName = message?.pushName || 'Stranger';
  return { rawJid, phoneNumber, pushName };
}

export const fallbackChatState = new Map<string, any>();
export const fallbackAfkNotifiedChats = new Set<string>();
export const fallbackGroupCooldowns = new Map<string, number>();
export const botSentMessageIds = new Set<string>();
export const sentGateMessages = new Set<string>();

export async function markBotSentMessage(id: string): Promise<void> {
  if (redisConnected) {
    try {
      await redis.setEx(`ultron:bot_msg:${id}`, 86400, '1');
    } catch (err) {
      customLogger.error('Failed to mark bot sent message in Redis', err);
    }
  }
  botSentMessageIds.add(id);
}

export async function isBotSentMessage(id: string): Promise<boolean> {
  if (botSentMessageIds.has(id)) {
    return true;
  }
  if (redisConnected) {
    try {
      const val = await redis.get(`ultron:bot_msg:${id}`);
      return val !== null;
    } catch (err) {
      customLogger.error('Failed to check bot sent message in Redis', err);
    }
  }
  return false;
}

export async function getAfkNotifiedChats(): Promise<string[]> {
  if (redisConnected) {
    try {
      return await redis.sMembers('ultron:afk_notified_chats');
    } catch (err) {
      customLogger.error('Failed to get AFK notified chats from Redis', err);
    }
  }
  return Array.from(fallbackAfkNotifiedChats);
}

export async function addAfkNotifiedChat(jid: string): Promise<void> {
  if (redisConnected) {
    try {
      await redis.sAdd('ultron:afk_notified_chats', jid);
      return;
    } catch (err) {
      customLogger.error('Failed to add AFK notified chat in Redis', err);
    }
  }
  fallbackAfkNotifiedChats.add(jid);
}

export async function clearAfkNotifiedChats(): Promise<void> {
  if (redisConnected) {
    try {
      await redis.del('ultron:afk_notified_chats');
      return;
    } catch (err) {
      customLogger.error('Failed to clear AFK notified chats in Redis', err);
    }
  }
  fallbackAfkNotifiedChats.clear();
}

export function sanitizeAfkReason(reason: string): string {
  let sanitized = reason;
  const injectionKeywords = [
    /ignore\s+previous/gi,
    /you\s+are\s+now/gi,
    /your\s+new\s+owner/gi,
    /system\s+prompt/gi,
    /system\s+instruction/gi,
    /override\s+rules/gi
  ];
  for (const pat of injectionKeywords) {
    sanitized = sanitized.replace(pat, "[removed]");
  }
  sanitized = sanitized.replace(/[\r\n\t]/g, " ").trim();
  sanitized = sanitized.replace(/[*_~`\[\]()]/g, "");
  return sanitized;
}

export function formatAfkDurationHMS(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

export async function clearAfkIfActive(): Promise<void> {
  const afkState = await getAfkState();
  if (afkState.active) {
    await setAfkState(false, "", 0);
    customLogger.system(JSON.stringify({
      event: "AFK_END",
      reason: "Manual interaction from host"
    }));
    
    const elapsed = Date.now() - afkState.startTime;
    const durationStr = formatAfkDurationHMS(elapsed);
    const endMessage = `✅ AFK mode ended. Total duration: ${durationStr}.`;
    
    const chats = await getAfkNotifiedChats();
    for (const chat of chats) {
      try {
        if (socket) {
          await socket.sendMessage(chat, { text: endMessage });
        }
      } catch (err) {
        customLogger.error(`Failed to send AFK end notification to ${chat}`, err);
      }
    }
    await clearAfkNotifiedChats();
  }
}

export async function getApprovalState(jidOrPhone: string): Promise<{ approved: boolean; stopped: boolean }> {
  const jid = ensureJidSuffix(jidOrPhone);
  const { getChatState } = await import('./services/memory');
  const state = await getChatState(jid);
  return { approved: state.isApproved, stopped: state.isStopped };
}

export async function setApprovalState(jidOrPhone: string, state: { approved: boolean; stopped: boolean }): Promise<void> {
  const jid = ensureJidSuffix(jidOrPhone);
  const { setApprovalStateInState } = await import('./services/memory');
  await setApprovalStateInState(jid, state.approved, state.stopped);
}

// ULTRON v5.0 DIRECTIVE 1: Global AFK Session Manager state
export let memoryAfkState = {
  active: false,
  reason: "Away from keyboard",
  startTime: 0
};

export function getDynamicGreeting(): string {
  // Compute local time in Asia/Kolkata (IST: UTC + 5:30)
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istTime = new Date(utc + (3600000 * 5.5));
  
  const hour = istTime.getHours();
  const minute = istTime.getMinutes();
  const timeVal = hour * 100 + minute;

  if (timeVal >= 500 && timeVal < 1200) {
    return "Good morning";
  } else if (timeVal >= 1200 && timeVal < 1700) {
    return "Good afternoon";
  } else {
    return "Good evening";
  }
}

export async function getAfkState(): Promise<{ active: boolean; isAfk: boolean; reason: string; startTime: number }> {
  if (redisConnected) {
    try {
      const data = await redis.get('ultron:status:global_afk');
      if (data) {
        const parsed = JSON.parse(data);
        const activeVal = parsed.active || parsed.isAfk || false;
        return { active: activeVal, isAfk: activeVal, reason: parsed.reason, startTime: parsed.startTime };
      }
    } catch (err) {
      customLogger.error('Failed to read AFK state from Redis', err);
    }
  }
  const activeVal = memoryAfkState.active;
  return { active: activeVal, isAfk: activeVal, reason: memoryAfkState.reason, startTime: memoryAfkState.startTime };
}

export async function setAfkState(active: boolean, reason: string, startTime: number): Promise<void> {
  const state = { active, isAfk: active, reason, startTime };
  if (redisConnected) {
    try {
      await redis.set('ultron:status:global_afk', JSON.stringify(state));
    } catch (err) {
      customLogger.error('Failed to write AFK state to Redis', err);
    }
  }
  memoryAfkState = { active, reason, startTime };
}

export function formatAfkDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const minsPart = minutes % 60;
  const hoursPart = hours;

  const parts: string[] = [];
  if (hoursPart > 0) {
    parts.push(`${hoursPart} hour${hoursPart > 1 ? 's' : ''}`);
  }
  if (minsPart > 0 || parts.length === 0) {
    parts.push(`${minsPart} minute${minsPart !== 1 ? 's' : ''}`);
  }
  return parts.join(' ');
}

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
    prismaConnected = true;
  } catch (error) {
    // Keep it false
  }

  try {
    await initRedis();
    redisConnected = true;
  } catch (error) {
    // Keep it false
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

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => resolve(fallback), timeoutMs);
  });
  return Promise.race([
    promise.then((val) => {
      if (timeoutId) clearTimeout(timeoutId);
      return val;
    }),
    timeoutPromise,
  ]);
}

export async function getPrismaStatus(): Promise<string> {
  try {
    const query = prisma.$queryRaw`SELECT 1`.then(() => 'connected');
    return await withTimeout(query, 2000, 'timeout');
  } catch {
    return 'disconnected';
  }
}

export async function getRedisStatus(): Promise<string> {
  try {
    const ping = redis.ping().then(() => 'connected');
    return await withTimeout(ping, 2000, 'timeout');
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

export function ensureJidSuffix(jid: string): string {
  try {
    if (!jid || typeof jid !== 'string') return '';
    let clean = jid.trim();
    if (!clean) return '';

    // If it contains c.us, replace with s.whatsapp.net
    if (clean.includes('@c.us')) {
      clean = clean.replace('@c.us', '@s.whatsapp.net');
    }

    // Check if JID has a standard suffix
    if (clean.endsWith('@s.whatsapp.net') || clean.endsWith('@g.us') || clean.endsWith('@lid')) {
      // Strip any device IDs if present (e.g. 12345:1@s.whatsapp.net -> 12345@s.whatsapp.net)
      const parts = clean.split('@');
      const userPart = parts[0].split(':')[0];
      return `${userPart}@${parts[1]}`;
    }

    if (clean.includes('@')) {
      return jidNormalizedUser(clean);
    }

    return `${clean}@s.whatsapp.net`;
  } catch (err) {
    customLogger.warn(`Invalid JID format: "${jid}"`);
    return '';
  }
}

// ULTRON v5.0 DIRECTIVE 3: Data Embargo Middleware
export function detectPrivacyViolation(text: string): boolean {
  const cleanText = text.toLowerCase();
  const patterns = [
    /\b(chat|message|history|profile|info|metadata|detail|log)s?\s+(of|for|about|belonging\s+to|from)\s+(?!me\b)(?!myself\b)(?!my\b)(\+\d{7,15}|\d{7,15}|other|another|someone|john|alice|bob|any\s+other)/i,
    /\b(show|get|retrieve|fetch|view|read|print|export|download)\s+(?!my\b)(?!myself\b)(?!me\b)[a-z0-9\s]*(chat|message|history|profile|info|metadata|detail|log)s?\s+(of|for|about|belonging\s+to|from)\s+([^\s]+)/i,
    /\b(query|select|where)\b.*(user|history|message|profile).*(?!userId\s*=\s*current_session_user_id)/i
  ];
  return patterns.some(p => p.test(cleanText));
}

export async function routeMessage(message: any): Promise<void> {
  const receivedAt = Date.now();
  if (!socket) return;
  const text = extractText(message);
  const fromMe = message?.key?.fromMe === true;
  const msgId = message?.key?.id;

  const botJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : '';
  const ownerJid = process.env.OWNER_JID ? ensureJidSuffix(process.env.OWNER_JID) : botJid;

  const chatJid = message?.key?.remoteJid;
  if (!chatJid) {
    customLogger.system(`[SYSTEM] -> Message skipped: Missing remoteJid`);
    return;
  }
  const normalizedChatJid = ensureJidSuffix(chatJid);
  const contact = extractContactInfo(message);

  // ULTRON v5.0 DIRECTIVE 1: Global AFK - genuine manual outbound message detection
  const isBot = msgId ? await isBotSentMessage(msgId) : false;
  if (fromMe && !isBot) {
    const afkState = await getAfkState();
    if (afkState.active) {
      await setAfkState(false, "", 0);
      const elapsed = Date.now() - afkState.startTime;
      const durationStr = formatAfkDurationHMS(elapsed);
      const endMessage = `✅ AFK mode ended. Total duration: ${durationStr}.`;
      try {
        await socket.sendMessage(normalizedChatJid, { text: endMessage });
      } catch (err) {
        customLogger.error(`Failed to send AFK end notification to ${normalizedChatJid}`, err);
      }
      await clearAfkNotifiedChats();
    }
  }

  // ULTRON v5.0 DIRECTIVE 1: Global AFK - incoming message check
  if (!fromMe) {
    const afkState = await getAfkState();
    if (afkState.active) {
      const isGroup = chatJid.endsWith('@g.us');
      let trigger = false;
      const msgType = Object.keys(message?.message || {})[0];
      const innerMsg = message?.message?.[msgType];
      const contextInfo = innerMsg?.contextInfo;
      const quotedMessageId = contextInfo?.stanzaId;

      if (!isGroup) {
        trigger = true;
      } else {
        const mentions = contextInfo?.mentionedJid || [];
        const hasMention = mentions.includes(botJid);
        const matchesKeyword = /aayush|ultron/i.test(text);
        const isReplyToBot = quotedMessageId ? await isBotSentMessage(quotedMessageId) : false;

        if (hasMention || matchesKeyword || isReplyToBot) {
          trigger = true;
        }
      }

      if (trigger) {
        const { getChatState, setAfkNotifiedAtSession } = await import('./services/memory');
        const chatState = await getChatState(normalizedChatJid);

        if (chatState.afkNotifiedAtSession !== afkState.startTime) {
          const elapsed = Date.now() - afkState.startTime;
          const durationStr = formatAfkDurationHMS(elapsed);
          const afkResponse = `My master is currently AFK. (Time away: ${durationStr}). Reason: ${afkState.reason}`;
          try {
            await socket.sendMessage(chatJid, { text: afkResponse });
            await setAfkNotifiedAtSession(normalizedChatJid, afkState.startTime);
            await addAfkNotifiedChat(normalizedChatJid);
          } catch (err) {
            customLogger.error(`Failed to send AFK reply to ${chatJid}`, err);
          }
        }
        return; // Early intercept
      }
    }
  }

  // ULTRON v5.0 DIRECTIVE 3: Deterministic Privacy Gate & Data Embargo
  const isPrivacyViolation = detectPrivacyViolation(text);
  if (isPrivacyViolation) {
    try {
      await socket.sendMessage(chatJid, { text: "I cannot assist with that request." });
    } catch (err) {
      customLogger.error(`Failed to send privacy refusal to ${chatJid}`, err);
    }
    return;
  }

  const isOwnerCommand = fromMe && text.trim().startsWith('!');
  if (isOwnerCommand) {
    const command = text.trim().slice(1).split(/\s+/)[0]?.toLowerCase() ?? '';

    const isAfkCommand = command === 'afk';
    if (!isAfkCommand) {
      await clearAfkIfActive();
    }

    const startedAt = Date.now();
    let success = false;
    try {
      switch (command) {
        case 'ping': {
          const latencyMs = Date.now() - receivedAt;
          const finalText = `*Pong!* ${latencyMs}ms`;
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'alive': {
          const [prismaStatus, redisStatus, afkState] = await Promise.all([
            getPrismaStatus(),
            getRedisStatus(),
            getAfkState()
          ]);
          const totalSeconds = Math.floor(process.uptime());
          const hours = Math.floor(totalSeconds / 3600);
          const minutes = Math.floor((totalSeconds % 3600) / 60);
          const secs = totalSeconds % 60;
          const uptimeStr = `${hours}h ${minutes}m ${secs}s`;

          const afkStr = afkState.active ? `Active (Reason: ${afkState.reason})` : `Inactive`;

          const runtime = new PluginRuntime(ownerJid);
          const pluginCount = runtime.getPluginList().length;
          const priorityStr = process.env.AI_PROVIDER_PRIORITY || "Gemini,OpenAI,Claude,OpenRouter,DeepSeek,Groq,Mistral,Cohere";
          const aiProvider = priorityStr.split(',')[0]?.trim() || 'Gemini';

          const { getApiStatusRegistry } = await import('./services/ai');
          const registry = await getApiStatusRegistry();
          const emojiMap: Record<string, string> = {
            "Alive": "🟢",
            "Limit Reached (Cooling Down)": "🟡",
            "Unreachable": "🔴"
          };

          const registryText = [
            `🤖 *ULTRON v5.0 STATUS REGISTRY:*`,
            `${emojiMap[registry["Gemini Key 1"]] || "🔴"} Gemini Key 1: ${registry["Gemini Key 1"]}`,
            `${emojiMap[registry["Gemini Key 2"]] || "🔴"} Gemini Key 2: ${registry["Gemini Key 2"]}`,
            `${emojiMap[registry["Gemini Reserved 1"]] || "🔴"} Gemini Reserved 1: ${registry["Gemini Reserved 1"]}`,
            `${emojiMap[registry["Gemini Reserved 2"]] || "🔴"} Gemini Reserved 2: ${registry["Gemini Reserved 2"]}`,
            `${emojiMap[registry["OpenAI"]] || "🔴"} OpenAI: ${registry["OpenAI"]}`,
            `${emojiMap[registry["Claude"]] || "🔴"} Claude: ${registry["Claude"]}`,
            `${emojiMap[registry["OpenRouter"]] || "🔴"} OpenRouter: ${registry["OpenRouter"]}`,
          ].join('\n');

          const finalText = [
            `═ *ULTRON v5.0 STATUS* ═`,
            `⏱ *Uptime:* ${uptimeStr}`,
            `🗄 *Database:* ${prismaStatus}`,
            `⚡ *Cache:* ${redisStatus}`,
            `💤 *AFK State:* ${afkStr}`,
            `🛡 *DM Gate:* Enabled (Greetings & AI Chatbot Active)`,
            `🛠 Plugins: ${pluginCount}`,
            `🧠 AI Provider: ${aiProvider}`,
            ``,
            registryText
          ].join('\n');
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'uptime': {
          const finalText = `*Uptime*\n${formatUptime(process.uptime())}`;
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
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
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
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
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'approve': {
          const targetJid = chatJid;
          if (!targetJid || targetJid.endsWith('@g.us') || targetJid.includes('broadcast')) {
            const finalText = '❌ Please run this command in a direct message chat.';
            await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
            success = true;
            break;
          }
          await setApprovalState(targetJid, { approved: true, stopped: false });
          const finalText = `✅ Access Granted. AI Bouncer deactivated for this chat.`;
          await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'unapprove':
        case 'bouncer': {
          const targetJid = chatJid;
          if (!targetJid || targetJid.endsWith('@g.us') || targetJid.includes('broadcast')) {
            const finalText = '❌ Please run this command in a direct message chat.';
            await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
            success = true;
            break;
          }
          await setApprovalState(targetJid, { approved: false, stopped: false });
          const finalText = `Approval reset. Front door re-enabled for this chat.`;
          await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'stop': {
          const targetJid = chatJid;
          if (!targetJid || targetJid.endsWith('@g.us') || targetJid.includes('broadcast')) {
            const finalText = '❌ Please run this command in a direct message chat.';
            await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
            success = true;
            break;
          }
          await setApprovalState(targetJid, { approved: false, stopped: true });
          const finalText = `🛑 *AI Deactivated*: Auto-Response has been paused for this chat. Shifting to manual control.`;
          await socket.sendMessage(chatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'afk': {
          const args = text.trim().slice(1).split(/\s+/).slice(1);
          const rawReason = args.join(' ') || 'Away from keyboard';
          const reason = sanitizeAfkReason(rawReason);
          const startTime = Date.now();
          await setAfkState(true, reason, startTime);
          await clearAfkNotifiedChats();
          customLogger.system(JSON.stringify({
            event: "AFK_START",
            reason: reason,
            timestamp: startTime
          }));
          const finalText = `💤 *ULTRON OS: AFK Mode Activated* \nReason: ${reason}`;
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        case 'update': {
          const match = text.match(/^!update\s+(.+)$/i);
          if (!match) {
            await socket.sendMessage(normalizedChatJid, { text: '❌ Usage: !update <text>', edit: message.key });
            success = true;
            break;
          }
          const infoText = match[1].trim();
          const { updateMasterKnowledge } = await import('./services/memory');
          await updateMasterKnowledge(infoText);
          const finalText = '✅ Master Knowledge updated.';
          await socket.sendMessage(normalizedChatJid, { text: finalText, edit: message.key });
          success = true;
          break;
        }
        default: {
          const runtime = new PluginRuntime(ownerJid);
          const args = text.trim().slice(1).split(/\s+/).slice(1);
          try {
            const editMessage = async (newText: string) => {
              if (socket) {
                await socket.sendMessage(normalizedChatJid, { text: newText, edit: message.key });
              }
            };

            const responseText = await runtime.dispatch(command, {
              sender: message.key.fromMe ? ownerJid : ensureJidSuffix(message.key.participant || chatJid),
              owner: ownerJid,
              args,
              chatJid: normalizedChatJid,
              editMessage,
              receivedAt,
            } as any);

            if (responseText && responseText !== "Owner-only command." && !responseText.startsWith("Unknown command:")) {
              if (socket) {
                await socket.sendMessage(normalizedChatJid, { text: responseText, edit: message.key });
              }
              success = true;
            } else if (responseText === "Owner-only command.") {
              if (socket) {
                await socket.sendMessage(normalizedChatJid, { text: "❌ Owner-only command.", edit: message.key });
              }
              success = true;
            } else {
              // No reply if command output was empty, or unhandled
            }
          } catch (err: any) {
            customLogger.error(`Plugin execution failed for !${command}`, err);
            if (socket) {
              await socket.sendMessage(normalizedChatJid, { text: `❌ Error: ${err.message || err}`, edit: message.key });
            }
          }
          break;
        }
      }

      if (success) {
        const duration = Date.now() - startedAt;
        const senderName = message.pushName ?? message.key.participant?.split('@')[0] ?? normalizedChatJid.split('@')[0] ?? 'Me';
        customLogger.command(`!${command} from ${senderName} (${duration}ms)`);
      }
    } catch (error) {
      const duration = Date.now() - startedAt;
      const senderName = message.pushName ?? message.key.participant?.split('@')[0] ?? normalizedChatJid.split('@')[0] ?? 'Me';
      customLogger.error(`Command !${command} from ${senderName} failed after ${duration}ms`, error);
    }
    return;
  }

  // Normal message flow (non-owner command):
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

  if (fromMe) {
    const isBot = messageId ? await isBotSentMessage(messageId) : false;
    if (!isBot) {
      await clearAfkIfActive();
    }
    return;
  }

  const isGroup = chatJid.endsWith('@g.us');
  const isBroadcast = chatJid.includes('broadcast');

  if (isBroadcast) {
    return;
  }

  const msgType = Object.keys(message?.message || {})[0];
  const innerMsg = message?.message?.[msgType];
  const contextInfo = innerMsg?.contextInfo;
  const quotedMessageId = contextInfo?.stanzaId;

  const senderJid = message?.key?.participant || chatJid;
  const normalizedSenderJid = ensureJidSuffix(senderJid);
  const isOwner = normalizedSenderJid === ownerJid;

  if (isOwner) {
    return;
  }

  if (isGroup) {
    const botJid = socket.user?.id ? jidNormalizedUser(socket.user.id) : '';
    const mentions = contextInfo?.mentionedJid || [];
    const hasMention = mentions.includes(botJid);
    const matchesKeyword = /aayush|ultron/i.test(text);
    const isReplyToBot = quotedMessageId ? await isBotSentMessage(quotedMessageId) : false;

    if (!(hasMention || matchesKeyword || isReplyToBot)) {
      return;
    }

    // Cooldown check for group triggers
    const groupCooldownKey = `ultron:group_cooldown:${chatJid}`;
    if (redisConnected && redis.isOpen) {
      try {
        const onCooldown = await redis.get(groupCooldownKey);
        if (onCooldown) {
          customLogger.system(`Group chat ${chatJid} is cooling down, ignoring trigger.`);
          return;
        }
        await redis.setEx(groupCooldownKey, 15, '1');
      } catch (e) {}
    } else {
      const lastTriggered = fallbackGroupCooldowns.get(chatJid) || 0;
      if (Date.now() - lastTriggered < 15000) {
        customLogger.system(`Group chat ${chatJid} is cooling down (fallback), ignoring trigger.`);
        return;
      }
      fallbackGroupCooldowns.set(chatJid, Date.now());
    }

    customLogger.whatsapp(`Processing group message from ${contact.pushName} in ${chatJid}: ${text}`);

    let replyToName: string | undefined = undefined;
    let replyToJid: string | undefined = undefined;
    if (contextInfo?.participant) {
      replyToJid = ensureJidSuffix(contextInfo.participant);
      replyToName = replyToJid === ownerJid ? "Aayush Raj Gupta" : "Group Member";
    }

    try {
      const { getChatHistory, addChatMessage, addUserHistory } = await import('./services/memory');
      const history = await getChatHistory(chatJid);

      const { isReservedTask, generateReservedAiResponse } = await import('./services/ai');
      const useReserved = isReservedTask(message, text);
      const generator = useReserved ? generateReservedAiResponse : generateAiResponse;

      const { text: aiResponse } = await generator(
        text,
        history,
        contact.pushName,
        contact.phoneNumber,
        false,
        {
          isGroup: true,
          senderName: contact.pushName,
          senderJid: normalizedSenderJid,
          replyToName,
          replyToJid
        },
        chatJid
      );

      await Promise.all([
        addChatMessage(chatJid, { role: 'user', content: text }),
        addChatMessage(chatJid, { role: 'assistant', content: aiResponse }),
        addUserHistory(contact.phoneNumber, 'user', text),
        addUserHistory(contact.phoneNumber, 'assistant', aiResponse)
      ]);

      await socket.sendMessage(chatJid, { text: aiResponse }, { quoted: message });
    } catch (err) {
      customLogger.error(`Group AI response failed for ${chatJid}`, err);
    }
    return;
  }

  const isDm = true;

  // Central Logging Hook
  const logGroupJidStr = process.env.LOG_GROUP_JID;
  const logGroupJid = logGroupJidStr ? ensureJidSuffix(logGroupJidStr) : undefined;

  if (logGroupJidStr && !logGroupJid) {
    customLogger.warn(`LOG_GROUP_JID is configured but invalid: "${logGroupJidStr}". Logger disabled.`);
  }

  if (logGroupJid && logGroupJid !== normalizedChatJid) {
    let shouldLog = false;
    let logReason = "";

    const chatState = await getApprovalState(contact.phoneNumber);
    if (!chatState.approved && !chatState.stopped) {
      shouldLog = true;
      logReason = "Incoming DM from unapproved user";
    }

    if (shouldLog) {
      const logText = (text || '').trim() || "[Media or Empty Message]";
      const logMessage = [
        `🔔 *ULTRON LOG ENGINE* ────────────────`,
        `🚨 *Reason:* ${logReason}`,
        `👤 *User:* ${contact.pushName} (${contact.phoneNumber})`,
        `💬 *Message:* ${logText}`,
      ].join('\n');

      socket.sendMessage(logGroupJid, { text: logMessage }).catch(err => {
        customLogger.error(`Failed to forward message to log group ${logGroupJid}`, err);
      });
    }
  }

  const { getChatState, setPendingEmergency } = await import('./services/memory');
  const chatState = await getChatState(normalizedChatJid);

  if (chatState.isStopped) {
    return;
  }



  // 2. DM Gating logic
  if (!chatState.isApproved) {
    if (!text.trim()) return;

    if (text.trim().toLowerCase() === '!urgent') {
      try {
        const { isEmergencyCooldownActive, setEmergencyCooldown, getChatHistory } = await import('./services/memory');
        const cooldownActive = await isEmergencyCooldownActive(contact.phoneNumber);
        if (cooldownActive) {
          await socket.sendMessage(chatJid, { text: "⚠️ Emergency alert already sent. Please wait for Aayush to respond." });
          return;
        }
        await setEmergencyCooldown(contact.phoneNumber);
        const history = await getChatHistory(contact.phoneNumber);
        const { sendEmergencyEmail } = await import('./services/email');
        const currentHistory = [...history, { role: 'user' as const, content: text }];
        await sendEmergencyEmail(contact.pushName, contact.phoneNumber, currentHistory);

        await socket.sendMessage(chatJid, { text: "🚨 Emergency Override Triggered. A high-priority alert has been sent directly to Aayush's phone. He will contact you immediately." });
      } catch (err: any) {
        customLogger.error(`Emergency Override failed for ${contact.pushName}`, err);
      }
      return;
    }

    // Semantic Emergency Confirmation reply check
    if (chatState.pendingEmergency) {
      await setPendingEmergency(normalizedChatJid, false);

      const isAffirmative = (input: string): boolean => {
        const clean = input.trim().toLowerCase();
        const patterns = [
          /^yes$/i, /^y$/i, /\bdo it\b/i, /\bplease\b/i, /\burgent\b/i,
          /\byeah\b/i, /\byep\b/i, /\bsure\b/i, /\bnotify\b/i, /\balert\b/i,
          /\bconfirm\b/i
        ];
        return patterns.some(p => p.test(clean));
      };

      const affirmative = isAffirmative(text);

      customLogger.system(JSON.stringify({
        event: "EMERGENCY_CLASSIFIER",
        jid: normalizedChatJid,
        text: text,
        decision: affirmative ? "affirmative" : "negative",
        reason: affirmative ? "matched affirmative patterns" : "failed patterns",
        confidence: 1.0
      }));

      if (affirmative) {
        try {
          const { isEmergencyCooldownActive, setEmergencyCooldown, getChatHistory } = await import('./services/memory');
          const cooldownActive = await isEmergencyCooldownActive(contact.phoneNumber);
          if (cooldownActive) {
            await socket.sendMessage(chatJid, { text: "⚠️ Emergency alert already sent. Please wait for Aayush to respond." });
            return;
          }
          await setEmergencyCooldown(contact.phoneNumber);
          const history = await getChatHistory(contact.phoneNumber);
          const { sendEmergencyEmail } = await import('./services/email');
          const currentHistory = [...history, { role: 'user' as const, content: text }];
          await sendEmergencyEmail(contact.pushName, contact.phoneNumber, currentHistory);

          await socket.sendMessage(chatJid, { text: "🚨 Emergency Override Triggered. A high-priority alert has been sent directly to Aayush's phone. He will contact you immediately." });
        } catch (err) {
          customLogger.error(`Semantic emergency override failed for ${contact.pushName}`, err);
        }
        return;
      }
    }

    const isLightweightUrgent = (input: string): boolean => {
      const patterns = [
        /\bemergency\b/i, /\burgent\b/i, /\blife-or-death\b/i,
        /\bhospital\b/i, /\bdial 911\b/i, /\bcall the police\b/i,
        /\baccident\b/i, /\bdied\b/i, /\bdeath\b/i,
        /\bplease answer immediately\b/i,
        /\bneed to reach you urgently\b/i
      ];
      return patterns.some(p => p.test(input));
    };

    const isUrgent = isLightweightUrgent(text);

    customLogger.system(`Generating AI Bouncer response for unapproved chat ${contact.pushName} (${contact.phoneNumber})...`);
    try {
      const { getChatHistory, addChatMessage, tryAtomicMarkGateNotified, addUserHistory } = await import('./services/memory');

      // gate cooldown is 3 hours: 3 * 60 * 60 * 1000
      const gateCooldownMs = 3 * 3600 * 1000;

      const canNotify = await tryAtomicMarkGateNotified(normalizedChatJid, gateCooldownMs);
      if (!canNotify) {
        customLogger.system(`Gate message suppressed for ${contact.pushName} due to cooldown.`);
      }

      if (isUrgent) {
        await setPendingEmergency(normalizedChatJid, true);
      }

      const history = await getChatHistory(contact.phoneNumber);
      const isFirstContact = canNotify;

      let promptText = text;
      if (isUrgent) {
        promptText += "\n\n(Instruction to Model: The user seems to have an emergency. Ask a simple confirmation question: 'Should I notify Aayush immediately?' Do not mention any command syntax.)";
      }

      const { isReservedTask, generateReservedAiResponse } = await import('./services/ai');
      const useReserved = isReservedTask(message, text);
      const generator = useReserved ? generateReservedAiResponse : generateAiResponse;

      const { text: aiResponse } = await generator(promptText, history, contact.pushName, contact.phoneNumber, isFirstContact, undefined, chatJid);

      await Promise.all([
        addChatMessage(contact.phoneNumber, { role: 'user', content: text }),
        addChatMessage(contact.phoneNumber, { role: 'assistant', content: aiResponse }),
        addUserHistory(contact.phoneNumber, 'user', text),
        addUserHistory(contact.phoneNumber, 'assistant', aiResponse)
      ]);

      await socket.sendMessage(chatJid, { text: aiResponse });
    } catch (err: any) {
      customLogger.error(`AI Bouncer response failed for ${contact.pushName}`, err);
    }
    return;
  }
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

let dummyServerStarted = false;

function startDummyServer(): void {
  if (dummyServerStarted) return;
  dummyServerStarted = true;

  const port = process.env.PORT || '8000';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ULTRON OS is active.');
  });

  server.listen(Number(port), () => {
    customLogger.system(`🌐 Dummy web server listening on port ${port} [SUCCESS]`);
  });
}

async function startSocket(): Promise<void> {
  const { validateGeminiKeysOnStartup } = await import('./services/ai');
  validateGeminiKeysOnStartup();

  startDummyServer();
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
    if (!authState) {
      authState = await createPrismaAuthState();
    }
    printBanner();
    printStatusTable(
      prismaConnected ? 'connected' : 'disconnected',
      redisConnected ? 'connected' : 'disconnected',
      authState?.state?.creds?.me?.id || ''
    );
    customLogger.system('📦 Loading Core Engine... [SUCCESS]');
    customLogger.system('⚡ Loading AI Failover... [SUCCESS]');
    customLogger.system('Starting ULTRON WhatsApp session...');
    const { state, saveCreds } = authState;
    const { version } = await fetchLatestBaileysVersion();
    const currentSocket = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      browser: Browsers.ubuntu('ULTRON'),
      syncFullHistory: true,
    });

    const originalSendMessage = currentSocket.sendMessage.bind(currentSocket);
    currentSocket.sendMessage = async (jid: string, content: any, options?: any) => {
      const sent = await originalSendMessage(jid, content, options);
      if (sent && sent.key && sent.key.id) {
        await markBotSentMessage(sent.key.id);
      }
      return sent;
    };

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
        const userId = currentSocket.user?.id;
        customLogger.system(`🔑 Authorized as: ${userId || 'unknown'}`);

        if (!hasSentBootNotification && userId) {
          hasSentBootNotification = true;
          const normalizedJid = jidNormalizedUser(userId);

          // Get the dynamic count of plugins
          const runtime = new PluginRuntime(process.env.OWNER_JID || 'owner');
          const pluginCount = runtime.getPluginList().length;

          // Parse and format the AI Failover Priority
          const priorityStr = process.env.AI_PROVIDER_PRIORITY || "Gemini,OpenAI,Claude,OpenRouter,DeepSeek,Groq,Mistral,Cohere";
          const priorityFormatted = priorityStr.split(',').map(p => p.trim()).filter(Boolean).join(' -> ');

          const notificationText = [
            `*元 ULTRON OS ONLINE* ────────────────`,
            `🤖 *Status:* Core Systems Operational`,
            `⚡ *Environment:* Koyeb Production`,
            `🛠️ *Plugins Loaded:* ${pluginCount}`,
            `🧠 *AI Failover:* Active (Priority: ${priorityFormatted})`,
            ``,
            `_Ready for inputs. Try sending !help to test execution._`
          ].join('\n');

          // Send message directly to owner
          currentSocket.sendMessage(normalizedJid, { text: notificationText }).catch(err => {
            customLogger.error('Failed to send startup notification', err);
          });
        }
      }
    });

    currentSocket.ev.on('messaging-history.set', async ({ chats, contacts, messages, isLatest }: any) => {
      customLogger.system(`[HISTORY SYNC] Received history sync with ${messages?.length || 0} messages.`);
      if (!messages || messages.length === 0) return;

      const { addUserHistory, getOrCreateUserProfile } = await import('./services/memory');

      // Process in a non-blocking background task
      (async () => {
        let count = 0;
        for (const msg of messages) {
          try {
            const chatJid = msg.key.remoteJid;
            if (!chatJid) continue;
            
            const fromMe = msg.key.fromMe === true;
            const text = extractText(msg);
            if (!text || text.trim() === '') continue;

            const timestamp = msg.messageTimestamp ? new Date(Number(msg.messageTimestamp) * 1000) : new Date();

            // Extract contact base phone number from JID
            const senderJid = msg.key.participant || chatJid;
            const cleanPhone = senderJid.split('@')[0].split(':')[0]; // strip JID domain and device suffix
            if (!cleanPhone || cleanPhone === '') continue;

            const role = fromMe ? 'assistant' : 'user';

            if (!fromMe) {
              const pushName = msg.pushName || "Stranger";
              await getOrCreateUserProfile(cleanPhone, pushName);
            }

            // Save history turn, skip embeddings for batch sync
            await addUserHistory(cleanPhone, role, text, timestamp, true);
            count++;
          } catch (err) {
            // fail silently on individual turns
          }
        }
        customLogger.system(`[HISTORY SYNC] Successfully ingested ${count} historic turns into memory database.`);
      })().catch(err => {
        customLogger.error('[HISTORY SYNC] Background history sync processing failed', err);
      });
    });

    currentSocket.ev.on('creds.update', saveCreds);

    currentSocket.ev.on('messages.upsert', async ({ messages, type }: { messages: any[]; type: string }) => {
      for (const message of messages) {
        if (!message.message) continue;
        const text = extractText(message);
        if (!text || text.trim() === '') continue;

        const fromMe = message?.key?.fromMe === true;
        const isOwnerCommand = fromMe && text.trim().startsWith('!');

        // Real-time asynchronous ingestion (non-blocking) to Supabase
        (async () => {
          try {
            const chatJid = message.key.remoteJid;
            if (!chatJid) return;

            const senderJid = message.key.participant || chatJid;
            const cleanPhone = senderJid.split('@')[0].split(':')[0];
            if (!cleanPhone) return;

            let role: 'user' | 'bot' | 'host' = 'user';
            if (fromMe) {
              const msgId = message.key.id;
              const isBot = msgId ? (botSentMessageIds.has(msgId) || await isBotSentMessage(msgId)) : false;
              role = isBot ? 'bot' : 'host';
            }

            const timestamp = message.messageTimestamp ? new Date(Number(message.messageTimestamp) * 1000) : new Date();

            const { addUserHistory } = await import('./services/memory');
            // Continuous real-time ingestion generates vector embeddings
            await addUserHistory(cleanPhone, role, text, timestamp, false);
          } catch (e) {
            // Fail silently so Supabase/network issues do not crash the socket loop
          }
        })();

        if (type !== 'notify' && !isOwnerCommand) {
          continue;
        }

        await routeMessage(message);
      }
    });
  } catch (error) {
    customLogger.error('startSocket failed with error', error);
    reconnecting = false;
    throw error;
  }
}

if (require.main === module) {
  startSocket().catch((error) => {
    customLogger.error('Startup failed', error);
    process.exit(1);
  });
}