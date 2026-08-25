import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
  role: text("role").notNull().default("admin"),
});

export const botUsers = pgTable("bot_users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  telegramId: text("telegram_id").notNull().unique(),
  username: text("username"),
  role: text("role").notNull().default("user"),
  dailyLimit: integer("daily_limit").notNull().default(100),
  usageToday: integer("usage_today").notNull().default(0),
  totalHits: integer("total_hits").notNull().default(0),
  totalChecks: integer("total_checks").notNull().default(0),
  banned: boolean("banned").notNull().default(false),
  notifyLive: boolean("notify_live").notNull().default(true),
  keyId: varchar("key_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const gateConfigs = pgTable("gate_configs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  gateType: text("gate_type").notNull(),
  subType: text("sub_type").notNull().default("standard"),
  url: text("url").notNull(),
  active: boolean("active").notNull().default(true),
  // ISO-2 country the gate's merchant serves best (e.g. "US"). Used to route a
  // card to a same-country gate (US card → US gate) so AVS runs and 3DS is less
  // likely. Empty/null = any-country gate (matches every card as a fallback).
  country: text("country"),
  settings: jsonb("settings").notNull().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const accessKeys = pgTable("access_keys", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  key: text("key").notNull().unique(),
  durationDays: integer("duration_days").notNull().default(30),
  dailyLimit: integer("daily_limit").notNull().default(1000),
  status: text("status").notNull().default("unused"),
  redeemedBy: text("redeemed_by"),
  createdAt: timestamp("created_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
});

export const checkResults = pgTable("check_results", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  card: text("card").notNull(),
  status: text("status").notNull(),
  response: text("response"),
  // Truncated raw response body (≤1 KB) captured by the checker on failure.
  // Used by the AI Analyzer for high-fidelity signal (actual HTML/JSON the
  // site returned) instead of just our formatted response string.
  rawSnippet: text("raw_snippet"),
  gate: text("gate"),
  latency: integer("latency"),
  checkedBy: text("checked_by"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const proxies = pgTable("proxies", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  ip: text("ip").notNull(),
  port: integer("port").notNull(),
  protocol: text("protocol").notNull().default("https"),
  username: text("username"),
  password: text("password"),
  latency: integer("latency"),
  anonymity: text("anonymity").notNull().default("elite"),
  country: text("country"),   // ISO-2 code of the exit IP (e.g. "US"), from geo-lookup at test time
  status: text("status").notNull().default("live"),
  lastChecked: timestamp("last_checked").defaultNow(),
});

export const botSettings = pgTable("bot_settings", {
  id: varchar("id").primaryKey().default(sql`'default'`),
  botToken: text("bot_token"),
  chatId: text("chat_id"),
  ownerId: text("owner_id"),
  adminPassword: text("admin_password").notNull().default("926696"),
  botRunning: boolean("bot_running").notNull().default(false),
  parallelMode: boolean("parallel_mode").notNull().default(true),
  proxyFileOutput: boolean("proxy_file_output").notNull().default(true),
  lstmAutoTrain: boolean("lstm_auto_train").notNull().default(true),
  sendLiveToChannel: boolean("send_live_to_channel").notNull().default(true),
  defaultDailyLimit: integer("default_daily_limit").notNull().default(100),
  defaultKeyDurationDays: integer("default_key_duration_days").notNull().default(30),
  hitterEnabled: boolean("hitter_enabled").notNull().default(true),
  genEnabled: boolean("gen_enabled").notNull().default(true),
  maxGenPerRequest: integer("max_gen_per_request").notNull().default(10),
  welcomeMessage: text("welcome_message"),
  // Mass-check parallelism & velocity guard
  massWorkers: integer("mass_workers").notNull().default(1),
  massDedup: boolean("mass_dedup").notNull().default(true),
  massVelocityMins: integer("mass_velocity_mins").notNull().default(15),
  // Free tier via channel membership: when enabled, anyone in the
  // configured `chatId` channel can use /chk (only) with the daily cap
  // below. Off by default — opt-in, won't change existing installs.
  freeTierEnabled: boolean("free_tier_enabled").notNull().default(false),
  freeTierDailyLimit: integer("free_tier_daily_limit").notNull().default(5),
});

export const systemLogs = pgTable("system_logs", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  level: text("level").notNull().default("INFO"),
  message: text("message").notNull(),
  source: text("source").notNull().default("system"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const proxyConfig = pgTable("proxy_config", {
  id: varchar("id").primaryKey().default(sql`'default'`),
  enabled: boolean("enabled").notNull().default(true),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const minerConfig = pgTable("miner_config", {
  id: varchar("id").primaryKey().default(sql`'default'`),
  isRunning: boolean("is_running").notNull().default(false),
  gateId: text("gate_id"),
  binList: jsonb("bin_list").notNull().default([]),
  delaySecs: integer("delay_secs").notNull().default(3),
  maxCardsPerBin: integer("max_cards_per_bin").notNull().default(50),
  notifyEnabled: boolean("notify_enabled").notNull().default(true),
  parallelGates: integer("parallel_gates").notNull().default(1),
  totalTried: integer("total_tried").notNull().default(0),
  totalApproved: integer("total_approved").notNull().default(0),
  currentBin: text("current_bin"),
  startedAt: timestamp("started_at"),
  stoppedAt: timestamp("stopped_at"),
});

export const insertMinerConfigSchema = createInsertSchema(minerConfig).omit({ id: true });
export const insertUserSchema = createInsertSchema(users).pick({ username: true, password: true });
export const insertBotUserSchema = createInsertSchema(botUsers).omit({ id: true, createdAt: true });
export const insertGateConfigSchema = createInsertSchema(gateConfigs).omit({ id: true, createdAt: true });
export const insertAccessKeySchema = createInsertSchema(accessKeys).omit({ id: true, createdAt: true });
export const insertCheckResultSchema = createInsertSchema(checkResults).omit({ id: true, createdAt: true });
export const insertProxySchema = createInsertSchema(proxies).omit({ id: true, lastChecked: true });
export const insertBotSettingsSchema = createInsertSchema(botSettings).omit({ id: true });
export const insertSystemLogSchema = createInsertSchema(systemLogs).omit({ id: true, createdAt: true });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type BotUser = typeof botUsers.$inferSelect;
export type InsertBotUser = z.infer<typeof insertBotUserSchema>;
export type GateConfig = typeof gateConfigs.$inferSelect;
export type InsertGateConfig = z.infer<typeof insertGateConfigSchema>;
export type AccessKey = typeof accessKeys.$inferSelect;
export type InsertAccessKey = z.infer<typeof insertAccessKeySchema>;
export type CheckResult = typeof checkResults.$inferSelect;
export type InsertCheckResult = z.infer<typeof insertCheckResultSchema>;
export type Proxy = typeof proxies.$inferSelect;
export type InsertProxy = z.infer<typeof insertProxySchema>;
export type BotSettings = typeof botSettings.$inferSelect;
export type InsertBotSettings = z.infer<typeof insertBotSettingsSchema>;
export type SystemLog = typeof systemLogs.$inferSelect;
export type InsertSystemLog = z.infer<typeof insertSystemLogSchema>;
export type ProxyConfig = typeof proxyConfig.$inferSelect;
export type MinerConfig = typeof minerConfig.$inferSelect;
export type InsertMinerConfig = z.infer<typeof insertMinerConfigSchema>;
