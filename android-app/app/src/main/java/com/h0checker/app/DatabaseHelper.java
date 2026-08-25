package com.h0checker.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.UUID;

public class DatabaseHelper extends SQLiteOpenHelper {

    private static final String TAG = "DatabaseHelper";
    private static final String DB_NAME = "h0checker.db";
    private static final int DB_VERSION = 2;

    private static DatabaseHelper instance;

    public static synchronized DatabaseHelper getInstance(Context context) {
        if (instance == null) {
            instance = new DatabaseHelper(context.getApplicationContext());
        }
        return instance;
    }

    private DatabaseHelper(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, role TEXT DEFAULT 'admin')");
        db.execSQL("CREATE TABLE gate_configs (id TEXT PRIMARY KEY, name TEXT, gate_type TEXT, sub_type TEXT, url TEXT, active INTEGER DEFAULT 1, country TEXT, settings TEXT, created_at TEXT)");
        db.execSQL("CREATE TABLE check_results (id TEXT PRIMARY KEY, card TEXT, status TEXT, response TEXT, raw_snippet TEXT, gate TEXT, latency INTEGER, checked_by TEXT, created_at TEXT)");
        db.execSQL("CREATE TABLE proxies (id TEXT PRIMARY KEY, ip TEXT, port INTEGER, protocol TEXT, username TEXT, password TEXT, latency INTEGER DEFAULT 0, anonymity TEXT, country TEXT, status TEXT DEFAULT 'unknown', last_checked TEXT)");
        db.execSQL("CREATE TABLE access_keys (id TEXT PRIMARY KEY, key TEXT UNIQUE, duration_days INTEGER DEFAULT 30, daily_limit INTEGER DEFAULT 100, status TEXT DEFAULT 'active', redeemed_by TEXT, created_at TEXT, expires_at TEXT)");
        db.execSQL("CREATE TABLE bot_settings (id TEXT PRIMARY KEY, bot_token TEXT, chat_id TEXT, owner_id TEXT, admin_password TEXT, bot_running INTEGER DEFAULT 0, parallel_mode INTEGER DEFAULT 1, proxy_file_output INTEGER DEFAULT 1, lstm_auto_train INTEGER DEFAULT 1, send_live_to_channel INTEGER DEFAULT 1, hitter_enabled INTEGER DEFAULT 0, gen_enabled INTEGER DEFAULT 0, default_daily_limit INTEGER DEFAULT 100, default_key_duration_days INTEGER DEFAULT 30, max_gen_per_request INTEGER DEFAULT 10, mass_workers INTEGER DEFAULT 5, free_tier_enabled INTEGER DEFAULT 0, free_tier_daily_limit INTEGER DEFAULT 10, welcome_message TEXT DEFAULT 'Welcome to H@0 Checker!')");
        db.execSQL("CREATE TABLE system_logs (id TEXT PRIMARY KEY, level TEXT, message TEXT, source TEXT, created_at TEXT)");
        db.execSQL("CREATE TABLE miner_config (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, gate_id TEXT, bin_list TEXT, delay_secs INTEGER DEFAULT 5)");

        // Default admin
        ContentValues cv = new ContentValues();
        cv.put("id", "admin-001");
        cv.put("username", "admin");
        cv.put("password", "926696");
        cv.put("role", "admin");
        db.insert("users", null, cv);

        // Default bot settings
        ContentValues bs = new ContentValues();
        bs.put("id", "default");
        bs.put("admin_password", "926696");
        db.insert("bot_settings", null, bs);

