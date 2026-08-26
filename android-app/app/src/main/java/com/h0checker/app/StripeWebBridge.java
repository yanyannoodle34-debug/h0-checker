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
 * to Stripe API from the site's origin. This gives us:
 * - Chromium TLS fingerprint (JA3/JA4) — Stripe sees real browser
 * - Correct Origin header — site's domain, which has CORS for api.stripe.com
 * - Real cookies/session from the site
 *
 * Unlike the Stripe.js approach, this works even if Stripe.js hasn't loaded
 * or the page has CAPTCHA/auth wall — we just need the origin.
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private volatile boolean pageLoaded = false;
    private String loadedSiteUrl = null;

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
     * The site's origin handles CORS for api.stripe.com.
     *
     * @param siteUrl  The gate's site URL (loaded in WebView for correct origin)
     * @param apiUrl   The Stripe API endpoint (e.g., https://api.stripe.com/v1/tokens)
     * @param headers  HTTP headers (Content-Type, Authorization, etc.)
     * @param body     URL-encoded body
     * @return         JSON response from Stripe API
     */
    public String post(String siteUrl, String apiUrl, Map<String, String> headers, String body) {
        if (activity == null || webView == null) {
            return "{\"error\":{\"message\":\"Bridge not initialized\"}}";
        }

        String cleanSite = siteUrl.replaceAll("/+$", "");

        // Step 1: Load the site if not already loaded (gives us correct origin)
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
                    Log.w(TAG, "Site load timeout, trying anyway");
                }
            } catch (InterruptedException e) {
                return "{\"error\":{\"message\":\"Interrupted\"}}";
            }

            // Brief wait for JS context to settle
            try { Thread.sleep(1500); } catch (InterruptedException ignored) {}
        }

        // Step 2: Execute fetch() from the site's origin
        StringBuilder headersJs = new StringBuilder("{");
        int i = 0;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String k = e.getKey();
            // Skip Origin/Referer — browser sets from page's real origin
            if (k.equalsIgnoreCase("Origin") || k.equalsIgnoreCase("Referer")) { i++; continue; }
            if (i > 0) headersJs.append(",");
            headersJs.append(jsStr(k)).append(":").append(jsStr(e.getValue()));
            i++;
        }
        headersJs.append("}");

        String jsBody = jsStr(body);
        String jsUrl = jsStr(apiUrl);

        String js = "(function(){" +
            "try{" +
            "  fetch(" + jsUrl + ",{" +
            "    method:'POST'," +
            "    headers:" + headersJs + "," +
            "    body:" + jsBody + "," +
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

        final CountDownLatch latch = new CountDownLatch(1);
        final String[] result = {null};

        // Store latch in bridge JS interface
        resultLatch = latch;
        resultRef = result;

        final String fjs = js;
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(fjs, v -> Log.d(TAG, "eval=" + v));
            } catch (Exception e) {
                Log.e(TAG, "eval failed: " + e.getMessage());
                result[0] = "{\"error\":{\"message\":\"eval: " + e.getMessage() + "\"}}";
                latch.countDown();
            }
        });

        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return "{\"error\":{\"message\":\"Interrupted\"}}";
        }

        if (result[0] != null) return result[0];
        return "{\"error\":{\"message\":\"No response from bridge\"}}";
    }

    // Bridge state for fetch callback
    private CountDownLatch resultLatch;
    private String[] resultRef;

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
            if (resultRef != null) resultRef[0] = body;
            if (resultLatch != null) resultLatch.countDown();
        }

        @JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "Fetch error: " + msg);
            if (resultRef != null) resultRef[0] = "{\"error\":{\"message\":\"" + msg.replace("\"", "'") + "\"}}";
            if (resultLatch != null) resultLatch.countDown();
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
