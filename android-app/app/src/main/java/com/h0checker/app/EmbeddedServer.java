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
        mimeTypes.put("html", "text/html");
        mimeTypes.put("css", "text/css");
        mimeTypes.put("js", "application/javascript");
        mimeTypes.put("json", "application/json");
        mimeTypes.put("png", "image/png");
        mimeTypes.put("jpg", "image/jpeg");
        mimeTypes.put("jpeg", "image/jpeg");
        mimeTypes.put("gif", "image/gif");
        mimeTypes.put("svg", "image/svg+xml");
        mimeTypes.put("ico", "image/x-icon");
        mimeTypes.put("woff", "font/woff");
        mimeTypes.put("woff2", "font/woff2");
        mimeTypes.put("ttf", "font/ttf");
        mimeTypes.put("map", "application/json");
        mimeTypes.put("txt", "text/plain");
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();
        String method = session.getMethod().name();

        if (method.equals("OPTIONS")) {
            Response r = newFixedLengthResponse(Response.Status.OK, "text/plain", "");
            addCorsHeaders(r);
            return r;
        }

        if (uri.startsWith("/api/")) {
            Response r = handleApi(session, uri, method);
            addCorsHeaders(r);
            return r;
        }

        Response r = serveStatic(uri);
        addCorsHeaders(r);
        return r;
    }

    private void addCorsHeaders(Response r) {
        r.addHeader("Access-Control-Allow-Origin", "*");
        r.addHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
        r.addHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    }

    // ══════════════════════════════════════════════════════════════════
    //  API ROUTER
    // ══════════════════════════════════════════════════════════════════
    private Response handleApi(IHTTPSession session, String uri, String method) {
        try {
            // ── Auth ──────────────────────────────────────────────
            if (uri.equals("/api/auth/login") && method.equals("POST"))
                return handleLogin(session);
            if (uri.equals("/api/auth/me") && method.equals("GET"))
                return jsonResponse(db.login("admin", "926696"));

            // ── Gate CRUD ────────────────────────────────────────
            if (uri.equals("/api/gates") && method.equals("GET"))
                return jsonResponse(db.getGates());
            if (uri.equals("/api/gates") && method.equals("POST"))
                return handleCreateGate(session);

            // PATCH /api/gates/:id  (frontend uses PATCH)
            if (uri.matches("/api/gates/[a-f0-9-]+") && method.equals("PATCH"))
                return handlePatchGate(session, uri);
            // PUT /api/gates/:id  (also accept PUT for compat)
            if (uri.matches("/api/gates/[a-f0-9-]+") && method.equals("PUT"))
                return handlePatchGate(session, uri);
            // DELETE /api/gates/:id
            if (uri.matches("/api/gates/[a-f0-9-]+") && method.equals("DELETE")) {
                String id = extractId(uri);
                db.deleteGate(id);
                db.addLog("info", "Gate deleted: " + id, "gate");
                return jsonResponse(new JSONObject().put("success", true));
            }

            // ── Gate Types ────────────────────────────────────────
            if (uri.equals("/api/gates/types") && method.equals("GET"))
                return handleGateTypes();

            // ── Gate Health ───────────────────────────────────────
            if (uri.matches("/api/gates/[a-f0-9-]+/health") && method.equals("GET"))
                return handleGateHealth(session, uri);

            // ── Gate Failure Suggestions ──────────────────────────
            if (uri.matches("/api/gates/[a-f0-9-]+/failure-suggestions") && method.equals("GET"))
                return handleFailureSuggestions(session, uri);

            // ── Gate Detect / Scrape / Auto-setup ─────────────────
            if (uri.equals("/api/gates/detect-url") && method.equals("POST"))
                return handleDetectUrl(session);
            if (uri.equals("/api/gates/auto-setup") && method.equals("POST"))
                return handleAutoSetup(session);
            if (uri.equals("/api/gates/scrape-hints") && method.equals("POST"))
                return handleScrapeHints(session);

            // ── Gate Import ───────────────────────────────────────
            if (uri.equals("/api/gates/import") && method.equals("POST"))
                return handleGateImport(session);

            // ── Gate Bulk Setup (stub — SSE not feasible on mobile) ─
            if (uri.equals("/api/gates/bulk-setup") && method.equals("POST"))
                return jsonResponse(new JSONObject()
                    .put("error", "Bulk setup requires server-side crawling (unavailable on mobile)")
                    .put("status", "unsupported"));

            // ── Check Results ─────────────────────────────────────
            if (uri.equals("/api/check-results") && method.equals("GET"))
                return jsonResponse(db.getCheckResults());
            if (uri.equals("/api/checks") && method.equals("POST"))
                return handleRunCheck(session);

            // ── Proxies ───────────────────────────────────────────
            if (uri.equals("/api/proxies") && method.equals("GET"))
                return jsonResponse(db.getProxies());

            // ── Keys ──────────────────────────────────────────────
            if (uri.equals("/api/keys") && method.equals("GET"))
                return jsonResponse(db.getKeys());

            // ── Bot Settings ──────────────────────────────────────
            if (uri.equals("/api/bot-settings") && method.equals("GET"))
                return jsonResponse(db.getBotSettings());
            if (uri.equals("/api/bot-settings") && method.equals("PUT"))
                return handleUpdateBotSettings(session);

            // ── Settings (alias for bot-settings) ─────────────────
            if (uri.equals("/api/settings") && method.equals("GET"))
                return jsonResponse(db.getBotSettings());
            if (uri.equals("/api/settings") && method.equals("PUT"))
                return handleUpdateBotSettings(session);

            // ── Bot Start / Stop ──────────────────────────────────
            if (uri.equals("/api/bot/start") && method.equals("POST")) {
                db.updateBotSettings(new JSONObject().put("botRunning", true));
                db.addLog("info", "Bot started", "bot");
                return jsonResponse(new JSONObject()
                    .put("success", true)
                    .put("message", "Bot started (stub)"));
            }
            if (uri.equals("/api/bot/stop") && method.equals("POST")) {
                db.updateBotSettings(new JSONObject().put("botRunning", false));
                db.addLog("info", "Bot stopped", "bot");
                return jsonResponse(new JSONObject()
                    .put("success", true)
                    .put("message", "Bot stopped"));
            }

            // ── Sessions (plural — what frontend uses) ────────────
            if (uri.equals("/api/sessions") && method.equals("GET"))
                return jsonResponse(new JSONObject().put("sessions", new JSONArray()).put("cooldowns", new JSONArray()));
            if (uri.equals("/api/sessions") && method.equals("DELETE"))
                return jsonResponse(new JSONObject().put("cleared", 0));
            if (uri.matches("/api/sessions/[a-zA-Z0-9.-]+") && method.equals("DELETE"))
                return jsonResponse(new JSONObject().put("ok", true));

            // ── Session (singular — legacy) ───────────────────────
            if (uri.equals("/api/session") && method.equals("GET"))
                return jsonResponse(new JSONObject().put("sessions", new JSONArray()).put("cooldowns", new JSONArray()));
            if (uri.equals("/api/session/clear") && method.equals("POST"))
                return jsonResponse(new JSONObject().put("success", true));

            // ── System ────────────────────────────────────────────
            if (uri.equals("/api/system/stats") && method.equals("GET"))
                return jsonResponse(db.getStats());
            if (uri.equals("/api/system/logs") && method.equals("GET"))
                return jsonResponse(db.getLogs());

            // ── Miner / Proxy Config (stubs) ──────────────────────
            if (uri.equals("/api/miner/config") && method.equals("GET"))
                return jsonResponse(new JSONObject().put("isRunning", false));
            if (uri.equals("/api/proxy-config") && method.equals("GET"))
                return jsonResponse(new JSONObject().put("enabled", true));

            // ── AI stubs ──────────────────────────────────────────
            if (uri.equals("/api/ai/gate-suggest") && method.equals("POST"))
                return handleAiGateSuggest(session);
            if (uri.equals("/api/ai/configure-gates") && method.equals("POST"))
                return jsonResponse(new JSONObject().put("error", "AI requires external API (unavailable on mobile)"));
            if (uri.equals("/api/ai/collect-and-configure") && method.equals("POST"))
                return jsonResponse(new JSONObject().put("error", "AI requires external API (unavailable on mobile)"));

            // ── Fallback ──────────────────────────────────────────
            Log.w(TAG, "Unmatched API: " + method + " " + uri);
            return jsonResponse(new JSONObject());

        } catch (Exception e) {
            Log.e(TAG, "API error: " + uri, e);
            return jsonError(500, e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  HANDLERS
    // ══════════════════════════════════════════════════════════════════

    private Response handleLogin(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String username = body.optString("username", "admin");
            String password = body.optString("password", "");
            JSONObject user = db.login(username, password);
            if (user != null) {
                db.addLog("info", "Login successful: " + username, "auth");
                return jsonResponse(user);
            }
            return jsonError(401, "Invalid credentials");
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleCreateGate(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String id = UUID.randomUUID().toString();
            String name = body.optString("name", "Unnamed");
            String gateType = body.optString("gateType", "");
            String subType = body.optString("subType", "standard");
            String url = body.optString("url", "");
            boolean active = body.optBoolean("active", true);
            String country = body.optString("country", "");
            JSONObject settings = body.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();
            if (!settings.has("siteUrl")) settings.put("siteUrl", url);

            JSONObject gate = db.createGate(id, name, gateType, subType, url, active, country, settings.toString());
            db.addLog("info", "Gate created: " + name + " (" + gateType + ")", "gate");
            return jsonResponse(gate);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handlePatchGate(IHTTPSession session, String uri) {
        try {
            String id = extractId(uri);
            JSONObject body = readBody(session);
            JSONObject current = db.getGate(id);
            if (current == null) return jsonError(404, "Gate not found");

            String name = body.has("name") ? body.getString("name") : current.optString("name", "");
            String gateType = body.has("gateType") ? body.getString("gateType") : current.optString("gateType", "");
            String subType = body.has("subType") ? body.getString("subType") : current.optString("subType", "standard");
            String url = body.has("url") ? body.getString("url") : current.optString("url", "");
            boolean active = body.has("active") ? body.getBoolean("active") : current.optBoolean("active", true);
            String country = body.has("country") ? body.getString("country") : current.optString("country", "");

            JSONObject currentSettings = current.optJSONObject("settings");
            JSONObject bodySettings = body.optJSONObject("settings");
            JSONObject mergedSettings = new JSONObject();
            if (currentSettings != null) {
                for (Iterator<String> it = currentSettings.keys(); it.hasNext(); ) {
                    String k = it.next();
                    mergedSettings.put(k, currentSettings.get(k));
                }
            }
            if (bodySettings != null) {
                for (Iterator<String> it = bodySettings.keys(); it.hasNext(); ) {
                    String k = it.next();
                    mergedSettings.put(k, bodySettings.get(k));
                }
            }
            if (url != null && !url.isEmpty() && !mergedSettings.has("siteUrl")) {
                mergedSettings.put("siteUrl", url);
            }

            db.updateGate(id, name, gateType, subType, url, active, country, mergedSettings.toString());
            db.addLog("info", "Gate updated: " + name, "gate");
            return jsonResponse(db.getGate(id));
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleGateTypes() {
        try {
            JSONArray types = new JSONArray();

            JSONObject stripe = new JSONObject();
            stripe.put("id", "stripe");
            stripe.put("name", "Stripe");
            stripe.put("subtypes", new JSONArray()
                .put("auth").put("charges").put("charitable").put("givewp").put("givewp_v3")
                .put("gravityforms").put("wp_full_stripe").put("payment_intents")
                .put("tokenize").put("standard").put("3d_secure").put("checkout_session")
                .put("wc_stripe_confirm_setup_intent").put("stripe_page_confirm"));
            types.put(stripe);

            JSONObject shopify = new JSONObject();
            shopify.put("id", "shopify");
            shopify.put("name", "Shopify");
            shopify.put("subtypes", new JSONArray().put("pci").put("standard"));
            types.put(shopify);

            JSONObject braintree = new JSONObject();
            braintree.put("id", "braintree");
            braintree.put("name", "Braintree");
            braintree.put("subtypes", new JSONArray()
                .put("standard").put("graphql").put("drop_in").put("hosted_fields").put("bigcommerce_stencil"));
            types.put(braintree);

            JSONObject payeezy = new JSONObject();
            payeezy.put("id", "payeezy");
            payeezy.put("name", "First Data Payeezy");
            payeezy.put("subtypes", new JSONArray().put("standard"));
            types.put(payeezy);

            JSONObject paypal = new JSONObject();
            paypal.put("id", "paypal");
            paypal.put("name", "PayPal");
            paypal.put("subtypes", new JSONArray()
                .put("standard").put("express").put("advanced")
                .put("givewp_commerce").put("paypal_commerce"));
            types.put(paypal);

            JSONObject adyen = new JSONObject();
            adyen.put("id", "adyen");
            adyen.put("name", "Adyen");
            adyen.put("subtypes", new JSONArray().put("standard").put("drop_in").put("components"));
            types.put(adyen);

            return jsonResponse(types);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleGateHealth(IHTTPSession session, String uri) {
        try {
            String id = extractId(uri);
            JSONObject health = db.getGateHealth(id);
            return jsonResponse(health);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleFailureSuggestions(IHTTPSession session, String uri) {
        try {
            String id = extractId(uri);
            JSONObject result = db.getFailureSuggestions(id);
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleDetectUrl(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String url = body.optString("url", "");
            if (url.isEmpty()) return jsonError(400, "URL required");

            db.addLog("info", "Auto-detect requested (stub): " + url, "gate-detector");
            JSONObject result = new JSONObject();
            result.put("gateType", "unknown");
            result.put("subType", "standard");
            result.put("confidence", 0);
            result.put("siteUrl", url);
            result.put("crawledPaths", new JSONArray());
            result.put("signals", new JSONArray().put("Detection requires server-side crawling (unavailable on mobile)"));
            result.put("settings", new JSONObject());
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleAutoSetup(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String url = body.optString("url", "");
            if (url.isEmpty()) return jsonError(400, "URL required");

            String id = UUID.randomUUID().toString();
            String name = url.replace("https://", "").replace("http://", "").split("/")[0];
            JSONObject settings = new JSONObject();
            settings.put("siteUrl", url);
            settings.put("autoDetected", false);

            JSONObject gate = db.createGate(id, name, "unknown", "standard", url, true, "", settings.toString());
            db.addLog("info", "Auto-setup gate created: " + name, "gate");

            JSONObject result = new JSONObject();
            result.put("gate", gate);
            JSONObject detection = new JSONObject();
            detection.put("gateType", "unknown");
            detection.put("subType", "standard");
            detection.put("confidence", 0);
            detection.put("siteUrl", url);
            detection.put("crawledPaths", new JSONArray());
            detection.put("signals", new JSONArray().put("Created manually — detection requires server-side crawling"));
            detection.put("settings", settings);
            result.put("detection", detection);
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleScrapeHints(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String url = body.optString("url", "");
            if (url.isEmpty()) return jsonError(400, "url required");

            JSONObject result = new JSONObject();
            result.put("ok", false);
            result.put("status", 0);
            result.put("error", "Scraping requires server-side HTTP client (unavailable on mobile)");
            result.put("hints", new JSONObject());
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleGateImport(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            JSONArray gatesArray = body.optJSONArray("gates");
            if (gatesArray == null) return jsonError(400, "gates array required");

            JSONArray created = new JSONArray();
            int skipped = 0;
            for (int i = 0; i < gatesArray.length(); i++) {
                try {
                    JSONObject g = gatesArray.getJSONObject(i);
                    String name = g.optString("name", "");
                    String gateType = g.optString("gateType", "");
                    String subType = g.optString("subType", "standard");
                    String url = g.optString("url", "");
                    if (name.isEmpty() || gateType.isEmpty()) { skipped++; continue; }

                    String gateId = UUID.randomUUID().toString();
                    boolean active = g.optBoolean("active", true);
                    JSONObject settings = g.optJSONObject("settings");
                    if (settings == null) settings = new JSONObject();
                    if (!settings.has("siteUrl")) settings.put("siteUrl", url);

                    JSONObject gate = db.createGate(gateId, name, gateType, subType, url, active, "", settings.toString());
                    created.put(gate);
                } catch (Exception e) {
                    skipped++;
                }
            }

            db.addLog("info", "Bulk import: " + created.length() + " created, " + skipped + " skipped", "gate");
            JSONObject result = new JSONObject();
            result.put("imported", created.length());
            result.put("skipped", skipped);
            result.put("gates", created);
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleRunCheck(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            JSONArray cards = body.optJSONArray("cards");
            JSONObject gateOverride = body.optJSONObject("gateOverride");

            if (cards == null || cards.length() == 0) return jsonError(400, "cards array required");

            String gateName = "test";
            if (gateOverride != null) gateName = gateOverride.optString("name", "test");

            JSONArray results = new JSONArray();
            for (int i = 0; i < cards.length(); i++) {
                String card = cards.optString(i, "");
                String id = UUID.randomUUID().toString();
                db.addCheckResult(id, maskCard(card), "error",
                    "Test check — mobile app cannot reach external gate URLs. Configure gates on a server for live checks.",
                    gateName, 0, "admin");
                JSONObject r = new JSONObject();
                r.put("id", id);
                r.put("card", maskCard(card));
                r.put("status", "error");
                r.put("response", "Test check — mobile app cannot reach external gate URLs");
                r.put("gate", gateName);
                r.put("latency", 0);
                r.put("checkedBy", "admin");
                r.put("createdAt", new java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss").format(new java.util.Date()));
                results.put(r);
            }
            return jsonResponse(results);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleAiGateSuggest(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            String gateType = body.optString("gateType", "unknown");
            String subType = body.optString("subType", "standard");
            String url = body.optString("url", "");
            JSONObject settings = body.optJSONObject("settings");
            if (settings == null) settings = new JSONObject();

            JSONObject result = new JSONObject();
            JSONObject detection = new JSONObject();
            detection.put("gateType", gateType);
            detection.put("subType", subType);
            detection.put("confidence", 0.5);
            detection.put("publicKey", settings.optString("publicKey", ""));
            detection.put("signals", new JSONArray().put("AI analysis requires external API (unavailable on mobile)"));
            result.put("detection", detection);
            result.put("analysis", "AI gate suggestion requires an external LLM API. Configure the gate settings manually.");
            result.put("suggestions", new JSONArray());
            result.put("polishedSettings", settings);
            return jsonResponse(result);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleUpdateBotSettings(IHTTPSession session) {
        try {
            JSONObject body = readBody(session);
            db.updateBotSettings(body);
            return jsonResponse(db.getBotSettings());
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  STATIC FILE SERVER
    // ══════════════════════════════════════════════════════════════════
    private Response serveStatic(String uri) {
        if (uri.equals("/") || uri.isEmpty()) uri = "/index.html";

        String assetPath = uri.startsWith("/") ? uri.substring(1) : uri;
        if (assetPath.contains("?")) assetPath = assetPath.split("\\?")[0];

        try {
            InputStream is = assetManager.open(assetPath);
            return serveAsset(is, assetPath);
        } catch (IOException ignored) {}

        try {
            InputStream is = assetManager.open(assetPath + ".html");
            return serveAsset(is, assetPath + ".html");
        } catch (IOException ignored) {}

        try {
            InputStream is = assetManager.open(assetPath + "/index.html");
            return serveAsset(is, assetPath + "/index.html");
        } catch (IOException ignored) {}

        try {
            InputStream is = assetManager.open("index.html");
            return serveAsset(is, "index.html");
        } catch (IOException e) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND, "text/plain", "404 Not Found");
        }
    }

    private Response serveAsset(InputStream is, String assetPath) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] data = new byte[4096];
        int bytesRead;
        while ((bytesRead = is.read(data, 0, data.length)) != -1) {
            buffer.write(data, 0, bytesRead);
        }
        is.close();
        byte[] bytes = buffer.toByteArray();

        String mimeType = getMimeType(assetPath);
        Response response = newFixedLengthResponse(Response.Status.OK, mimeType,
            new java.io.ByteArrayInputStream(bytes), bytes.length);

        if (!assetPath.equals("index.html")) {
            response.addHeader("Cache-Control", "public, max-age=31536000");
        } else {
            response.addHeader("Cache-Control", "no-cache");
        }
        return response;
    }

    // ══════════════════════════════════════════════════════════════════
    //  HELPERS
    // ══════════════════════════════════════════════════════════════════
    private JSONObject readBody(IHTTPSession session) throws IOException, JSONException {
        Map<String, String> bodyMap = new HashMap<>();
        try { session.parseBody(bodyMap); } catch (Exception ignored) {}
        String bodyStr = bodyMap.get("postData");
        if (bodyStr == null) bodyStr = "";
        return new JSONObject(bodyStr);
    }

    private String extractId(String uri) {
        String[] parts = uri.split("/");
        return parts[parts.length - 1];
    }

    private String maskCard(String card) {
        if (card == null || card.length() < 13) return card;
        return card.substring(0, 6) + "******" + card.substring(card.length() - 4);
    }

    private Response jsonResponse(Object obj) {
        String json = obj != null ? obj.toString() : "{}";
        return newFixedLengthResponse(Response.Status.OK, "application/json", json);
    }

    private Response jsonError(int code, String message) {
        try {
            JSONObject err = new JSONObject();
            err.put("message", message);
            err.put("error", message);
            Response.Status status;
            switch (code) {
                case 400: status = Response.Status.BAD_REQUEST; break;
                case 401: status = Response.Status.UNAUTHORIZED; break;
                case 404: status = Response.Status.NOT_FOUND; break;
                default: status = Response.Status.INTERNAL_ERROR; break;
            }
            return newFixedLengthResponse(status, "application/json", err.toString());
        } catch (Exception e) {
            return newFixedLengthResponse(Response.Status.INTERNAL_ERROR, "text/plain", message);
        }
    }

    private String getMimeType(String path) {
        int dot = path.lastIndexOf('.');
        if (dot >= 0) {
            String ext = path.substring(dot + 1).toLowerCase();
            String mime = mimeTypes.get(ext);
            if (mime != null) return mime;
        }
        return "application/octet-stream";
    }

    public void startServer() throws IOException {
        start(NanoHTTPD.SOCKET_READ_TIMEOUT, false);
        Log.i(TAG, "Embedded server started on port " + getListeningPort());
        db.addLog("info", "Embedded server started on port " + getListeningPort(), "server");
    }
}
