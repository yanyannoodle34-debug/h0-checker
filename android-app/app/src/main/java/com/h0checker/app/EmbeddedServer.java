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
import java.util.Map;

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

        // ── API Routes ────────────────────────────────────────────────
        if (uri.startsWith("/api/")) {
            return handleApi(session, uri, method);
        }

        // ── Static Files ──────────────────────────────────────────────
        return serveStatic(uri);
    }

    // ══════════════════════════════════════════════════════════════════
    //  API HANDLER
    // ══════════════════════════════════════════════════════════════════
    private Response handleApi(IHTTPSession session, String uri, String method) {
        try {
            // POST /api/auth/login
            if (uri.equals("/api/auth/login") && method.equals("POST")) {
                return handleLogin(session);
            }

            // GET /api/auth/me
            if (uri.equals("/api/auth/me") && method.equals("GET")) {
                return jsonResponse(db.login("admin", "926696"));
            }

            // GET /api/gates
            if (uri.equals("/api/gates") && method.equals("GET")) {
                return jsonResponse(db.getGates());
            }

            // POST /api/gates
            if (uri.equals("/api/gates") && method.equals("POST")) {
                return handleCreateGate(session);
            }

            // PUT /api/gates/:id
            if (uri.matches("/api/gates/[a-f0-9-]+") && method.equals("PUT")) {
                return handleUpdateGate(session, uri);
            }

            // DELETE /api/gates/:id
            if (uri.matches("/api/gates/[a-f0-9-]+") && method.equals("DELETE")) {
                String id = uri.split("/")[3];
                db.deleteGate(id);
                return jsonResponse(new JSONObject().put("success", true));
            }

            // GET /api/check-results
            if (uri.equals("/api/check-results") && method.equals("GET")) {
                return jsonResponse(db.getCheckResults());
            }

            // GET /api/proxies
            if (uri.equals("/api/proxies") && method.equals("GET")) {
                return jsonResponse(db.getProxies());
            }

            // GET /api/keys
            if (uri.equals("/api/keys") && method.equals("GET")) {
                return jsonResponse(db.getKeys());
            }

            // GET /api/bot-settings
            if (uri.equals("/api/bot-settings") && method.equals("GET")) {
                return jsonResponse(db.getBotSettings());
            }

            // PUT /api/bot-settings
            if (uri.equals("/api/bot-settings") && method.equals("PUT")) {
                return handleUpdateBotSettings(session);
            }

            // GET /api/system/stats
            if (uri.equals("/api/system/stats") && method.equals("GET")) {
                return jsonResponse(db.getStats());
            }

            // GET /api/system/logs
            if (uri.equals("/api/system/logs") && method.equals("GET")) {
                return jsonResponse(db.getLogs());
            }

            // GET /api/settings
            if (uri.equals("/api/settings") && method.equals("GET")) {
                return jsonResponse(db.getBotSettings());
            }

            // PUT /api/settings
            if (uri.equals("/api/settings") && method.equals("PUT")) {
                return handleUpdateBotSettings(session);
            }

            // GET /api/miner/config
            if (uri.equals("/api/miner/config") && method.equals("GET")) {
                return jsonResponse(new JSONObject().put("isRunning", false));
            }

            // GET /api/proxy-config
            if (uri.equals("/api/proxy-config") && method.equals("GET")) {
                return jsonResponse(new JSONObject().put("enabled", true));
            }

            // GET /api/session
            if (uri.equals("/api/session") && method.equals("GET")) {
                JSONObject sessionData = new JSONObject();
                sessionData.put("sessions", new JSONArray());
                sessionData.put("cooldowns", new JSONArray());
                return jsonResponse(sessionData);
            }

            // Bot start/stop stubs
            if (uri.equals("/api/bot/start") && method.equals("POST")) {
                db.updateBotSettings(new JSONObject().put("botRunning", true));
                return jsonResponse(new JSONObject().put("success", true));
            }
            if (uri.equals("/api/bot/stop") && method.equals("POST")) {
                db.updateBotSettings(new JSONObject().put("botRunning", false));
                return jsonResponse(new JSONObject().put("success", true));
            }

            // Clear session
            if (uri.equals("/api/session/clear") && method.equals("POST")) {
                return jsonResponse(new JSONObject().put("success", true));
            }

            // Fallback for unknown API routes
            return jsonResponse(new JSONObject());
        } catch (Exception e) {
            Log.e(TAG, "API error: " + uri, e);
            return jsonError(500, e.getMessage());
        }
    }

    // ══════════════════════════════════════════════════════════════════
    //  API HANDLERS
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
            String id = java.util.UUID.randomUUID().toString();
            JSONObject gate = db.createGate(
                id,
                body.optString("name", "Unnamed"),
                body.optString("gateType", ""),
                body.optString("subType", "standard"),
                body.optString("url", ""),
                body.optBoolean("active", true),
                body.optString("country", ""),
                body.optJSONObject("settings") != null ? body.optJSONObject("settings").toString() : "{}"
            );
            db.addLog("info", "Gate created: " + body.optString("name"), "gate");
            return jsonResponse(gate);
        } catch (Exception e) {
            return jsonError(500, e.getMessage());
        }
    }

    private Response handleUpdateGate(IHTTPSession session, String uri) {
        try {
            String id = uri.split("/")[3];
            JSONObject body = readBody(session);
            db.updateGate(
                id,
                body.optString("name", ""),
                body.optString("gateType", ""),
                body.optString("subType", ""),
                body.optString("url", ""),
                body.optBoolean("active", true),
                body.optString("country", ""),
                body.optJSONObject("settings") != null ? body.optJSONObject("settings").toString() : "{}"
            );
            return jsonResponse(db.getGate(id));
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
        if (uri.equals("/") || uri.equals("")) {
            uri = "/index.html";
        }

        String assetPath = uri.startsWith("/") ? uri.substring(1) : uri;

        // Remove query string
        if (assetPath.contains("?")) {
            assetPath = assetPath.split("\\?")[0];
        }

        // Try exact path
        try {
            InputStream is = assetManager.open(assetPath);
            return serveAsset(is, assetPath);
        } catch (IOException ignored) {}

        // Try .html extension
        try {
            InputStream is = assetManager.open(assetPath + ".html");
            return serveAsset(is, assetPath + ".html");
        } catch (IOException ignored) {}

        // Try index.html in directory
        try {
            InputStream is = assetManager.open(assetPath + "/index.html");
            return serveAsset(is, assetPath + "/index.html");
        } catch (IOException ignored) {}

        // SPA fallback
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
        try {
            session.parseBody(bodyMap);
        } catch (Exception ignored) {}

        String bodyStr = bodyMap.get("postData");
        if (bodyStr == null) bodyStr = "";
        return new JSONObject(bodyStr);
    }

    private Response jsonResponse(Object obj) {
        String json = obj != null ? obj.toString() : "{}";
        return newFixedLengthResponse(Response.Status.OK, "application/json", json);
    }

    private Response jsonError(int code, String message) {
        try {
            JSONObject err = new JSONObject();
            err.put("error", message);
            Response.Status status = Response.Status.INTERNAL_ERROR;
            if (code == 401) status = Response.Status.UNAUTHORIZED;
            else if (code == 404) status = Response.Status.NOT_FOUND;
            else if (code == 400) status = Response.Status.BAD_REQUEST;
            else if (code == 500) status = Response.Status.INTERNAL_ERROR;
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
