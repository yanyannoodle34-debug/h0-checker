import { eq, desc, sql, and, gte, lt } from "drizzle-orm";
import { db } from "./db";
import {
  users, botUsers, gateConfigs, accessKeys, checkResults, proxies, botSettings, systemLogs, minerConfig, proxyConfig,
  type User, type InsertUser,
  type BotUser, type InsertBotUser,
  type GateConfig, type InsertGateConfig,
  type AccessKey, type InsertAccessKey,
  type CheckResult, type InsertCheckResult,
  type Proxy, type InsertProxy,
  type BotSettings, type InsertBotSettings,
  type SystemLog, type InsertSystemLog,
  type MinerConfig, type ProxyConfig,
} from "@shared/schema";

export interface IStorage {
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

  getBotUsers(): Promise<BotUser[]>;
  getBotUser(telegramId: string): Promise<BotUser | undefined>;
  createBotUser(user: InsertBotUser): Promise<BotUser>;
  updateBotUser(id: string, data: Partial<BotUser>): Promise<BotUser | undefined>;
  deleteBotUser(id: string): Promise<void>;
  resetDailyUsage(): Promise<void>;

  getGateConfigs(): Promise<GateConfig[]>;
  getGateConfig(id: string): Promise<GateConfig | undefined>;
  createGateConfig(config: InsertGateConfig): Promise<GateConfig>;
  updateGateConfig(id: string, data: Partial<GateConfig>): Promise<GateConfig | undefined>;
  deleteGateConfig(id: string): Promise<void>;

  getAccessKeys(): Promise<AccessKey[]>;
  getAccessKey(key: string): Promise<AccessKey | undefined>;
  getAccessKeyById(id: string): Promise<AccessKey | undefined>;
  createAccessKey(key: InsertAccessKey): Promise<AccessKey>;
  updateAccessKey(id: string, data: Partial<AccessKey>): Promise<AccessKey | undefined>;
  deleteAccessKey(id: string): Promise<void>;

  getCheckResults(filters?: { checkedBy?: string; status?: string; noLimit?: boolean }): Promise<CheckResult[]>;
  createCheckResult(result: InsertCheckResult): Promise<CheckResult>;
  getCheckStats(): Promise<{ total: number; approved: number; declined: number }>;
  getApprovedCards(): Promise<CheckResult[]>;
  getApprovedByPeriod(period: "today" | "24h" | "week", gateName?: string): Promise<CheckResult[]>;
  getLiveCountByGate(): Promise<{ gate: string; total: number; today: number; week: number }[]>;
  clearResultsOlderThan(days: number): Promise<number>;
  getBotUsersWithNotify(): Promise<BotUser[]>;

  getProxies(): Promise<Proxy[]>;
  createProxy(proxy: InsertProxy): Promise<Proxy>;
  bulkCreateProxies(proxyList: InsertProxy[]): Promise<void>;
  updateProxy(id: string, data: Partial<Proxy>): Promise<void>;
  deleteProxy(id: string): Promise<void>;
  clearDeadProxies(): Promise<number>;
  getProxyStats(): Promise<{ total: number; live: number; avgLatency: number }>;

  getBotSettings(): Promise<BotSettings>;
  updateBotSettings(data: Partial<BotSettings>): Promise<BotSettings>;

  getSystemLogs(limit?: number): Promise<SystemLog[]>;
  createSystemLog(log: InsertSystemLog): Promise<SystemLog>;

  getMinerConfig(): Promise<MinerConfig>;
  updateMinerConfig(data: Partial<MinerConfig>): Promise<MinerConfig>;

  getProxyConfig(): Promise<ProxyConfig>;
  setProxyConfig(enabled: boolean): Promise<ProxyConfig>;

