import { redis } from '../main';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

const HISTORY_KEY_PREFIX = 'ultron:chat_history:';
const MAX_HISTORY_LEN = 15;
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

export async function getChatHistory(phoneNumber: string): Promise<ChatMessage[]> {
  try {
    if (!redis.isOpen) {
      return [];
    }
    const key = `${HISTORY_KEY_PREFIX}${phoneNumber}`;
    const data = await redis.lRange(key, 0, -1);
    return data.map((item) => JSON.parse(item) as ChatMessage);
  } catch (error) {
    return [];
  }
}

export async function addChatMessage(phoneNumber: string, message: ChatMessage): Promise<void> {
  try {
    if (!redis.isOpen) {
      return;
    }
    const key = `${HISTORY_KEY_PREFIX}${phoneNumber}`;
    const serialized = JSON.stringify(message);
    await redis.rPush(key, serialized);
    await redis.lTrim(key, -MAX_HISTORY_LEN, -1);
    await redis.expire(key, TTL_SECONDS);
  } catch (error) {
    // Fail silently
  }
}

let fallbackMasterKnowledge = '';

export async function updateMasterKnowledge(text: string): Promise<void> {
  try {
    if (!redis.isOpen) {
      fallbackMasterKnowledge = fallbackMasterKnowledge ? `${fallbackMasterKnowledge}\n${text}` : text;
      return;
    }
    const current = await redis.get('ultron:master_knowledge');
    const updated = current ? `${current}\n${text}` : text;
    await redis.set('ultron:master_knowledge', updated);
  } catch (error) {
    // Fail silently
  }
}

export async function getMasterKnowledge(): Promise<string> {
  try {
    if (!redis.isOpen) {
      return fallbackMasterKnowledge;
    }
    return (await redis.get('ultron:master_knowledge')) || fallbackMasterKnowledge;
  } catch (error) {
    return fallbackMasterKnowledge;
  }
}

const COOLDOWN_KEY_PREFIX = 'ultron:emergency_cooldown:';
const COOLDOWN_TTL_SECONDS = 1800; // 30 minutes
const fallbackCooldowns = new Map<string, number>();

export async function isEmergencyCooldownActive(phoneNumber: string): Promise<boolean> {
  try {
    if (!redis.isOpen) {
      const expiration = fallbackCooldowns.get(phoneNumber);
      if (expiration && Date.now() < expiration) {
        return true;
      }
      return false;
    }
    const key = `${COOLDOWN_KEY_PREFIX}${phoneNumber}`;
    const value = await redis.get(key);
    return value !== null;
  } catch (error) {
    return false;
  }
}

export async function setEmergencyCooldown(phoneNumber: string): Promise<void> {
  try {
    if (!redis.isOpen) {
      fallbackCooldowns.set(phoneNumber, Date.now() + COOLDOWN_TTL_SECONDS * 1000);
      return;
    }
    const key = `${COOLDOWN_KEY_PREFIX}${phoneNumber}`;
    await redis.setEx(key, COOLDOWN_TTL_SECONDS, 'active');
  } catch (error) {
    // Fail silently
  }
}

export interface ChatState {
  hasGreeted: boolean;
  isApproved: boolean;
  isStopped: boolean;
  gateNotifiedAt: number;
  afkNotifiedAtSession: number;
  pendingEmergency: boolean;
}

