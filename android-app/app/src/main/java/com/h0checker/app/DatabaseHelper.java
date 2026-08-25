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

public class DatabaseHelper extends SQLiteOpenHelper {

    private static final String TAG = "DatabaseHelper";
    private static final String DB_NAME = "h0checker.db";
    private static final int DB_VERSION = 1;

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
        db.execSQL("CREATE TABLE proxies (id TEXT PRIMARY KEY, ip TEXT, port INTEGER, protocol TEXT, username TEXT, password TEXT, latency INTEGER, anonymity TEXT, country TEXT, status TEXT, last_checked TEXT)");
        db.execSQL("CREATE TABLE access_keys (id TEXT PRIMARY KEY, key TEXT UNIQUE, duration_days INTEGER, daily_limit INTEGER, status TEXT, redeemed_by TEXT, created_at TEXT, expires_at TEXT)");
        db.execSQL("CREATE TABLE bot_settings (id TEXT PRIMARY KEY, bot_token TEXT, chat_id TEXT, owner_id TEXT, admin_password TEXT, bot_running INTEGER DEFAULT 0, parallel_mode INTEGER DEFAULT 1, proxy_file_output INTEGER DEFAULT 1, lstm_auto_train INTEGER DEFAULT 1)");
        db.execSQL("CREATE TABLE system_logs (id TEXT PRIMARY KEY, level TEXT, message TEXT, source TEXT, created_at TEXT)");
        db.execSQL("CREATE TABLE miner_config (id TEXT PRIMARY KEY, is_running INTEGER DEFAULT 0, gate_id TEXT, bin_list TEXT, delay_secs INTEGER DEFAULT 5)");

        // Insert default admin user
        ContentValues cv = new ContentValues();
        cv.put("id", "admin-001");
        cv.put("username", "admin");
        cv.put("password", "926696");
        cv.put("role", "admin");
        db.insert("users", null, cv);

        // Insert default bot settings
        ContentValues bs = new ContentValues();
        bs.put("id", "default");
        bs.put("admin_password", "926696");
        bs.put("bot_running", 0);
        bs.put("parallel_mode", 1);
        db.insert("bot_settings", null, bs);

