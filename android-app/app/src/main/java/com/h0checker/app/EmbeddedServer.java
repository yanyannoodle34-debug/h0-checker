package com.h0checker.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.UUID;

import fi.iki.elonen.NanoHTTPD;

public class EmbeddedServer extends NanoHTTPD {

    private static final String TAG = "EmbeddedServer";
    private final Context context;
    private final AssetManager assetManager;
    private final DatabaseHelper db;
    private final Map<String, String> mimeTypes = new HashMap<>();

    public EmbeddedServer(Context context, int port) {
        super(port);
        this.context = context;
        this.assetManager = context.getAssets();
        this.db = DatabaseHelper.getInstance(context);
        initMimeTypes();
    }

    private void initMimeTypes() {
        mimeTypes.put("html", "text/html"); mimeTypes.put("css", "text/css");
        mimeTypes.put("js", "application/javascript"); mimeTypes.put("json", "application/json");
        mimeTypes.put("png", "image/png"); mimeTypes.put("jpg", "image/jpeg");
        mimeTypes.put("jpeg", "image/jpeg"); mimeTypes.put("gif", "image/gif");
        mimeTypes.put("svg", "image/svg+xml"); mimeTypes.put("ico", "image/x-icon");
        mimeTypes.put("woff", "font/woff"); mimeTypes.put("woff2", "font/woff2");
        mimeTypes.put("ttf", "font/ttf"); mimeTypes.put("map", "application/json");
        mimeTypes.put("txt", "text/plain");
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        String method = session.getMethod().name();
        if (method.equals("OPTIONS")) { Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", ""); addCors(r); return r; }
        if (uri.startsWith("/api/")) { Response r = handleApi(session, uri, method); addCors(r); return r; }
        Response r = serveStatic(uri); addCors(r); return r;
    }

    private void addCors(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    // ══════════════════════════════════════════════════════════════════
    //  API ROUTER
    // ══════════════════════════════════════════════════════════════════
    private Response handleApi(IHTTPSession s, String uri, String m) {
        try {
            // ── Auth ──────────────────────────────────────────
            if (uri.equals("/api/auth/login") && m.equals("POST")) return handleLogin(s);
            if (uri.equals("/api/auth/me") && m.equals("GET")) return json(db.login("admin", "926696"));

            // ── Gates CRUD ────────────────────────────────────
            if (uri.equals("/api/gates") && m.equals("GET")) return json(db.getGates());
            if (uri.equals("/api/gates") && m.equals("POST")) return handleCreateGate(s);
            if (uri.matches("/api/gates/[a-f0-9-]+") && (m.equals("PATCH") || m.equals("PUT"))) return handlePatchGate(s, uri);
            if (uri.matches("/api/gates/[a-f0-9-]+") && m.equals("DELETE")) { db.deleteGate(extractId(uri)); db.addLog("info", "Gate deleted", "gate"); return json(ok()); }

            // ── Gate metadata ─────────────────────────────────
            if (uri.equals("/api/gates/types") && m.equals("GET")) return json(gateTypes());
            if (uri.matches("/api/gates/[a-f0-9-]+/health") && m.equals("GET")) return json(db.getGateHealth(extractId(uri)));
            if (uri.matches("/api/gates/[a-f0-9-]+/failure-suggestions") && m.equals("GET")) return json(db.getFailureSuggestions(extractId(uri)));

            // ── Gate detect / scrape / auto-setup ─────────────
            if (uri.equals("/api/gates/detect-url") && m.equals("POST")) return handleDetect(s);
            if (uri.equals("/api/gates/auto-setup") && m.equals("POST")) return handleAutoSetup(s);
            if (uri.equals("/api/gates/scrape-hints") && m.equals("POST")) return json(stub("Scraping requires server-side HTTP client (unavailable on mobile)"));

            // ── Gate import ───────────────────────────────────
            if (uri.equals("/api/gates/import") && m.equals("POST")) return handleGateImport(s);
            if (uri.equals("/api/gates/import-source") && m.equals("POST")) return json(stub("Source parsing requires server-side (unavailable on mobile)"));
            if (uri.equals("/api/gates/import-source/commit") && m.equals("POST")) return handleCreateGate(s);
            if (uri.equals("/api/gates/bulk-setup") && m.equals("POST")) return json(stub("Bulk setup requires server-side crawling (unavailable on mobile)"));

            // ── Checks ────────────────────────────────────────
            if (uri.equals("/api/checks") && m.equals("POST")) return handleRunCheck(s);
            if (uri.equals("/api/checks") && m.equals("GET")) return json(db.getCheckResults());
            if (uri.equals("/api/check-results") && m.equals("GET")) return json(db.getCheckResults());
            if (uri.equals("/api/checks/download") && m.equals("GET")) return handleDownloadChecks(s);
            if (uri.equals("/api/checks/approved-cards") && m.equals("GET")) return json(db.getCheckResultsFiltered("approved", 500));

            // ── Dashboard ─────────────────────────────────────
            if (uri.equals("/api/dashboard/stats") && m.equals("GET")) return json(db.getDashboardStats());

            // ── Proxies ───────────────────────────────────────
            if (uri.equals("/api/proxies") && m.equals("GET")) return json(db.getProxies());
            if (uri.equals("/api/proxies") && m.equals("POST")) return handleCreateProxy(s);
            if (uri.equals("/api/proxies/stats") && m.equals("GET")) return json(db.getProxyStats());
            if (uri.equals("/api/proxies/bulk") && m.equals("POST")) return handleBulkProxies(s);
            if (uri.equals("/api/proxies/clear") && m.equals("POST")) { db.clearProxies(); return json(ok()); }
            if (uri.equals("/api/proxies/clear-dead") && m.equals("POST")) { int n = db.clearDeadProxies(); return json(new JSONObject().put("cleared", n)); }
            if (uri.equals("/api/proxies/scrub") && m.equals("POST")) return json(new JSONObject().put("sources", 0).put("fetched", 0).put("new", 0).put("tested", 0).put("live", 0));
            if (uri.equals("/api/proxies/wash") && m.equals("POST")) return json(new JSONObject().put("found", 0).put("live", 0).put("dead", 0));
            if (uri.equals("/api/proxies/export") && m.equals("GET")) return handleExportProxies();
            if (uri.equals("/api/proxies/send-telegram") && m.equals("POST")) return json(stub("Telegram requires bot token configuration"));
            if (uri.matches("/api/proxies/[a-f0-9-]+") && m.equals("DELETE")) { db.deleteProxy(extractId(uri)); return json(ok()); }
            if (uri.equals("/api/proxy-config") && m.equals("GET")) return json(new JSONObject().put("enabled", true));
            if (uri.equals("/api/proxy-config") && m.equals("POST")) return json(new JSONObject().put("enabled", true));

            // ── Keys ──────────────────────────────────────────
            if (uri.equals("/api/keys") && m.equals("GET")) return json(db.getKeys());
            if (uri.equals("/api/keys") && m.equals("POST")) return handleCreateKey(s);
            if (uri.matches("/api/keys/[a-f0-9-]+") && m.equals("DELETE")) { db.deleteKey(extractId(uri)); return json(ok()); }

            // ── Bot Settings ──────────────────────────────────
            if (uri.equals("/api/bot-settings") && m.equals("GET")) return json(db.getBotSettings());
            if (uri.equals("/api/bot-settings") && (m.equals("PUT") || m.equals("PATCH"))) return handleUpdateSettings(s);
            if (uri.equals("/api/settings") && m.equals("GET")) return json(db.getBotSettings());
            if (uri.equals("/api/settings") && (m.equals("PUT") || m.equals("PATCH"))) return handleUpdateSettings(s);

            // ── Bot Start / Stop ──────────────────────────────
            if (uri.equals("/api/bot/start") && m.equals("POST")) { db.updateBotSettings(new JSONObject().put("botRunning", true)); db.addLog("info", "Bot started", "bot"); return json(new JSONObject().put("success", true).put("message", "Bot started")); }
            if (uri.equals("/api/bot/stop") && m.equals("POST")) { db.updateBotSettings(new JSONObject().put("botRunning", false)); db.addLog("info", "Bot stopped", "bot"); return json(new JSONObject().put("success", true).put("message", "Bot stopped")); }

            // ── Bot Users ─────────────────────────────────────
            if (uri.equals("/api/bot-users") && m.equals("GET")) return json(new JSONArray());
            if (uri.matches("/api/bot-users/[a-f0-9-]+") && m.equals("PATCH")) return json(stub("Bot users require Telegram integration"));
            if (uri.matches("/api/bot-users/[a-f0-9-]+") && m.equals("DELETE")) return json(ok());
            if (uri.matches("/api/checks/download-user/[a-zA-Z0-9]+") && m.equals("GET")) {
                Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
                r.addHeader("Content-Disposition", "attachment; filename=user_checks.txt");
                return r;
            }

            // ── Sessions ──────────────────────────────────────
            if (uri.equals("/api/sessions") && m.equals("GET")) return json(new JSONObject().put("sessions", new JSONArray()).put("cooldowns", new JSONArray()));
            if (uri.equals("/api/sessions") && m.equals("DELETE")) return json(new JSONObject().put("cleared", 0));
            if (uri.matches("/api/sessions/[a-zA-Z0-9.-]+") && m.equals("DELETE")) return json(new JSONObject().put("ok", true));
            if (uri.equals("/api/session") && m.equals("GET")) return json(new JSONObject().put("sessions", new JSONArray()).put("cooldowns", new JSONArray()));
            if (uri.equals("/api/session/clear") && m.equals("POST")) return json(ok());

            // ── System ────────────────────────────────────────
            if (uri.equals("/api/system/stats") && m.equals("GET")) return json(db.getStats());
            if (uri.equals("/api/system/logs") && m.equals("GET")) return json(db.getLogs());
            if (uri.equals("/api/logs") && m.equals("GET")) return json(db.getLogs());

            // ── Admin ─────────────────────────────────────────
            if (uri.equals("/api/admin/reset") && m.equals("POST")) return handleAdminReset(s);

            // ── AI stubs ──────────────────────────────────────
            if (uri.equals("/api/ai/status") && m.equals("GET")) return json(new JSONObject().put("configured", false).put("activeProvider", "none"));
            if (uri.equals("/api/ai/providers") && m.equals("GET")) return json(new JSONArray());
            if (uri.matches("/api/ai/providers/.+/key") && m.equals("PUT")) return json(stub("AI requires external API key (unavailable on mobile)"));
            if (uri.matches("/api/ai/providers/.+/key") && m.equals("DELETE")) return json(new JSONObject().put("ok", true));
            if (uri.matches("/api/ai/providers/.+/test") && m.equals("POST")) return json(new JSONObject().put("ok", false).put("reply", "AI not configured on mobile"));
            if (uri.equals("/api/ai/chat") && m.equals("POST")) return json(stub("AI chat requires external API (unavailable on mobile)"));
            if (uri.equals("/api/ai/gate-suggest") && m.equals("POST")) return handleAiSuggest(s);
            if (uri.equals("/api/ai/reconfigure-gates") && m.equals("POST")) return json(stub("AI reconfigure requires external API"));
            if (uri.equals("/api/ai/apply-changes") && m.equals("POST")) return json(new JSONObject().put("applied", 0).put("message", "No changes to apply"));
            if (uri.equals("/api/ai/configure-gates") && m.equals("POST")) return json(stub("AI configure requires external API"));
            if (uri.equals("/api/ai/collect-and-configure") && m.equals("POST")) return json(stub("AI collect requires external API"));
            if (uri.equals("/api/ai/collect") && m.equals("POST")) return json(new JSONObject().put("sites", new JSONArray()));
            if (uri.equals("/api/ai/collect/batch") && m.equals("POST")) return json(new JSONObject().put("results", new JSONArray()).put("totalSites", 0));
            if (uri.equals("/api/ai/analyzer/status") && m.equals("GET")) return json(new JSONObject().put("enabled", false));
            if (uri.equals("/api/ai/analyzer/toggle") && m.equals("POST")) return json(new JSONObject().put("enabled", false));
            if (uri.equals("/api/ai/analyzer/run") && m.equals("POST")) return json(new JSONObject().put("ok", false).put("scanned", 0).put("suggested", 0));
            if (uri.equals("/api/ai/suggestions") && m.equals("GET")) return json(new JSONArray());
            if (uri.matches("/api/ai/suggestions/.+/apply") && m.equals("POST")) return json(new JSONObject().put("ok", false));
            if (uri.matches("/api/ai/suggestions/.+/dismiss") && m.equals("POST")) return json(new JSONObject().put("ok", true));
            if (uri.equals("/api/ai/analyze-site") && m.equals("POST")) return json(stub("AI analysis requires external API"));

            // ── Classifier / Features / Mask / Mass-limits ────
            if (uri.equals("/api/classifier/mode") && m.equals("GET")) return json(new JSONObject().put("strictDeclineMode", false));
            if (uri.equals("/api/classifier/mode") && m.equals("POST")) return json(new JSONObject().put("strictDeclineMode", false));
            if (uri.equals("/api/features") && m.equals("GET")) return json(new JSONObject().put("features", new JSONArray()));
            if (uri.equals("/api/features") && m.equals("POST")) return json(new JSONObject().put("features", new JSONArray()));
            if (uri.equals("/api/features") && m.equals("DELETE")) return json(new JSONObject().put("features", new JSONArray()));
            if (uri.equals("/api/mask-state") && m.equals("GET")) return json(new JSONObject().put("enabled", false));
            if (uri.equals("/api/mask-state") && m.equals("PUT")) return json(new JSONObject().put("enabled", false));
            if (uri.equals("/api/mass-limits") && m.equals("GET")) return json(new JSONObject().put("adminMax", 100).put("userMax", 50).put("hardCap", 200));
            if (uri.equals("/api/mass-limits") && m.equals("POST")) return json(new JSONObject().put("adminMax", 100).put("userMax", 50).put("hardCap", 200));
            if (uri.equals("/api/mass-limits") && m.equals("DELETE")) return json(new JSONObject().put("adminMax", 100).put("userMax", 50).put("hardCap", 200));

            // ── Extract / URL process / Bin lookup ─────────────
            if (uri.equals("/api/extract") && m.equals("POST")) return handleExtract(s);
            if (uri.equals("/api/url-process") && m.equals("POST")) return json(new JSONObject().put("urls", new JSONArray()).put("directCards", 0));
            if (uri.equals("/api/bin-lookup") && m.equals("POST")) return json(new JSONObject());
            if (uri.equals("/api/generate") && m.equals("POST")) return handleGenerate(s);

            // ── Miner / Hitter stubs ──────────────────────────
            if (uri.equals("/api/miner/config") && m.equals("GET")) return json(new JSONObject().put("isRunning", false));
            if (uri.equals("/api/miner") && m.equals("GET")) return json(new JSONObject().put("isRunning", false).put("binList", new JSONArray()));
            if (uri.equals("/api/miner") && m.equals("PUT")) return json(new JSONObject().put("isRunning", false));
            if (uri.equals("/api/miner/start") && m.equals("POST")) return json(new JSONObject().put("ok", false).put("message", "Miner requires server-side (unavailable on mobile)"));
            if (uri.equals("/api/miner/stop") && m.equals("POST")) return json(ok());
            if (uri.equals("/api/miner/bins") && m.equals("POST")) return json(new JSONObject().put("binList", new JSONArray()));
            if (uri.equals("/api/miner/bins") && m.equals("DELETE")) return json(new JSONObject().put("binList", new JSONArray()));
            if (uri.equals("/api/miner/bins/bulk") && m.equals("POST")) return json(new JSONObject().put("binList", new JSONArray()).put("added", 0).put("duplicates", 0));
            if (uri.equals("/api/miner/bins/all") && m.equals("DELETE")) return json(new JSONObject().put("binList", new JSONArray()));
            if (uri.equals("/api/mine") && m.equals("GET")) return json(new JSONObject().put("isRunning", false));
            if (uri.equals("/api/mine") && m.equals("PUT")) return json(new JSONObject().put("isRunning", false));
            if (uri.equals("/api/mine/start") && m.equals("POST")) return json(new JSONObject().put("ok", false).put("message", "Miner requires server-side"));
            if (uri.equals("/api/mine/stop") && m.equals("POST")) return json(ok());
            if (uri.equals("/api/mine/bin") && m.equals("POST")) return json(new JSONObject().put("extraBins", new JSONArray()));
            if (uri.equals("/api/mine/bin") && m.equals("DELETE")) return json(new JSONObject().put("extraBins", new JSONArray()));
            if (uri.equals("/api/hitter/parse") && m.equals("POST")) return json(stub("Hitter requires server-side browser"));
            if (uri.equals("/api/hitter/hit") && m.equals("POST")) return json(new JSONArray());
            if (uri.equals("/api/hitter/clone") && m.equals("POST")) return json(new JSONObject().put("sessions", 0));
            if (uri.equals("/api/3ds/inspect") && m.equals("POST")) return json(stub("3DS inspection requires server-side browser"));

            // ── Fallback ──────────────────────────────────────
            Log.w(TAG, "Unmatched: " + m + " " + uri);
            return json(new JSONObject());

        } catch (Exception e) { Log.e(TAG, "API error: " + uri, e); return err(500, e.getMessage()); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  HANDLERS
    // ══════════════════════════════════════════════════════════════════
    private Response handleLogin(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            JSONObject user = db.login(b.optString("username", ""), b.optString("password", ""));
            if (user != null) { db.addLog("info", "Login: " + b.optString("username"), "auth"); return json(user); }
            return err(401, "Invalid credentials");
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleCreateGate(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String id = UUID.randomUUID().toString();
            String name = b.optString("name", "Unnamed");
            String gateType = b.optString("gateType", "");
            String subType = b.optString("subType", "standard");
            String url = b.optString("url", "");
            boolean active = b.optBoolean("active", true);
            String country = b.optString("country", "");
            JSONObject settings = b.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();
            if (!settings.has("siteUrl") && !url.isEmpty()) settings.put("siteUrl", url);
            JSONObject gate = db.createGate(id, name, gateType, subType, url, active, country, settings.toString());
            db.addLog("info", "Gate created: " + name + " (" + gateType + ")", "gate");
            return json(gate);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handlePatchGate(IHTTPSession s, String uri) {
        try {
            String id = extractId(uri);
            JSONObject b = body(s);
            JSONObject cur = db.getGate(id);
            if (cur == null) return err(404, "Gate not found");

            String name = b.has("name") ? b.getString("name") : cur.optString("name", "");
            String gateType = b.has("gateType") ? b.getString("gateType") : cur.optString("gateType", "");
            String subType = b.has("subType") ? b.getString("subType") : cur.optString("subType", "standard");
            String url = b.has("url") ? b.getString("url") : cur.optString("url", "");
            boolean active = b.has("active") ? b.getBoolean("active") : cur.optBoolean("active", true);
            String country = b.has("country") ? b.getString("country") : cur.optString("country", "");

            JSONObject curSettings = cur.optJSONObject("settings");
            JSONObject bodySettings = b.optJSONObject("settings");
            JSONObject merged = new JSONObject();
            if (curSettings != null) for (Iterator<String> it = curSettings.keys(); it.hasNext(); ) { String k = it.next(); merged.put(k, curSettings.get(k)); }
            if (bodySettings != null) for (Iterator<String> it = bodySettings.keys(); it.hasNext(); ) { String k = it.next(); merged.put(k, bodySettings.get(k)); }
            if (!url.isEmpty() && !merged.has("siteUrl")) merged.put("siteUrl", url);

            db.updateGate(id, name, gateType, subType, url, active, country, merged.toString());
            db.addLog("info", "Gate updated: " + name, "gate");
            return json(db.getGate(id));
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleDetect(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String url = b.optString("url", "");
            if (url.isEmpty()) return err(400, "URL required");
            JSONObject r = new JSONObject();
            r.put("gateType", "unknown"); r.put("subType", "standard"); r.put("confidence", 0);
            r.put("siteUrl", url); r.put("crawledPaths", new JSONArray());
            r.put("signals", new JSONArray().put("Detection requires server-side crawling (unavailable on mobile)"));
            r.put("settings", new JSONObject());
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleAutoSetup(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String url = b.optString("url", "");
            if (url.isEmpty()) return err(400, "URL required");
            String id = UUID.randomUUID().toString();
            String name = url.replace("https://", "").replace("http://", "").split("/")[0];
            JSONObject settings = new JSONObject(); settings.put("siteUrl", url); settings.put("autoDetected", false);
            JSONObject gate = db.createGate(id, name, "unknown", "standard", url, true, "", settings.toString());
            JSONObject det = new JSONObject(); det.put("gateType", "unknown"); det.put("subType", "standard"); det.put("confidence", 0);
            det.put("siteUrl", url); det.put("crawledPaths", new JSONArray());
            det.put("signals", new JSONArray().put("Created manually")); det.put("settings", settings);
            JSONObject r = new JSONObject(); r.put("gate", gate); r.put("detection", det);
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleGateImport(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            JSONArray arr = b.optJSONArray("gates");
            if (arr == null) return err(400, "gates array required");
            JSONArray created = new JSONArray(); int skipped = 0;
            for (int i = 0; i < arr.length(); i++) {
                try {
                    JSONObject g = arr.getJSONObject(i);
                    String name = g.optString("name", ""), gt = g.optString("gateType", "");
                    if (name.isEmpty() || gt.isEmpty()) { skipped++; continue; }
                    String id = UUID.randomUUID().toString();
                    JSONObject settings = g.optJSONObject("settings");
                    if (settings == null) settings = new JSONObject();
                    if (!settings.has("siteUrl")) settings.put("siteUrl", g.optString("url", ""));
                    created.put(db.createGate(id, name, gt, g.optString("subType", "standard"),
                        g.optString("url", ""), g.optBoolean("active", true), "", settings.toString()));
                } catch (Exception e) { skipped++; }
            }
            JSONObject r = new JSONObject(); r.put("imported", created.length()); r.put("skipped", skipped); r.put("gates", created);
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleRunCheck(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            JSONArray cards = b.optJSONArray("cards");
            JSONObject gateOverride = b.optJSONObject("gateOverride");
            if (cards == null || cards.length() == 0) return err(400, "cards array required");

            JSONObject gateConfig = gateOverride;
            if (gateConfig == null) {
                JSONArray gates = db.getGates();
                for (int i = 0; i < gates.length(); i++) {
                    JSONObject g = gates.getJSONObject(i);
                    if (g.optBoolean("active", false)) { gateConfig = g; break; }
                }
            }
            if (gateConfig == null) return err(400, "No active gate configured. Add a gate first.");

            String gateName = gateConfig.optString("name", "unknown");
            JSONArray results = new JSONArray();
            for (int i = 0; i < cards.length(); i++) {
                String card = cards.optString(i, "").trim();
                if (card.isEmpty()) continue;
                String id = UUID.randomUUID().toString();
                GateChecker.CheckResult cr = GateChecker.checkCard(card, gateConfig);
                db.addCheckResult(id, maskCard(card), cr.status, cr.response, gateName, cr.latency, "admin");
                JSONObject r = new JSONObject();
                r.put("id", id); r.put("card", maskCard(card)); r.put("status", cr.status);
                r.put("response", cr.response); r.put("gate", gateName); r.put("latency", cr.latency);
                r.put("checkedBy", "admin");
                r.put("createdAt", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US).format(new java.util.Date()));
                if (cr.rawSnippet != null) r.put("rawSnippet", cr.rawSnippet);
                results.put(r);
                db.addLog("info", "Check: " + maskCard(card) + " → " + cr.status, "check");
            }
            return json(results);
        } catch (Exception e) { Log.e(TAG, "Run check error", e); return err(500, e.getMessage()); }
    }

    private Response handleDownloadChecks(IHTTPSession s) {
        try {
            String query = s.getParms().get("status");
            JSONArray checks = db.getCheckResultsFiltered(query, 5000);
            StringBuilder txt = new StringBuilder();
            for (int i = 0; i < checks.length(); i++) {
                JSONObject c = checks.getJSONObject(i);
                txt.append(c.optString("card")).append("|").append(c.optString("status")).append("|").append(c.optString("response")).append("\n");
            }
            Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", txt.toString());
            r.addHeader("Content-Disposition", "attachment; filename=checks.txt");
            return r;
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleCreateProxy(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String id = UUID.randomUUID().toString();
            JSONObject proxy = db.createProxy(id, b.optString("ip", ""), b.optInt("port", 0),
                b.optString("protocol", "http"), b.optString("username", ""), b.optString("password", ""));
            return json(proxy);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleBulkProxies(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String text = b.optString("text", "");
            String[] lines = text.split("[\\r\\n]+");
            int added = 0, failed = 0;
            for (String line : lines) {
                line = line.trim();
                if (line.isEmpty()) continue;
                try {
                    String[] parts = line.split("[:@]");
                    if (parts.length >= 2) {
                        String ip = parts[0].trim();
                        int port = Integer.parseInt(parts[1].trim());
                        String user = parts.length > 2 ? parts[2].trim() : "";
                        String pass = parts.length > 3 ? parts[3].trim() : "";
                        db.createProxy(UUID.randomUUID().toString(), ip, port, "http", user, pass);
                        added++;
                    } else { failed++; }
                } catch (Exception e) { failed++; }
            }
            JSONObject r = new JSONObject(); r.put("added", added); r.put("failed", failed);
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleExportProxies() {
        try {
            JSONArray proxies = db.getProxies();
            StringBuilder txt = new StringBuilder();
            for (int i = 0; i < proxies.length(); i++) {
                JSONObject p = proxies.getJSONObject(i);
                txt.append(p.optString("ip")).append(":").append(p.optInt("port"));
                if (p.has("username") && !p.optString("username").isEmpty()) {
                    txt.append(":").append(p.optString("username")).append(":").append(p.optString("password"));
                }
                txt.append("\n");
            }
            Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", txt.toString());
            r.addHeader("Content-Disposition", "attachment; filename=live_proxies.txt");
            return r;
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleCreateKey(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String id = UUID.randomUUID().toString();
            String key = "H0-" + randHex(4) + "-" + randHex(4) + "-" + randHex(4);
            int duration = b.optInt("durationDays", 30);
            int dailyLimit = b.optInt("dailyLimit", 100);
            JSONObject k = db.createKey(id, key, duration, dailyLimit);
            db.addLog("info", "Key created: " + key, "keys");
            return json(k);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleUpdateSettings(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            db.updateBotSettings(b);
            return json(db.getBotSettings());
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleAiSuggest(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            JSONObject r = new JSONObject();
            JSONObject det = new JSONObject(); det.put("gateType", b.optString("gateType", "unknown"));
            det.put("subType", b.optString("subType", "standard")); det.put("confidence", 0.5);
            det.put("publicKey", ""); det.put("signals", new JSONArray().put("AI requires external API"));
            r.put("detection", det); r.put("analysis", "AI gate suggestion requires external LLM API. Configure settings manually.");
            r.put("suggestions", new JSONArray()); r.put("polishedSettings", b.optJSONObject("settings") != null ? b.optJSONObject("settings") : new JSONObject());
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleAdminReset(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String password = b.optString("password", "");
            if (!"926696".equals(password)) return err(401, "Invalid admin password");
            return json(db.adminReset(b.optString("target", "all")));
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleExtract(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String text = b.optString("text", "");
            String[] lines = text.split("[\\r\\n]+");
            JSONArray cards = new JSONArray();
            for (String line : lines) {
                line = line.trim();
                if (line.matches("\\d{13,19}[|/]\\d{1,2}[|/]\\d{2,4}[|/]\\d{3,4}")) {
                    cards.put(line);
                }
            }
            JSONObject r = new JSONObject(); r.put("mode", "cards"); r.put("count", cards.length()); r.put("cards", cards);
            return json(r);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    private Response handleGenerate(IHTTPSession s) {
        try {
            JSONObject b = body(s);
            String bin = b.optString("bin", "");
            int count = Math.min(b.optInt("count", 10), 100);
            if (bin.isEmpty() || bin.length() < 6) return err(400, "BIN must be at least 6 digits");
            String month = b.optString("month", "");
            String year = b.optString("year", "");
            if (month.isEmpty()) month = String.format("%02d", (int)(Math.random() * 12) + 1);
            if (year.isEmpty()) year = String.valueOf(2025 + (int)(Math.random() * 5));

            JSONArray cards = new JSONArray();
            for (int i = 0; i < count; i++) {
                StringBuilder num = new StringBuilder(bin);
                while (num.length() < 15) num.append((int)(Math.random() * 10));
                // Luhn check digit
                int sum = 0; boolean alt = false;
                for (int j = num.length() - 1; j >= 0; j--) {
                    int d = num.charAt(j) - '0';
                    if (alt) { d *= 2; if (d > 9) d -= 9; }
                    sum += d; alt = !alt;
                }
                int checkDigit = (10 - (sum % 10)) % 10;
                num.append(checkDigit);

                JSONObject card = new JSONObject();
                card.put("number", num.toString());
                card.put("expiryMonth", month);
                card.put("expiryYear", year);
                card.put("cvv", String.format("%03d", (int)(Math.random() * 999) + 1));
                card.put("type", guessCardType(num.toString()));
                cards.put(card);
            }
            return json(cards);
        } catch (Exception e) { return err(500, e.getMessage()); }
    }

    // ══════════════════════════════════════════════════════════════════
    //  GATE TYPES
    // ══════════════════════════════════════════════════════════════════
    private JSONArray gateTypes() throws JSONException {
        JSONArray t = new JSONArray();
        t.put(gt("stripe", "Stripe", new String[]{"auth","charges","charitable","givewp","givewp_v3","gravityforms","wp_full_stripe","payment_intents","tokenize","standard","3d_secure","checkout_session","wc_stripe_confirm_setup_intent","stripe_page_confirm"}));
        t.put(gt("shopify", "Shopify", new String[]{"pci","standard"}));
        t.put(gt("braintree", "Braintree", new String[]{"standard","graphql","drop_in","hosted_fields","bigcommerce_stencil"}));
        t.put(gt("payeezy", "First Data Payeezy", new String[]{"standard"}));
        t.put(gt("paypal", "PayPal", new String[]{"standard","express","advanced","givewp_commerce","paypal_commerce"}));
        t.put(gt("adyen", "Adyen", new String[]{"standard","drop_in","components"}));
        return t;
    }

    private JSONObject gt(String id, String name, String[] subs) throws JSONException {
        JSONObject o = new JSONObject(); o.put("id", id); o.put("name", name);
        JSONArray a = new JSONArray(); for (String s : subs) a.put(s); o.put("subtypes", a); return o;
    }

    // ══════════════════════════════════════════════════════════════════
    //  STATIC FILES
    // ══════════════════════════════════════════════════════════════════
    private Response serveStatic(String uri) {
        if (uri.equals("/") || uri.isEmpty()) uri = "/index.html";
        String path = uri.startsWith("/") ? uri.substring(1) : uri;
        if (path.contains("?")) path = path.split("\\?")[0];
        try { return serveAsset(assetManager.open(path), path); } catch (IOException ignored) {}
        try { return serveAsset(assetManager.open(path + ".html"), path + ".html"); } catch (IOException ignored) {}
        try { return serveAsset(assetManager.open(path + "/index.html"), path + "/index.html"); } catch (IOException ignored) {}
        try { return serveAsset(assetManager.open("index.html"), "index.html"); } catch (IOException e) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404");
        }
    }

    private Response serveAsset(InputStream is, String path) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] data = new byte[4096]; int n;
        while ((n = is.read(data)) != -1) buf.write(data, 0, n);
        is.close(); byte[] bytes = buf.toByteArray();
        String mime = mimeTypes.containsKey(path.substring(path.lastIndexOf('.') + 1)) ? mimeTypes.get(path.substring(path.lastIndexOf('.') + 1)) : "application/octet-stream";
        Response r = newFixedLengthResponse(Response.Status.OK, mime, new java.io.ByteArrayInputStream(bytes), bytes.length);
        r.addHeader("Cache-Control", path.equals("index.html") ? "no-cache" : "public, max-age=31536000");
        return r;
    }

    // ══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════════
    private JSONObject body(IHTTPSession s) throws IOException, JSONException {
        Map<String, String> m = new HashMap<>();
        try { s.parseBody(m); } catch (Exception ignored) {}
        String d = m.get("postData"); if (d == null) d = "";
        return new JSONObject(d);
    }

    private String extractId(String uri) { String[] p = uri.split("/"); return p[p.length - 1]; }

    private String maskCard(String c) {
        if (c == null || c.length() < 13) return c;
        return c.substring(0, 6) + "******" + c.substring(c.length() - 4);
    }

    private String randHex(int len) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < len; i++) sb.append("0123456789ABCDEF".charAt((int)(Math.random() * 16)));
        return sb.toString();
    }

    private String guessCardType(String num) {
        if (num.startsWith("4")) return "VISA";
        if (num.startsWith("5") || num.startsWith("2")) return "MASTERCARD";
        if (num.startsWith("3")) return "AMEX";
        if (num.startsWith("6")) return "DISCOVER";
        return "UNKNOWN";
    }

    private JSONObject ok() throws JSONException { return new JSONObject().put("success", true); }

    private JSONObject stub(String msg) throws JSONException {
        JSONObject o = new JSONObject(); o.put("error", msg); o.put("stub", true); return o;
    }

    private Response json(Object obj) {
        return newFixedLengthResponse(Response.Status.OK, "application/json", obj != null ? obj.toString() : "{}");
    }

    private Response err(int code, String msg) {
        try {
            JSONObject o = new JSONObject(); o.put("message", msg); o.put("error", msg);
            Response.Status s;
            switch (code) { case 400: s = Response.Status.BAD_REQUEST; break; case 401: s = Response.Status.UNAUTHORIZED; break; case 404: s = Response.Status.NOT_FOUND; break; default: s = Response.Status.INTERNAL_ERROR; }
            return newFixedLengthResponse(s, "application/json", o.toString());
        } catch (Exception e) { return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", msg); }
    }

    public void startServer() throws IOException {
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "Server started on port " + getListeningPort());
        db.addLog("info", "Server started on port " + getListeningPort(), "server");
    }
}