export async function getChatState(jid: string): Promise<ChatState> {
  const main = await import('../main');
  const { redis, redisConnected, prisma, prismaConnected, customLogger, fallbackChatState } = main;
  
  const defaultState: ChatState = {
    hasGreeted: false,
    isApproved: false,
    isStopped: false,
    gateNotifiedAt: 0,
    afkNotifiedAtSession: 0,
    pendingEmergency: false
  };

  const phone = jid.split('@')[0];

  if (redisConnected && redis.isOpen) {
    try {
      const data = await redis.hGetAll(`ultron:chat:${jid}`);
      if (data && Object.keys(data).length > 0) {
        return {
          hasGreeted: data.hasGreeted === 'true',
          isApproved: data.isApproved === 'true',
          isStopped: data.isStopped === 'true',
          gateNotifiedAt: parseInt(data.gateNotifiedAt || '0', 10),
          afkNotifiedAtSession: parseInt(data.afkNotifiedAtSession || '0', 10),
          pendingEmergency: data.pendingEmergency === 'true'
        };
      }
    } catch (err) {
      customLogger.error(`Failed to get chat state from Redis for ${jid}`, err);
    }
  }

  // Load database status
  let dbApproved = false;
  let dbStopped = false;
  
  if (prismaConnected) {
    try {
      const record = await prisma.chatApproval.findUnique({ where: { jid: phone } });
      if (record) {
        dbApproved = record.approved;
        dbStopped = record.stopped;
      }
    } catch (err) {
      // Ignore
    }
  }

  // Load from local fallback map
  const fallback = fallbackChatState.get(jid) || {};
  const merged = {
    ...defaultState,
    isApproved: dbApproved || fallback.approved || fallback.isApproved || false,
    isStopped: dbStopped || fallback.stopped || fallback.isStopped || false,
    hasGreeted: fallback.hasGreeted || false,
    gateNotifiedAt: fallback.gateNotifiedAt || 0,
    afkNotifiedAtSession: fallback.afkNotifiedAtSession || 0,
    pendingEmergency: fallback.pendingEmergency || false
  };

  // Sync to Redis if open
  if (redisConnected && redis.isOpen) {
    try {
      await redis.hSet(`ultron:chat:${jid}`, {
        hasGreeted: merged.hasGreeted.toString(),
        isApproved: merged.isApproved.toString(),
        isStopped: merged.isStopped.toString(),
        gateNotifiedAt: merged.gateNotifiedAt.toString(),
        afkNotifiedAtSession: merged.afkNotifiedAtSession.toString(),
        pendingEmergency: merged.pendingEmergency.toString()
      });
    } catch (err) {}
  }

  return merged;
}

export async function setApprovalStateInState(jid: string, approved: boolean, stopped: boolean): Promise<void> {
  const main = await import('../main');
  const { redis, redisConnected, prisma, prismaConnected, customLogger, fallbackChatState } = main;
  const phone = jid.split('@')[0];

  // 1. Prisma write
  if (prismaConnected) {
    try {
      await prisma.chatApproval.upsert({
        where: { jid: phone },
        update: { approved, stopped },
        create: { jid: phone, approved, stopped }
      });
    } catch (err) {
      customLogger.error(`Failed to upsert approval in database for ${phone}`, err);
    }
  }

  // 2. Redis write
  if (redisConnected && redis.isOpen) {
    try {
      await redis.hSet(`ultron:chat:${jid}`, {
        isApproved: approved.toString(),
        isStopped: stopped.toString()
      });
    } catch (err) {
      customLogger.error(`Failed to hSet approval in Redis for ${jid}`, err);
    }
  }

  // 3. Fallback write
  const fallback = fallbackChatState.get(jid) || {};
  fallback.approved = approved;
  fallback.isApproved = approved;
  fallback.stopped = stopped;
  fallback.isStopped = stopped;
  fallbackChatState.set(jid, fallback);
}

export async function tryAtomicMarkGateNotified(jid: string, cooldownMs: number): Promise<boolean> {
  const main = await import('../main');
  const { redis, redisConnected, customLogger, fallbackChatState } = main;
  const now = Date.now();

  if (redisConnected && redis.isOpen) {
    try {
      const luaScript = `
        local key = KEYS[1]
        local cooldown = tonumber(ARGV[1])
        local now = tonumber(ARGV[2])
        local current = redis.call('hget', key, 'gateNotifiedAt')
        if not current or (now - tonumber(current)) >= cooldown then
          redis.call('hset', key, 'gateNotifiedAt', now)
          redis.call('hset', key, 'hasGreeted', 'true')
          return 1
        else
          return 0
        end
      `;
      const result = await redis.eval(luaScript, {
        keys: [`ultron:chat:${jid}`],
        arguments: [cooldownMs.toString(), now.toString()]
      });
      return result === 1;
    } catch (err) {
      customLogger.error(`Failed to execute Lua atomic gate check for ${jid}`, err);
    }
  }

  // Local fallback check-and-set
  const fallback = fallbackChatState.get(jid) || { hasGreeted: false, approved: false, isApproved: false, stopped: false, isStopped: false, gateNotifiedAt: 0, afkNotifiedAtSession: 0, pendingEmergency: false };
  if (!fallback.gateNotifiedAt || (now - fallback.gateNotifiedAt) >= cooldownMs) {
    fallback.gateNotifiedAt = now;
    fallback.hasGreeted = true;
    fallbackChatState.set(jid, fallback);
    return true;
  }
  return false;
}

