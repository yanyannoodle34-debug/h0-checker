package com.h0checker.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

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
    private final Map<String, String> mimeTypes = new HashMap<>();

    public EmbeddedServer(Context context, int port) {
        super(port);
        this.context = context;
        this.assetManager = context.getAssets();
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
        mimeTypes.put("eot", "application/vnd.ms-fontobject");
        mimeTypes.put("map", "application/json");
        mimeTypes.put("webp", "image/webp");
        mimeTypes.put("mp4", "video/mp4");
        mimeTypes.put("webm", "video/webm");
        mimeTypes.put("txt", "text/plain");
        mimeTypes.put("xml", "application/xml");
        mimeTypes.put("pdf", "application/pdf");
    }

    @Override
    public Response serve(IHTTPSession session) {
        String uri = session.getUri();

        // API routes — not handled here (need Node.js backend)
        if (uri.startsWith("/api/")) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                "text/plain", "API server not running. Start the Node.js backend.");
        }

        // Serve static files from assets
        if (uri.equals("/") || uri.equals("")) {
            uri = "/index.html";
        }

        // Remove leading slash
        String assetPath = uri.startsWith("/") ? uri.substring(1) : uri;

        // Try exact path first
        try {
            InputStream is = assetManager.open(assetPath);
            return serveAsset(is, assetPath);
        } catch (IOException e) {
            // Fall through
        }

        // Try .html extension
        try {
            InputStream is = assetManager.open(assetPath + ".html");
            return serveAsset(is, assetPath + ".html");
        } catch (IOException e) {
            // Fall through
        }

        // Try index.html in directory (SPA fallback)
        try {
            InputStream is = assetManager.open(assetPath + "/index.html");
            return serveAsset(is, assetPath + "/index.html");
        } catch (IOException e) {
            // Fall through
        }

        // SPA fallback — serve index.html for client-side routing
        try {
            InputStream is = assetManager.open("index.html");
            return serveAsset(is, "index.html");
        } catch (IOException e) {
            return newFixedLengthResponse(Response.Status.NOT_FOUND,
                "text/plain", "404 Not Found");
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

        // Cache static assets
        if (!assetPath.equals("index.html")) {
            response.addHeader("Cache-Control", "public, max-age=31536000");
        } else {
            response.addHeader("Cache-Control", "no-cache");
        }

        return response;
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
        Log.i(TAG, "Server started on port " + getListeningPort());
    }
}