  clearAllCheckResults(): Promise<void>;
  clearAllBotUsers(): Promise<void>;
  clearAllGateConfigs(): Promise<void>;
  clearAllAccessKeys(): Promise<void>;
  clearAllProxies(): Promise<void>;
  clearAllSystemLogs(): Promise<void>;
  resetAllData(): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.username, username));
    return user;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async getBotUsers(): Promise<BotUser[]> {
    return db.select().from(botUsers).orderBy(desc(botUsers.createdAt));
  }

  async getBotUser(telegramId: string): Promise<BotUser | undefined> {
    const [user] = await db.select().from(botUsers).where(eq(botUsers.telegramId, telegramId));
    return user;
  }

  async createBotUser(user: InsertBotUser): Promise<BotUser> {
    const [created] = await db.insert(botUsers).values(user).returning();
    return created;
  }

  async updateBotUser(id: string, data: Partial<BotUser>): Promise<BotUser | undefined> {
    const [updated] = await db.update(botUsers).set(data).where(eq(botUsers.id, id)).returning();
    return updated;
  }

  async deleteBotUser(id: string): Promise<void> {
    await db.delete(botUsers).where(eq(botUsers.id, id));
  }

  async resetDailyUsage(): Promise<void> {
    await db.update(botUsers).set({ usageToday: 0 });
  }

  async getGateConfigs(): Promise<GateConfig[]> {
    return db.select().from(gateConfigs).orderBy(desc(gateConfigs.createdAt));
  }

  async getGateConfig(id: string): Promise<GateConfig | undefined> {
    const [config] = await db.select().from(gateConfigs).where(eq(gateConfigs.id, id));
    return config;
  }

  async createGateConfig(config: InsertGateConfig): Promise<GateConfig> {
    const [created] = await db.insert(gateConfigs).values(config).returning();
    return created;
  }

  async updateGateConfig(id: string, data: Partial<GateConfig>): Promise<GateConfig | undefined> {
    const [updated] = await db.update(gateConfigs).set(data).where(eq(gateConfigs.id, id)).returning();
    return updated;
  }

  async deleteGateConfig(id: string): Promise<void> {
    await db.delete(gateConfigs).where(eq(gateConfigs.id, id));
  }

  async getAccessKeys(): Promise<AccessKey[]> {
    return db.select().from(accessKeys).orderBy(desc(accessKeys.createdAt));
  }

  async getAccessKey(key: string): Promise<AccessKey | undefined> {
    const [found] = await db.select().from(accessKeys).where(eq(accessKeys.key, key));
    return found;
  }

  async getAccessKeyById(id: string): Promise<AccessKey | undefined> {
    const [found] = await db.select().from(accessKeys).where(eq(accessKeys.id, id));
    return found;
  }

  async createAccessKey(key: InsertAccessKey): Promise<AccessKey> {
    const [created] = await db.insert(accessKeys).values(key).returning();
    return created;
  }

  async updateAccessKey(id: string, data: Partial<AccessKey>): Promise<AccessKey | undefined> {
    const [updated] = await db.update(accessKeys).set(data).where(eq(accessKeys.id, id)).returning();
    return updated;
  }

  async deleteAccessKey(id: string): Promise<void> {
    await db.delete(accessKeys).where(eq(accessKeys.id, id));
  }

  async getCheckResults(filters?: { checkedBy?: string; status?: string; noLimit?: boolean }): Promise<CheckResult[]> {
    const conditions = [];
    if (filters?.checkedBy) {
      conditions.push(eq(checkResults.checkedBy, filters.checkedBy));
    }
    if (filters?.status) {
      conditions.push(eq(checkResults.status, filters.status));
    }
    const maxRows = filters?.noLimit ? 10000 : 500;
    if (conditions.length > 0) {
      return db.select().from(checkResults).where(and(...conditions)).orderBy(desc(checkResults.createdAt)).limit(maxRows);
    }
    return db.select().from(checkResults).orderBy(desc(checkResults.createdAt)).limit(maxRows);
  }

  async createCheckResult(result: InsertCheckResult): Promise<CheckResult> {
    const [created] = await db.insert(checkResults).values(result).returning();
    return created;
  }

  async getCheckStats(): Promise<{ total: number; approved: number; declined: number }> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const allResults = await db.select().from(checkResults).where(gte(checkResults.createdAt, today));
    const total = allResults.length;
    const approved = allResults.filter(r => r.status === "approved").length;
    const declined = total - approved;
    return { total, approved, declined };
  }

  async getApprovedCards(): Promise<CheckResult[]> {
    return db.select().from(checkResults).where(eq(checkResults.status, "approved")).orderBy(desc(checkResults.createdAt));
  }

  async getApprovedByPeriod(period: "today" | "24h" | "week", gateName?: string): Promise<CheckResult[]> {
    const now = new Date();
    let since: Date;
    if (period === "today") {
      since = new Date(now); since.setHours(0, 0, 0, 0);
    } else if (period === "24h") {
      since = new Date(now.getTime() - 24 * 3600000);
    } else {
      since = new Date(now.getTime() - 7 * 24 * 3600000);
    }
    const conditions: any[] = [eq(checkResults.status, "approved"), gte(checkResults.createdAt, since)];
    if (gateName) conditions.push(eq(checkResults.gate, gateName));
    return db.select().from(checkResults).where(and(...conditions)).orderBy(desc(checkResults.createdAt)).limit(200);
  }

  async getLiveCountByGate(): Promise<{ gate: string; total: number; today: number; week: number }[]> {
    const all = await db.select().from(checkResults).where(eq(checkResults.status, "approved"));
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const weekStart = new Date(Date.now() - 7 * 24 * 3600000);
    const map = new Map<string, { total: number; today: number; week: number }>();
    for (const r of all) {
      const g = r.gate || "Unknown";
      if (!map.has(g)) map.set(g, { total: 0, today: 0, week: 0 });
      const e = map.get(g)!;
      e.total++;
      const t = r.createdAt ? new Date(r.createdAt) : null;
      if (t) {
        if (t >= todayStart) e.today++;
        if (t >= weekStart) e.week++;
      }
    }
    return [...map.entries()].map(([gate, c]) => ({ gate, ...c })).sort((a, b) => b.total - a.total);
  }

  async clearResultsOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600000);
    const deleted = await db.delete(checkResults).where(lt(checkResults.createdAt, cutoff)).returning();
    return deleted.length;
  }

  async getBotUsersWithNotify(): Promise<BotUser[]> {
    return db.select().from(botUsers).where(eq(botUsers.notifyLive, true));
  }

  async getProxies(): Promise<Proxy[]> {
    return db.select().from(proxies).orderBy(proxies.latency);
  }

  async createProxy(proxy: InsertProxy): Promise<Proxy> {
    const [created] = await db.insert(proxies).values(proxy).returning();
    return created;
  }

  async bulkCreateProxies(proxyList: InsertProxy[]): Promise<void> {
    if (proxyList.length > 0) {
      await db.insert(proxies).values(proxyList).onConflictDoNothing();
    }
  }

  async updateProxy(id: string, data: Partial<Proxy>): Promise<void> {
    await db.update(proxies).set(data).where(eq(proxies.id, id));
  }

  async deleteProxy(id: string): Promise<void> {
    await db.delete(proxies).where(eq(proxies.id, id));
  }

  async clearDeadProxies(): Promise<number> {
    const dead = await db.delete(proxies).where(eq(proxies.status, "dead")).returning();
    return dead.length;
  }

  async getProxyStats(): Promise<{ total: number; live: number; avgLatency: number }> {
    const all = await db.select().from(proxies);
    const live = all.filter(p => p.status === "live");
    // Exclude proxies with no measured latency (e.g. manually-added, not yet tested)
    const measured = live.filter(p => p.latency != null);
    const avgLatency = measured.length > 0
      ? Math.round(measured.reduce((s, p) => s + p.latency!, 0) / measured.length)
      : 0;
    return { total: all.length, live: live.length, avgLatency };
  }

  async getBotSettings(): Promise<BotSettings> {
    const [settings] = await db.select().from(botSettings).where(eq(botSettings.id, "default"));
    if (!settings) {
      const [created] = await db.insert(botSettings).values({ id: "default" } as any).returning();
      return created;
    }
    return settings;
  }

  async updateBotSettings(data: Partial<BotSettings>): Promise<BotSettings> {
    await this.getBotSettings();
    const [updated] = await db.update(botSettings).set(data).where(eq(botSettings.id, "default")).returning();
    return updated;
  }

  async getSystemLogs(limit = 50): Promise<SystemLog[]> {
    return db.select().from(systemLogs).orderBy(desc(systemLogs.createdAt)).limit(limit);
  }

  async createSystemLog(log: InsertSystemLog): Promise<SystemLog> {
    const [created] = await db.insert(systemLogs).values(log).returning();
    return created;
  }

  async getMinerConfig(): Promise<MinerConfig> {
    let [cfg] = await db.select().from(minerConfig).where(eq(minerConfig.id, "default"));
    if (!cfg) {
      [cfg] = await db.insert(minerConfig).values({ id: "default" }).returning();
    }
    return cfg;
  }

  async updateMinerConfig(data: Partial<MinerConfig>): Promise<MinerConfig> {
    await this.getMinerConfig();
    const [updated] = await db.update(minerConfig).set(data as any).where(eq(minerConfig.id, "default")).returning();
    return updated;
  }

  async getProxyConfig(): Promise<ProxyConfig> {
    let [cfg] = await db.select().from(proxyConfig).where(eq(proxyConfig.id, "default"));
    if (!cfg) {
      [cfg] = await db.insert(proxyConfig).values({ id: "default", enabled: true }).returning();
    }
    return cfg;
  }

  async setProxyConfig(enabled: boolean): Promise<ProxyConfig> {
    // Single upsert — no TOCTOU race on first-time insert
    const [updated] = await db
      .insert(proxyConfig)
      .values({ id: "default", enabled })
      .onConflictDoUpdate({ target: proxyConfig.id, set: { enabled, updatedAt: new Date() } })
      .returning();
    return updated;
  }

  async clearAllCheckResults(): Promise<void> {
    await db.delete(checkResults);
  }

  async clearAllBotUsers(): Promise<void> {
    await db.delete(botUsers);
  }

  async clearAllGateConfigs(): Promise<void> {
    await db.delete(gateConfigs);
  }

  async clearAllAccessKeys(): Promise<void> {
    await db.delete(accessKeys);
  }

  async clearAllProxies(): Promise<void> {
    await db.delete(proxies);
  }

  async clearAllSystemLogs(): Promise<void> {
    await db.delete(systemLogs);
  }

  async resetAllData(): Promise<void> {
    await this.clearAllCheckResults();
    await this.clearAllBotUsers();
    await this.clearAllGateConfigs();
    await this.clearAllAccessKeys();
    await this.clearAllProxies();
    await this.clearAllSystemLogs();
    await db.update(botSettings).set({
      botToken: null,
      chatId: null,
      ownerId: null,
      botRunning: false,
    }).where(eq(botSettings.id, "default"));
  }
}

export const storage = new DatabaseStorage();