        Log.i(TAG, "Database created");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // Migrate: add columns if missing
        if (oldVersion < 2) {
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN send_live_to_channel INTEGER DEFAULT 1"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN hitter_enabled INTEGER DEFAULT 0"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN gen_enabled INTEGER DEFAULT 0"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN default_daily_limit INTEGER DEFAULT 100"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN default_key_duration_days INTEGER DEFAULT 30"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN max_gen_per_request INTEGER DEFAULT 10"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN mass_workers INTEGER DEFAULT 5"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN free_tier_enabled INTEGER DEFAULT 0"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN free_tier_daily_limit INTEGER DEFAULT 10"); } catch (Exception ignored) {}
            try { db.execSQL("ALTER TABLE bot_settings ADD COLUMN welcome_message TEXT DEFAULT 'Welcome to H@0 Checker!'"); } catch (Exception ignored) {}
        }
    }

    private String now() {
        return new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.US).format(new Date());
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    public JSONObject login(String username, String password) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM users WHERE username=? AND password=?", new String[]{username, password});
        try {
            if (c.moveToFirst()) {
                JSONObject user = new JSONObject();
                user.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                user.put("username", c.getString(c.getColumnIndexOrThrow("username")));
                user.put("role", c.getString(c.getColumnIndexOrThrow("role")));
                return user;
            }
        } catch (JSONException e) { Log.e(TAG, "login error", e); }
        finally { c.close(); }
        return null;
    }

    // ── Gate Configs ──────────────────────────────────────────────────────
    public JSONArray getGates() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM gate_configs ORDER BY created_at DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) arr.put(cursorToGate(c));
        } catch (JSONException e) { Log.e(TAG, "getGates", e); }
        finally { c.close(); }
        return arr;
    }

    public JSONObject getGate(String id) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM gate_configs WHERE id=?", new String[]{id});
        try {
            if (c.moveToFirst()) return cursorToGate(c);
        } catch (JSONException e) { Log.e(TAG, "getGate", e); }
        finally { c.close(); }
        return null;
    }

    public JSONObject createGate(String id, String name, String gateType, String subType,
                                  String url, boolean active, String country, String settings) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("name", name);
        cv.put("gate_type", gateType);
        cv.put("sub_type", subType);
        cv.put("url", url);
        cv.put("active", active ? 1 : 0);
        cv.put("country", country != null ? country : "");
        cv.put("settings", settings != null ? settings : "{}");
        cv.put("created_at", now());
        db.insert("gate_configs", null, cv);
        return getGate(id);
    }

    public void updateGate(String id, String name, String gateType, String subType,
                           String url, boolean active, String country, String settings) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("name", name);
        cv.put("gate_type", gateType);
        cv.put("sub_type", subType);
        cv.put("url", url);
        cv.put("active", active ? 1 : 0);
        cv.put("country", country != null ? country : "");
        cv.put("settings", settings != null ? settings : "{}");
        db.update("gate_configs", cv, "id=?", new String[]{id});
    }

    public void deleteGate(String id) {
        getWritableDatabase().delete("gate_configs", "id=?", new String[]{id});
    }

    private JSONObject cursorToGate(Cursor c) throws JSONException {
        JSONObject gate = new JSONObject();
        gate.put("id", c.getString(c.getColumnIndexOrThrow("id")));
        gate.put("name", c.getString(c.getColumnIndexOrThrow("name")));
        gate.put("gateType", c.getString(c.getColumnIndexOrThrow("gate_type")));
        gate.put("subType", c.getString(c.getColumnIndexOrThrow("sub_type")));
        gate.put("url", c.getString(c.getColumnIndexOrThrow("url")));
        gate.put("active", c.getInt(c.getColumnIndexOrThrow("active")) == 1);
        gate.put("country", c.getString(c.getColumnIndexOrThrow("country")));
        String settingsStr = c.getString(c.getColumnIndexOrThrow("settings"));
        gate.put("settings", settingsStr != null ? new JSONObject(settingsStr) : new JSONObject());
        gate.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
        return gate;
    }

    // ── Gate Health ───────────────────────────────────────────────────────
    public JSONObject getGateHealth(String gateId) {
        JSONObject health = new JSONObject();
        try {
            JSONObject gate = getGate(gateId);
            if (gate == null) {
                health.put("checks10min", 0); health.put("blocks", 0);
                health.put("lastCheck", JSONObject.NULL); health.put("url", JSONObject.NULL);
                return health;
            }
            String gateName = gate.optString("name", "");
            String url = gate.optString("url", "");
            SQLiteDatabase db = getReadableDatabase();

            Cursor c1 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE gate=?", new String[]{gateName});
            int total = 0; if (c1.moveToFirst()) total = c1.getInt(0); c1.close();

            Cursor c2 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE gate=? AND status='error'", new String[]{gateName});
            int blocks = 0; if (c2.moveToFirst()) blocks = c2.getInt(0); c2.close();

            Cursor c3 = db.rawQuery("SELECT created_at FROM check_results WHERE gate=? ORDER BY created_at DESC LIMIT 1", new String[]{gateName});
            String lastCheck = null; if (c3.moveToFirst()) lastCheck = c3.getString(0); c3.close();

            health.put("checks10min", total);
            health.put("blocks", blocks);
            health.put("lastCheck", lastCheck != null ? lastCheck : JSONObject.NULL);
            health.put("url", url);
        } catch (JSONException e) { Log.e(TAG, "getGateHealth", e); }
        return health;
    }

    // ── Failure Suggestions ──────────────────────────────────────────────
    public JSONObject getFailureSuggestions(String gateId) {
        JSONObject result = new JSONObject();
        try {
            JSONObject gate = getGate(gateId);
            if (gate == null) { result.put("sampleSize", 0); result.put("suggestions", new JSONArray()); return result; }

            String gateName = gate.optString("name", "");
            SQLiteDatabase db = getReadableDatabase();
            Cursor c = db.rawQuery("SELECT status, response FROM check_results WHERE gate=? ORDER BY created_at DESC LIMIT 200", new String[]{gateName});

            int total = 0, approved = 0, declined = 0, errors = 0;
            int captcha = 0, nonce = 0, rateLimited = 0, proxyErr = 0;

            while (c.moveToNext()) {
                total++;
                String status = c.getString(0);
                String response = c.getString(1);
                if ("approved".equals(status)) approved++;
                else if ("declined".equals(status)) declined++;
                else if ("error".equals(status)) errors++;
                if (response != null) {
                    String lower = response.toLowerCase();
                    if (lower.contains("captcha")) captcha++;
                    if (lower.contains("nonce") || lower.contains("session expired")) nonce++;
                    if (lower.contains("rate") || lower.contains("429")) rateLimited++;
                    if (lower.contains("proxy") || lower.contains("timeout")) proxyErr++;
                }
            }
            c.close();

            JSONObject stats = new JSONObject();
            stats.put("approved", approved); stats.put("declined", declined); stats.put("errors", errors);
            stats.put("captchaCount", captcha); stats.put("nonceCount", nonce);
            stats.put("rateLimited", rateLimited); stats.put("proxyErr", proxyErr);

            JSONArray suggestions = new JSONArray();
            if (captcha >= 3) { JSONObject s = new JSONObject(); s.put("reason", captcha + "/" + total + " captcha responses"); s.put("settings", new JSONObject().put("captchaProvider", "2captcha")); s.put("confidence", 0.85); suggestions.put(s); }
            if (nonce >= 5) { JSONObject s = new JSONObject(); s.put("reason", nonce + "/" + total + " nonce/session errors"); s.put("settings", new JSONObject().put("wcBlockCheckout", true)); s.put("confidence", 0.80); suggestions.put(s); }
            if (rateLimited >= 3) { JSONObject s = new JSONObject(); s.put("reason", rateLimited + "/" + total + " rate-limit responses"); s.put("settings", new JSONObject().put("useProxies", true)); s.put("confidence", 0.75); suggestions.put(s); }
            if (proxyErr >= 3) { JSONObject s = new JSONObject(); s.put("reason", proxyErr + "/" + total + " proxy errors"); s.put("settings", new JSONObject().put("proxyRetries", 3)); s.put("confidence", 0.70); suggestions.put(s); }

            result.put("sampleSize", total); result.put("stats", stats); result.put("suggestions", suggestions);
        } catch (JSONException e) { Log.e(TAG, "getFailureSuggestions", e); }
        return result;
    }

    // ── Check Results ─────────────────────────────────────────────────────
    public JSONArray getCheckResults() {
        return getCheckResults(200);
    }

    public JSONArray getCheckResults(int limit) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM check_results ORDER BY created_at DESC LIMIT " + limit, null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
                JSONObject r = new JSONObject();
                r.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                r.put("card", c.getString(c.getColumnIndexOrThrow("card")));
                r.put("status", c.getString(c.getColumnIndexOrThrow("status")));
                r.put("response", c.getString(c.getColumnIndexOrThrow("response")));
                r.put("rawSnippet", c.getString(c.getColumnIndexOrThrow("raw_snippet")));
                r.put("gate", c.getString(c.getColumnIndexOrThrow("gate")));
                r.put("latency", c.getInt(c.getColumnIndexOrThrow("latency")));
                r.put("checkedBy", c.getString(c.getColumnIndexOrThrow("checked_by")));
                r.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
                arr.put(r);
            }
        } catch (JSONException e) { Log.e(TAG, "getCheckResults", e); }
        finally { c.close(); }
        return arr;
    }

    public JSONArray getCheckResultsFiltered(String status, int limit) {
        SQLiteDatabase db = getReadableDatabase();
        String query = "SELECT * FROM check_results";
        String[] args = null;
        if (status != null && !status.isEmpty()) {
            query += " WHERE status=?";
            args = new String[]{status};
        }
        query += " ORDER BY created_at DESC LIMIT " + limit;
        Cursor c = db.rawQuery(query, args);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
                JSONObject r = new JSONObject();
                r.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                r.put("card", c.getString(c.getColumnIndexOrThrow("card")));
                r.put("status", c.getString(c.getColumnIndexOrThrow("status")));
                r.put("response", c.getString(c.getColumnIndexOrThrow("response")));
                r.put("gate", c.getString(c.getColumnIndexOrThrow("gate")));
                r.put("latency", c.getInt(c.getColumnIndexOrThrow("latency")));
                r.put("checkedBy", c.getString(c.getColumnIndexOrThrow("checked_by")));
                r.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
                arr.put(r);
            }
        } catch (JSONException e) { Log.e(TAG, "getCheckResultsFiltered", e); }
        finally { c.close(); }
        return arr;
    }

    public int getCheckResultCount(String status) {
        SQLiteDatabase db = getReadableDatabase();
        String query = "SELECT COUNT(*) FROM check_results";
        String[] args = null;
        if (status != null && !status.isEmpty()) {
            query += " WHERE status=?";
            args = new String[]{status};
        }
        Cursor c = db.rawQuery(query, args);
        int count = 0;
        if (c.moveToFirst()) count = c.getInt(0);
        c.close();
        return count;
    }

    public void addCheckResult(String id, String card, String status, String response,
                               String gate, int latency, String checkedBy) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("card", card);
        cv.put("status", status);
        cv.put("response", response);
        cv.put("gate", gate);
        cv.put("latency", latency);
        cv.put("checked_by", checkedBy);
        cv.put("created_at", now());
        db.insert("check_results", null, cv);
    }

    public int deleteCheckResults(String status) {
        SQLiteDatabase db = getWritableDatabase();
        if (status != null && !status.isEmpty()) {
            return db.delete("check_results", "status=?", new String[]{status});
        }
        int count = db.delete("check_results", null, null);
        return count;
    }

    // ── Proxies ───────────────────────────────────────────────────────────
    public JSONArray getProxies() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM proxies ORDER BY last_checked DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) arr.put(cursorToProxy(c));
        } catch (JSONException e) { Log.e(TAG, "getProxies", e); }
        finally { c.close(); }
        return arr;
    }

    public JSONObject createProxy(String id, String ip, int port, String protocol,
                                   String username, String password) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("ip", ip);
        cv.put("port", port);
        cv.put("protocol", protocol != null ? protocol : "http");
        cv.put("username", username != null ? username : "");
        cv.put("password", password != null ? password : "");
        cv.put("latency", 0);
        cv.put("status", "unknown");
        cv.put("last_checked", now());
        db.insert("proxies", null, cv);
        return getProxy(id);
    }

    public JSONObject getProxy(String id) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM proxies WHERE id=?", new String[]{id});
        try {
            if (c.moveToFirst()) return cursorToProxy(c);
        } catch (JSONException e) { Log.e(TAG, "getProxy", e); }
        finally { c.close(); }
        return null;
    }

    public void deleteProxy(String id) {
        getWritableDatabase().delete("proxies", "id=?", new String[]{id});
    }

    public void clearProxies() {
        getWritableDatabase().delete("proxies", null, null);
    }

    public int clearDeadProxies() {
        return getWritableDatabase().delete("proxies", "status=? OR status=?", new String[]{"dead", "error"});
    }

    public JSONObject getProxyStats() {
        JSONObject stats = new JSONObject();
        try {
            SQLiteDatabase db = getReadableDatabase();
            Cursor c1 = db.rawQuery("SELECT COUNT(*) FROM proxies", null);
            int total = 0; if (c1.moveToFirst()) total = c1.getInt(0); c1.close();

            Cursor c2 = db.rawQuery("SELECT COUNT(*) FROM proxies WHERE status='live'", null);
            int live = 0; if (c2.moveToFirst()) live = c2.getInt(0); c2.close();

            Cursor c3 = db.rawQuery("SELECT AVG(latency) FROM proxies WHERE status='live'", null);
            double avgLatency = 0; if (c3.moveToFirst()) avgLatency = c3.getDouble(0); c3.close();

            stats.put("total", total);
            stats.put("live", live);
            stats.put("avgLatency", (int) avgLatency);
        } catch (JSONException e) { Log.e(TAG, "getProxyStats", e); }
        return stats;
    }

    private JSONObject cursorToProxy(Cursor c) throws JSONException {
        JSONObject p = new JSONObject();
        p.put("id", c.getString(c.getColumnIndexOrThrow("id")));
        p.put("ip", c.getString(c.getColumnIndexOrThrow("ip")));
        p.put("port", c.getInt(c.getColumnIndexOrThrow("port")));
        p.put("protocol", c.getString(c.getColumnIndexOrThrow("protocol")));
        p.put("username", c.getString(c.getColumnIndexOrThrow("username")));
        p.put("password", c.getString(c.getColumnIndexOrThrow("password")));
        p.put("latency", c.getInt(c.getColumnIndexOrThrow("latency")));
        p.put("anonymity", c.getString(c.getColumnIndexOrThrow("anonymity")));
        p.put("country", c.getString(c.getColumnIndexOrThrow("country")));
        p.put("status", c.getString(c.getColumnIndexOrThrow("status")));
        p.put("lastChecked", c.getString(c.getColumnIndexOrThrow("last_checked")));
        return p;
    }

    // ── Access Keys ───────────────────────────────────────────────────────
    public JSONArray getKeys() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM access_keys ORDER BY created_at DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) arr.put(cursorToKey(c));
        } catch (JSONException e) { Log.e(TAG, "getKeys", e); }
        finally { c.close(); }
        return arr;
    }

    public JSONObject createKey(String id, String key, int durationDays, int dailyLimit) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("key", key);
        cv.put("duration_days", durationDays);
        cv.put("daily_limit", dailyLimit);
        cv.put("status", "active");
        cv.put("created_at", now());
        db.insert("access_keys", null, cv);
        return getKey(id);
    }

    public JSONObject getKey(String id) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM access_keys WHERE id=?", new String[]{id});
        try {
            if (c.moveToFirst()) return cursorToKey(c);
        } catch (JSONException e) { Log.e(TAG, "getKey", e); }
        finally { c.close(); }
        return null;
    }

    public void deleteKey(String id) {
        getWritableDatabase().delete("access_keys", "id=?", new String[]{id});
    }

    private JSONObject cursorToKey(Cursor c) throws JSONException {
        JSONObject k = new JSONObject();
        k.put("id", c.getString(c.getColumnIndexOrThrow("id")));
        k.put("key", c.getString(c.getColumnIndexOrThrow("key")));
        k.put("durationDays", c.getInt(c.getColumnIndexOrThrow("duration_days")));
        k.put("dailyLimit", c.getInt(c.getColumnIndexOrThrow("daily_limit")));
        k.put("status", c.getString(c.getColumnIndexOrThrow("status")));
        k.put("redeemedBy", c.getString(c.getColumnIndexOrThrow("redeemed_by")));
        k.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
        k.put("expiresAt", c.getString(c.getColumnIndexOrThrow("expires_at")));
        return k;
    }

    // ── Bot Settings ──────────────────────────────────────────────────────
    public JSONObject getBotSettings() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM bot_settings WHERE id='default'", null);
        try {
            if (c.moveToFirst()) {
                JSONObject s = new JSONObject();
                s.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                s.put("botToken", c.getString(c.getColumnIndexOrThrow("bot_token")));
                s.put("chatId", c.getString(c.getColumnIndexOrThrow("chat_id")));
                s.put("ownerId", c.getString(c.getColumnIndexOrThrow("owner_id")));
                s.put("adminPassword", c.getString(c.getColumnIndexOrThrow("admin_password")));
                s.put("botRunning", c.getInt(c.getColumnIndexOrThrow("bot_running")) == 1);
                s.put("parallelMode", c.getInt(c.getColumnIndexOrThrow("parallel_mode")) == 1);
                s.put("proxyFileOutput", c.getInt(c.getColumnIndexOrThrow("proxy_file_output")) == 1);
                s.put("lstmAutoTrain", c.getInt(c.getColumnIndexOrThrow("lstm_auto_train")) == 1);
                s.put("sendLiveToChannel", c.getInt(c.getColumnIndexOrThrow("send_live_to_channel")) == 1);
                s.put("hitterEnabled", c.getInt(c.getColumnIndexOrThrow("hitter_enabled")) == 1);
                s.put("genEnabled", c.getInt(c.getColumnIndexOrThrow("gen_enabled")) == 1);
                s.put("defaultDailyLimit", c.getInt(c.getColumnIndexOrThrow("default_daily_limit")));
                s.put("defaultKeyDurationDays", c.getInt(c.getColumnIndexOrThrow("default_key_duration_days")));
                s.put("maxGenPerRequest", c.getInt(c.getColumnIndexOrThrow("max_gen_per_request")));
                s.put("massWorkers", c.getInt(c.getColumnIndexOrThrow("mass_workers")));
                s.put("freeTierEnabled", c.getInt(c.getColumnIndexOrThrow("free_tier_enabled")) == 1);
                s.put("freeTierDailyLimit", c.getInt(c.getColumnIndexOrThrow("free_tier_daily_limit")));
                s.put("welcomeMessage", c.getString(c.getColumnIndexOrThrow("welcome_message")));
                return s;
            }
        } catch (JSONException e) { Log.e(TAG, "getBotSettings", e); }
        finally { c.close(); }
        return new JSONObject();
    }

    public void updateBotSettings(JSONObject settings) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        try {
            if (settings.has("botToken")) cv.put("bot_token", settings.getString("botToken"));
            if (settings.has("chatId")) cv.put("chat_id", settings.getString("chatId"));
            if (settings.has("ownerId")) cv.put("owner_id", settings.getString("ownerId"));
            if (settings.has("adminPassword")) cv.put("admin_password", settings.getString("adminPassword"));
            if (settings.has("botRunning")) cv.put("bot_running", settings.getBoolean("botRunning") ? 1 : 0);
            if (settings.has("parallelMode")) cv.put("parallel_mode", settings.getBoolean("parallelMode") ? 1 : 0);
            if (settings.has("proxyFileOutput")) cv.put("proxy_file_output", settings.getBoolean("proxyFileOutput") ? 1 : 0);
            if (settings.has("lstmAutoTrain")) cv.put("lstm_auto_train", settings.getBoolean("lstmAutoTrain") ? 1 : 0);
            if (settings.has("sendLiveToChannel")) cv.put("send_live_to_channel", settings.getBoolean("sendLiveToChannel") ? 1 : 0);
            if (settings.has("hitterEnabled")) cv.put("hitter_enabled", settings.getBoolean("hitterEnabled") ? 1 : 0);
            if (settings.has("genEnabled")) cv.put("gen_enabled", settings.getBoolean("genEnabled") ? 1 : 0);
            if (settings.has("defaultDailyLimit")) cv.put("default_daily_limit", settings.getInt("defaultDailyLimit"));
            if (settings.has("defaultKeyDurationDays")) cv.put("default_key_duration_days", settings.getInt("defaultKeyDurationDays"));
            if (settings.has("maxGenPerRequest")) cv.put("max_gen_per_request", settings.getInt("maxGenPerRequest"));
            if (settings.has("massWorkers")) cv.put("mass_workers", settings.getInt("massWorkers"));
            if (settings.has("freeTierEnabled")) cv.put("free_tier_enabled", settings.getBoolean("freeTierEnabled") ? 1 : 0);
            if (settings.has("freeTierDailyLimit")) cv.put("free_tier_daily_limit", settings.getInt("freeTierDailyLimit"));
            if (settings.has("welcomeMessage")) cv.put("welcome_message", settings.getString("welcomeMessage"));
            if (cv.size() > 0) db.update("bot_settings", cv, "id='default'", null);
        } catch (JSONException e) { Log.e(TAG, "updateBotSettings", e); }
    }

    // ── System Logs ───────────────────────────────────────────────────────
    public void addLog(String level, String message, String source) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", UUID.randomUUID().toString());
        cv.put("level", level);
        cv.put("message", message);
        cv.put("source", source);
        cv.put("created_at", now());
        db.insert("system_logs", null, cv);
    }

    public JSONArray getLogs() {
        return getLogs(100);
    }

    public JSONArray getLogs(int limit) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM system_logs ORDER BY created_at DESC LIMIT " + limit, null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
                JSONObject l = new JSONObject();
                l.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                l.put("level", c.getString(c.getColumnIndexOrThrow("level")));
                l.put("message", c.getString(c.getColumnIndexOrThrow("message")));
                l.put("source", c.getString(c.getColumnIndexOrThrow("source")));
                l.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
                arr.put(l);
            }
        } catch (JSONException e) { Log.e(TAG, "getLogs", e); }
        finally { c.close(); }
        return arr;
    }

    public void clearLogs() {
        getWritableDatabase().delete("system_logs", null, null);
    }

    // ── Dashboard Stats ───────────────────────────────────────────────────
    public JSONObject getDashboardStats() {
        JSONObject result = new JSONObject();
        try {
            JSONObject stats = getStats();
            JSONObject gateStats = new JSONObject();
            Cursor c1 = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM gate_configs", null);
            int totalGates = 0; if (c1.moveToFirst()) totalGates = c1.getInt(0); c1.close();
            Cursor c2 = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM gate_configs WHERE active=1", null);
            int activeGates = 0; if (c2.moveToFirst()) activeGates = c2.getInt(0); c2.close();

            gateStats.put("total", totalGates);
            gateStats.put("active", activeGates);
            result.put("gates", gateStats);

            // Check stats
            JSONObject checkStats = new JSONObject();
            int totalChecks = stats.optInt("totalChecks", 0);
            int liveCards = stats.optInt("liveCards", 0);
            checkStats.put("total", totalChecks);
            checkStats.put("approved", liveCards);
            checkStats.put("declined", getCheckResultCount("declined"));
            checkStats.put("errors", getCheckResultCount("error"));
            result.put("checks", checkStats);

            // Proxy stats
            result.put("proxies", getProxyStats());

            // Recent logs
            result.put("recentLogs", getLogs(20));

            // Gate list with key info
            JSONArray gatesArr = getGates();
            JSONArray gatesList = new JSONArray();
            for (int i = 0; i < gatesArr.length(); i++) {
                JSONObject g = gatesArr.getJSONObject(i);
                JSONObject gateInfo = new JSONObject();
                gateInfo.put("id", g.getString("id"));
                gateInfo.put("name", g.getString("name"));
                gateInfo.put("gateType", g.getString("gateType"));
                gateInfo.put("subType", g.getString("subType"));
                gateInfo.put("active", g.getBoolean("active"));
                JSONObject settings = g.optJSONObject("settings");
                gateInfo.put("hasKey", settings != null && (settings.has("publicKey") || settings.has("btClientToken")));
                gatesList.put(gateInfo);
            }
            result.put("gates", gateStats);
            result.put("gateList", gatesList);

        } catch (JSONException e) { Log.e(TAG, "getDashboardStats", e); }
        return result;
    }

    // ── System Stats ──────────────────────────────────────────────────────
    public JSONObject getStats() {
        SQLiteDatabase db = getReadableDatabase();
        JSONObject stats = new JSONObject();
        try {
            Cursor c1 = db.rawQuery("SELECT COUNT(*) FROM gate_configs", null);
            if (c1.moveToFirst()) stats.put("totalGates", c1.getInt(0)); c1.close();
            Cursor c2 = db.rawQuery("SELECT COUNT(*) FROM gate_configs WHERE active=1", null);
            if (c2.moveToFirst()) stats.put("activeGates", c2.getInt(0)); c2.close();
            Cursor c3 = db.rawQuery("SELECT COUNT(*) FROM check_results", null);
            if (c3.moveToFirst()) stats.put("totalChecks", c3.getInt(0)); c3.close();
            Cursor c4 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE status='approved'", null);
            if (c4.moveToFirst()) stats.put("liveCards", c4.getInt(0)); c4.close();
            Cursor c5 = db.rawQuery("SELECT COUNT(*) FROM proxies", null);
            if (c5.moveToFirst()) stats.put("totalProxies", c5.getInt(0)); c5.close();
            Cursor c6 = db.rawQuery("SELECT COUNT(*) FROM access_keys", null);
            if (c6.moveToFirst()) stats.put("totalKeys", c6.getInt(0)); c6.close();
            Cursor c7 = db.rawQuery("SELECT COUNT(*) FROM system_logs", null);
            if (c7.moveToFirst()) stats.put("totalLogs", c7.getInt(0)); c7.close();
            stats.put("uptime", android.os.SystemClock.elapsedRealtime() / 1000);
        } catch (JSONException e) { Log.e(TAG, "getStats", e); }
        return stats;
    }

    // ── Admin Reset ───────────────────────────────────────────────────────
    public JSONObject adminReset(String target) {
        SQLiteDatabase db = getWritableDatabase();
        String message = "";
        try {
            if ("all".equals(target) || "checks".equals(target)) {
                db.delete("check_results", null, null);
                message += "checks cleared; ";
            }
            if ("all".equals(target) || "users".equals(target)) {
                db.delete("users", null, null);
                // Re-create admin
                ContentValues cv = new ContentValues();
                cv.put("id", "admin-001"); cv.put("username", "admin");
                cv.put("password", "926696"); cv.put("role", "admin");
                db.insert("users", null, cv);
                message += "users reset; ";
            }
            if ("all".equals(target) || "gates".equals(target)) {
                db.delete("gate_configs", null, null);
                message += "gates cleared; ";
            }
            if ("all".equals(target) || "keys".equals(target)) {
                db.delete("access_keys", null, null);
                message += "keys cleared; ";
            }
            if ("all".equals(target) || "proxies".equals(target)) {
                db.delete("proxies", null, null);
                message += "proxies cleared; ";
            }
            if ("all".equals(target) || "logs".equals(target)) {
                db.delete("system_logs", null, null);
                message += "logs cleared; ";
            }
            JSONObject result = new JSONObject();
            result.put("success", true);
            result.put("message", "Reset complete: " + message);
            addLog("warn", "Admin reset: " + target, "admin");
            return result;
        } catch (JSONException e) {
            Log.e(TAG, "adminReset", e);
            try { return new JSONObject().put("success", false).put("message", e.getMessage()); }
            catch (JSONException ex) { return new JSONObject(); }
        }
    }
}
