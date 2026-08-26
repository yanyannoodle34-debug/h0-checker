package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Loads the gate's site in a hidden WebView, then executes raw fetch() calls
 * to Stripe API from the site's origin.
 *
 * Requests are serialized (only one in flight at a time) to avoid race conditions
 * between the JS callback and the Java latch.
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private volatile boolean pageLoaded = false;
    private String loadedSiteUrl = null;

    // Per-request state — only one request at a time
    private CountDownLatch curLatch;
    private String[] curResult;

    @SuppressLint("SetJavaScriptEnabled")
    public static void init(Activity act) {
        if (instance != null) return;
        instance = new StripeWebBridge();
        instance.activity = act;
        act.runOnUiThread(() -> instance.createWebView(act));
    }

    public static StripeWebBridge getInstance() { return instance; }

    @SuppressLint("SetJavaScriptEnabled")
    private void createWebView(Activity act) {
        webView = new WebView(act);
        webView.setLayoutParams(new ViewGroup.LayoutParams(1, 1));
        webView.setAlpha(0f);
        webView.setVisibility(android.view.View.GONE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.addJavascriptInterface(new BridgeJS(), "SB");

        ViewGroup root = (ViewGroup) act.getWindow().getDecorView()
                .findViewById(android.R.id.content);
        root.addView(webView);

        Log.i(TAG, "WebView created");
    }

    /**
     * Execute a POST to Stripe API via fetch() from the site's WebView context.
     * Serialized — only one request at a time to avoid latch race conditions.
     */
    public synchronized String post(String siteUrl, String apiUrl,
                                     Map<String, String> headers, String body) {
        if (activity == null || webView == null) {
            return "{\"error\":{\"message\":\"Bridge not initialized\"}}";
        }

        String cleanSite = siteUrl.replaceAll("/+$", "");

        // Step 1: Load the site if not already loaded
        if (!cleanSite.equals(loadedSiteUrl)) {
            Log.i(TAG, "Loading site: " + cleanSite);
            loadedSiteUrl = cleanSite;
            pageLoaded = false;

            final CountDownLatch loadLatch = new CountDownLatch(1);
            activity.runOnUiThread(() -> {
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        Log.i(TAG, "Page loaded: " + url);
                        pageLoaded = true;
                        loadLatch.countDown();
                    }
                    @Override
                    public void onReceivedError(WebView view, int code, String desc, String url) {
                        Log.e(TAG, "Error: " + desc);
                        pageLoaded = true;
                        loadLatch.countDown();
                    }
                });
                webView.loadUrl(cleanSite);
            });

            try {
                if (!loadLatch.await(15, TimeUnit.SECONDS)) {
                    Log.w(TAG, "Site load timeout, proceeding anyway");
                }
            } catch (InterruptedException e) {
                return "{\"error\":{\"message\":\"Interrupted\"}}";
            }

            try { Thread.sleep(2000); } catch (InterruptedException ignored) {}
        }

        // Step 2: Build fetch() JS
        StringBuilder headersJs = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String k = e.getKey();
            if (k.equalsIgnoreCase("Origin") || k.equalsIgnoreCase("Referer")) continue;
            if (!first) headersJs.append(",");
            headersJs.append(jsStr(k)).append(":").append(jsStr(e.getValue()));
            first = false;
        }
        headersJs.append("}");

        String js = "(function(){" +
            "try{" +
            "  fetch(" + jsStr(apiUrl) + ",{" +
            "    method:'POST'," +
            "    headers:" + headersJs + "," +
            "    body:" + jsStr(body) + "," +
            "    mode:'cors'," +
            "    credentials:'omit'" +
            "  }).then(function(r){" +
            "    return r.text().then(function(t){" +
            "      SB.onResult(r.status,t);" +
            "    });" +
            "  })[" + "catch](function(e){" +
            "    SB.onError(e.message||String(e));" +
            "  });" +
            "}catch(e){SB.onError(e.message||String(e));}" +
            "})()";

        // Step 3: Execute and wait — serialized, no race condition
        curLatch = new CountDownLatch(1);
        curResult = new String[]{null};

        final String fjs = js;
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(fjs, v -> Log.d(TAG, "eval=" + v));
            } catch (Exception e) {
                Log.e(TAG, "eval failed: " + e.getMessage());
                curResult[0] = "{\"error\":{\"message\":\"eval: " + e.getMessage() + "\"}}";
                curLatch.countDown();
            }
        });

        try {
            curLatch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return "{\"error\":{\"message\":\"Interrupted\"}}";
        }

        String result = curResult[0];
        curLatch = null;
        curResult = null;

        if (result != null) return result;
        return "{\"error\":{\"message\":\"No response from bridge\"}}";
    }

    private static String jsStr(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'")
                      .replace("\n", "\\n").replace("\r", "\\r")
                      .replace("/", "\\/") + "'";
    }

    private class BridgeJS {
        @JavascriptInterface
        public void onResult(int status, String body) {
            Log.i(TAG, "Response: status=" + status + " len=" + (body != null ? body.length() : 0));
            if (curResult != null) curResult[0] = body;
            if (curLatch != null) curLatch.countDown();
        }

        @JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "Fetch error: " + msg);
            if (curResult != null) curResult[0] = "{\"error\":{\"message\":\"" + msg.replace("\"", "'") + "\"}}";
            if (curLatch != null) curLatch.countDown();
        }
    }

    public void destroy() {
        if (webView != null) {
            webView.post(() -> {
                webView.loadUrl("about:blank");
                webView.destroy();
            });
        }
        instance = null;
    }
}