        Log.i(TAG, "Database created with default data");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS users");
        db.execSQL("DROP TABLE IF EXISTS gate_configs");
        db.execSQL("DROP TABLE IF EXISTS check_results");
        db.execSQL("DROP TABLE IF EXISTS proxies");
        db.execSQL("DROP TABLE IF EXISTS access_keys");
        db.execSQL("DROP TABLE IF EXISTS bot_settings");
        db.execSQL("DROP TABLE IF EXISTS system_logs");
        db.execSQL("DROP TABLE IF EXISTS miner_config");
        onCreate(db);
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
        } catch (JSONException e) {
            Log.e(TAG, "login error", e);
        } finally {
            c.close();
        }
        return null;
    }

    // ── Gate Configs ──────────────────────────────────────────────────────
    public JSONArray getGates() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM gate_configs ORDER BY created_at DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
                JSONObject gate = cursorToGate(c);
                arr.put(gate);
            }
        } catch (JSONException e) {
            Log.e(TAG, "getGates error", e);
        } finally {
            c.close();
        }
        return arr;
    }

    public JSONObject createGate(String id, String name, String gateType, String subType, String url, boolean active, String country, String settings) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("name", name);
        cv.put("gate_type", gateType);
        cv.put("sub_type", subType);
        cv.put("url", url);
        cv.put("active", active ? 1 : 0);
        cv.put("country", country);
        cv.put("settings", settings);
        cv.put("created_at", java.text.SimpleDateFormat.getDateTimeInstance().format(new java.util.Date()));
        db.insert("gate_configs", null, cv);
        return getGate(id);
    }

    public JSONObject getGate(String id) {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM gate_configs WHERE id=?", new String[]{id});
        try {
            if (c.moveToFirst()) {
                return cursorToGate(c);
            }
        } catch (JSONException e) {
            Log.e(TAG, "getGate error", e);
        } finally {
            c.close();
        }
        return null;
    }

    public void updateGate(String id, String name, String gateType, String subType, String url, boolean active, String country, String settings) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("name", name);
        cv.put("gate_type", gateType);
        cv.put("sub_type", subType);
        cv.put("url", url);
        cv.put("active", active ? 1 : 0);
        cv.put("country", country);
        cv.put("settings", settings);
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

    // ── Check Results ─────────────────────────────────────────────────────
    public JSONArray getCheckResults() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM check_results ORDER BY created_at DESC LIMIT 200", null);
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
        } catch (JSONException e) {
            Log.e(TAG, "getCheckResults error", e);
        } finally {
            c.close();
        }
        return arr;
    }

    public void addCheckResult(String id, String card, String status, String response, String gate, int latency, String checkedBy) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", id);
        cv.put("card", card);
        cv.put("status", status);
        cv.put("response", response);
        cv.put("gate", gate);
        cv.put("latency", latency);
        cv.put("checked_by", checkedBy);
        cv.put("created_at", java.text.SimpleDateFormat.getDateTimeInstance().format(new java.util.Date()));
        db.insert("check_results", null, cv);
    }

    // ── Proxies ───────────────────────────────────────────────────────────
    public JSONArray getProxies() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM proxies ORDER BY last_checked DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
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
                arr.put(p);
            }
        } catch (JSONException e) {
            Log.e(TAG, "getProxies error", e);
        } finally {
            c.close();
        }
        return arr;
    }

    // ── Access Keys ───────────────────────────────────────────────────────
    public JSONArray getKeys() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM access_keys ORDER BY created_at DESC", null);
        JSONArray arr = new JSONArray();
        try {
            while (c.moveToNext()) {
                JSONObject k = new JSONObject();
                k.put("id", c.getString(c.getColumnIndexOrThrow("id")));
                k.put("key", c.getString(c.getColumnIndexOrThrow("key")));
                k.put("durationDays", c.getInt(c.getColumnIndexOrThrow("duration_days")));
                k.put("dailyLimit", c.getInt(c.getColumnIndexOrThrow("daily_limit")));
                k.put("status", c.getString(c.getColumnIndexOrThrow("status")));
                k.put("redeemedBy", c.getString(c.getColumnIndexOrThrow("redeemed_by")));
                k.put("createdAt", c.getString(c.getColumnIndexOrThrow("created_at")));
                k.put("expiresAt", c.getString(c.getColumnIndexOrThrow("expires_at")));
                arr.put(k);
            }
        } catch (JSONException e) {
            Log.e(TAG, "getKeys error", e);
        } finally {
            c.close();
        }
        return arr;
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
                return s;
            }
        } catch (JSONException e) {
            Log.e(TAG, "getBotSettings error", e);
        } finally {
            c.close();
        }
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
            db.update("bot_settings", cv, "id='default'", null);
        } catch (JSONException e) {
            Log.e(TAG, "updateBotSettings error", e);
        }
    }

    // ── System Logs ───────────────────────────────────────────────────────
    public void addLog(String level, String message, String source) {
        SQLiteDatabase db = getWritableDatabase();
        ContentValues cv = new ContentValues();
        cv.put("id", java.util.UUID.randomUUID().toString());
        cv.put("level", level);
        cv.put("message", message);
        cv.put("source", source);
        cv.put("created_at", java.text.SimpleDateFormat.getDateTimeInstance().format(new java.util.Date()));
        db.insert("system_logs", null, cv);
    }

    public JSONArray getLogs() {
        SQLiteDatabase db = getReadableDatabase();
        Cursor c = db.rawQuery("SELECT * FROM system_logs ORDER BY created_at DESC LIMIT 100", null);
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
        } catch (JSONException e) {
            Log.e(TAG, "getLogs error", e);
        } finally {
            c.close();
        }
        return arr;
    }

    // ── Gate Health ───────────────────────────────────────────────────────
    public JSONObject getGateHealth(String gateId) {
        JSONObject health = new JSONObject();
        try {
            JSONObject gate = getGate(gateId);
            if (gate == null) {
                health.put("checks10min", 0);
                health.put("blocks", 0);
                health.put("lastCheck", JSONObject.NULL);
                health.put("url", JSONObject.NULL);
                return health;
            }

            String gateName = gate.optString("name", "");
            String url = gate.optString("url", "");

            SQLiteDatabase db = getReadableDatabase();
            // Count checks for this gate
            Cursor c1 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE gate=?", new String[]{gateName});
            int totalChecks = 0;
            if (c1.moveToFirst()) totalChecks = c1.getInt(0);
            c1.close();

            // Count errors (blocks)
            Cursor c2 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE gate=? AND status='error'", new String[]{gateName});
            int blocks = 0;
            if (c2.moveToFirst()) blocks = c2.getInt(0);
            c2.close();

            // Last check time
            Cursor c3 = db.rawQuery("SELECT created_at FROM check_results WHERE gate=? ORDER BY created_at DESC LIMIT 1", new String[]{gateName});
            String lastCheck = null;
            if (c3.moveToFirst()) lastCheck = c3.getString(0);
            c3.close();

            health.put("checks10min", totalChecks);
            health.put("blocks", blocks);
            health.put("lastCheck", lastCheck != null ? lastCheck : JSONObject.NULL);
            health.put("url", url);
        } catch (JSONException e) {
            Log.e(TAG, "getGateHealth error", e);
        }
        return health;
    }

    // ── Failure Suggestions ──────────────────────────────────────────────
    public JSONObject getFailureSuggestions(String gateId) {
        JSONObject result = new JSONObject();
        try {
            JSONObject gate = getGate(gateId);
            if (gate == null) {
                result.put("sampleSize", 0);
                result.put("suggestions", new JSONArray());
                return result;
            }

            String gateName = gate.optString("name", "");
            SQLiteDatabase db = getReadableDatabase();

            // Get last 200 results for this gate
            Cursor c = db.rawQuery(
                "SELECT status, response FROM check_results WHERE gate=? ORDER BY created_at DESC LIMIT 200",
                new String[]{gateName});

            int total = 0, approved = 0, declined = 0, errors = 0;
            int captchaCount = 0, nonceCount = 0, rateLimited = 0, proxyErr = 0;

            while (c.moveToNext()) {
                total++;
                String status = c.getString(0);
                String response = c.getString(1);
                if ("approved".equals(status)) approved++;
                else if ("declined".equals(status)) declined++;
                else if ("error".equals(status)) errors++;

                if (response != null) {
                    String lower = response.toLowerCase();
                    if (lower.contains("captcha")) captchaCount++;
                    if (lower.contains("nonce") || lower.contains("session expired")) nonceCount++;
                    if (lower.contains("rate") || lower.contains("too many requests") || lower.contains("429")) rateLimited++;
                    if (lower.contains("proxy") || lower.contains("econnrefused") || lower.contains("timeout")) proxyErr++;
                }
            }
            c.close();

            JSONObject stats = new JSONObject();
            stats.put("approved", approved);
            stats.put("declined", declined);
            stats.put("errors", errors);
            stats.put("captchaCount", captchaCount);
            stats.put("nonceCount", nonceCount);
            stats.put("rateLimited", rateLimited);
            stats.put("proxyErr", proxyErr);

            JSONArray suggestions = new JSONArray();

            if (captchaCount >= 3) {
                JSONObject s = new JSONObject();
                s.put("reason", captchaCount + "/" + total + " responses mention captcha");
                s.put("settings", new JSONObject().put("captchaProvider", "2captcha"));
                s.put("confidence", 0.85);
                suggestions.put(s);
            }
            if (nonceCount >= 5) {
                JSONObject s = new JSONObject();
                s.put("reason", nonceCount + "/" + total + " nonce/session errors — try Block Checkout flow");
                s.put("settings", new JSONObject().put("wcBlockCheckout", true));
                s.put("confidence", 0.80);
                suggestions.put(s);
            }
            if (rateLimited >= 3) {
                JSONObject s = new JSONObject();
                s.put("reason", rateLimited + "/" + total + " rate-limit responses — add proxy rotation");
                s.put("settings", new JSONObject().put("useProxies", true));
                s.put("confidence", 0.75);
                suggestions.put(s);
            }
            if (proxyErr >= 3) {
                JSONObject s = new JSONObject();
                s.put("reason", proxyErr + "/" + total + " proxy errors — check proxy config");
                s.put("settings", new JSONObject().put("proxyRetries", 3));
                s.put("confidence", 0.70);
                suggestions.put(s);
            }

            result.put("sampleSize", total);
            result.put("stats", stats);
            result.put("suggestions", suggestions);
        } catch (JSONException e) {
            Log.e(TAG, "getFailureSuggestions error", e);
        }
        return result;
    }

    // ── Stats ─────────────────────────────────────────────────────────────
    public JSONObject getStats() {
        SQLiteDatabase db = getReadableDatabase();
        JSONObject stats = new JSONObject();
        try {
            Cursor c1 = db.rawQuery("SELECT COUNT(*) FROM gate_configs", null);
            if (c1.moveToFirst()) stats.put("totalGates", c1.getInt(0));
            c1.close();

            Cursor c2 = db.rawQuery("SELECT COUNT(*) FROM gate_configs WHERE active=1", null);
            if (c2.moveToFirst()) stats.put("activeGates", c2.getInt(0));
            c2.close();

            Cursor c3 = db.rawQuery("SELECT COUNT(*) FROM check_results", null);
            if (c3.moveToFirst()) stats.put("totalChecks", c3.getInt(0));
            c3.close();

            Cursor c4 = db.rawQuery("SELECT COUNT(*) FROM check_results WHERE status='approved'", null);
            if (c4.moveToFirst()) stats.put("liveCards", c4.getInt(0));
            c4.close();

            Cursor c5 = db.rawQuery("SELECT COUNT(*) FROM proxies", null);
            if (c5.moveToFirst()) stats.put("totalProxies", c5.getInt(0));
            c5.close();

            Cursor c6 = db.rawQuery("SELECT COUNT(*) FROM access_keys", null);
            if (c6.moveToFirst()) stats.put("totalKeys", c6.getInt(0));
            c6.close();
        } catch (JSONException e) {
            Log.e(TAG, "getStats error", e);
        }
        return stats;
    }
}