export async function setPendingEmergency(jid: string, pending: boolean): Promise<void> {
  const main = await import('../main');
  const { redis, redisConnected, fallbackChatState } = main;

  if (redisConnected && redis.isOpen) {
    try {
      await redis.hSet(`ultron:chat:${jid}`, 'pendingEmergency', pending.toString());
    } catch (err) {}
  }

  const fallback = fallbackChatState.get(jid) || {};
  fallback.pendingEmergency = pending;
  fallbackChatState.set(jid, fallback);
}

export async function setAfkNotifiedAtSession(jid: string, sessionStart: number): Promise<void> {
  const main = await import('../main');
  const { redis, redisConnected, fallbackChatState } = main;

  if (redisConnected && redis.isOpen) {
    try {
      await redis.hSet(`ultron:chat:${jid}`, 'afkNotifiedAtSession', sessionStart.toString());
    } catch (err) {}
  }

  const fallback = fallbackChatState.get(jid) || {};
  fallback.afkNotifiedAtSession = sessionStart;
  fallbackChatState.set(jid, fallback);
}

// ULTRON v5.0 DIRECTIVE 3: Cross-Channel User Profile Tracking
export interface UserProfile {
  phoneNumber: string;
  name: string;
  tier: string;
  notes: string | null;
}

export async function getOrCreateUserProfile(phoneNumber: string, defaultName: string): Promise<UserProfile> {
  const main = await import('../main');
  const { prisma, prismaConnected } = main;

  if (prismaConnected) {
    try {
      let user = await prisma.user.findUnique({ where: { phoneNumber } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            phoneNumber,
            name: defaultName,
            tier: 'stranger',
            notes: ''
          }
        });
      }
      return user;
    } catch (err) {
      // Ignore database errors and fallback
    }
  }

  return {
    phoneNumber,
    name: defaultName,
    tier: 'stranger',
    notes: ''
  };
}

// ULTRON v5.0 DIRECTIVE 4: Memory Vector Stage (Style Imitation RAG)
export async function addUserHistory(
  phoneNumber: string,
  role: 'user' | 'host' | 'bot' | string,
  content: string,
  createdAt?: Date,
  skipEmbedding?: boolean
): Promise<void> {
  const main = await import('../main');
  const { prisma, prismaConnected } = main;
  if (!prismaConnected) return;

  try {
    let embedding: number[] = [];
    if (!skipEmbedding) {
      try {
        const aiService = await import('./ai');
        embedding = await aiService.getEmbedding(content);
      } catch (e) {
        // Fail silently on embedding generation
      }
    }

    await prisma.userHistory.create({
      data: {
        userId: phoneNumber,
        role,
        content,
        embedding: embedding.length > 0 ? embedding : [],
        createdAt: createdAt || new Date()
      }
    });
  } catch (err) {
    // Fail silently
  }
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
  let dotProduct = 0.0;
  let normA = 0.0;
  let normB = 0.0;
  const len = Math.min(vecA.length, vecB.length);
  for (let i = 0; i < len; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function getSemanticSimilarHistory(phoneNumber: string, queryText: string): Promise<{ role: string; content: string }[]> {
  const main = await import('../main');
  const { prisma, prismaConnected } = main;
  if (!prismaConnected) return [];

  try {
    const aiService = await import('./ai');
    const queryEmbedding = await aiService.getEmbedding(queryText);
    const current_session_user_id = phoneNumber;

    // 1. Try pgvector similarity query
    try {
      const embeddingStr = `[${queryEmbedding.join(',')}]`;
      const similarRecords = await prisma.$queryRawUnsafe<any[]>(
        `SELECT role, content FROM "UserHistory" 
         WHERE "userId" = $1 AND array_length(embedding, 1) IS NOT NULL
         ORDER BY embedding <=> $2::vector
         LIMIT 3`,
        current_session_user_id,
        embeddingStr
      );
      if (similarRecords && similarRecords.length > 0) {
        return similarRecords.map(r => ({ role: r.role, content: r.content }));
      }
    } catch (dbErr) {
      // 2. Cosine similarity fallback in JS/TS
      const records = await prisma.userHistory.findMany({
        where: {
          userId: current_session_user_id
        }
      });
      const validRecords = records.filter(r => r.embedding && r.embedding.length > 0);
      const recordsWithSim = validRecords.map(r => {
        const sim = cosineSimilarity(queryEmbedding, r.embedding);
        return { role: r.role, content: r.content, sim };
      });
      recordsWithSim.sort((a, b) => b.sim - a.sim);
      return recordsWithSim.slice(0, 3).map(r => ({ role: r.role, content: r.content }));
    }
  } catch (err) {
    // Fail silently
  }
  return [];
}


