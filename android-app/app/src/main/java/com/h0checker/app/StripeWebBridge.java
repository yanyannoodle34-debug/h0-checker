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
 * Hidden WebView that executes fetch() to Stripe API using Chromium's TLS fingerprint.
 *
 * KEY INSIGHT: Android HttpURLConnection uses Java/Conscrypt TLS (JA3 ≠ Chrome).
 * Stripe rejects it with "integration surface". WebView IS Chromium, so TLS matches.
 *
 * We load the REAL https://js.stripe.com page so:
 *  - Origin is actually "https://js.stripe.com" (forbidden headers can't be spoofed)
 *  - TLS fingerprint is Chrome's
 *  - CORS is properly set up for api.stripe.com
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private volatile boolean ready = false;
    private CountDownLatch latch;
    private String lastResult = null;

    @SuppressLint("SetJavaScriptEnabled")
    public static void init(Activity act) {
        if (instance != null) return;
        instance = new StripeWebBridge();
        instance.activity = act;
        act.runOnUiThread(() -> instance.setup(act));
    }

    public static StripeWebBridge getInstance() { return instance; }

    @SuppressLint("SetJavaScriptEnabled")
    private void setup(Activity act) {
        webView = new WebView(act);
        webView.setLayoutParams(new ViewGroup.LayoutParams(1, 1));
        webView.setAlpha(0f);
        webView.setVisibility(android.view.View.GONE);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        webView.addJavascriptInterface(new BridgeJS(), "StripeBridge");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                Log.i(TAG, "Page loaded: " + url);
                ready = true;
            }
        });

        ViewGroup root = (ViewGroup) act.getWindow().getDecorView()
                .findViewById(android.R.id.content);
        root.addView(webView);

        // Load the REAL js.stripe.com so origin = "https://js.stripe.com"
        webView.loadUrl("https://js.stripe.com");
        Log.i(TAG, "Loading js.stripe.com for Chromium TLS + correct origin");
    }

    /**
     * POST to Stripe API via WebView's Chromium fetch().
     * The page origin is real "https://js.stripe.com" so CORS works.
     * TLS fingerprint is Chrome's, so Stripe accepts the request.
     */
    public String fetchStripePost(String url, Map<String, String> headers, String body) {
        // Wait for page to load
        if (!ready) {
            Log.w(TAG, "Waiting for js.stripe.com to load...");
            long deadline = System.currentTimeMillis() + 15000;
            while (!ready && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(200); } catch (InterruptedException ignored) {}
            }
            if (!ready) {
                Log.e(TAG, "js.stripe.com did not load in 15s");
                return "{\"error\":{\"message\":\"WebView not ready\"}}";
            }
        }

        latch = new CountDownLatch(1);
        lastResult = null;

        // Build headers JSON — skip Origin/Referer (forbidden, browser sets them automatically)
        StringBuilder hJson = new StringBuilder("{");
        int i = 0;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String key = e.getKey();
            // Skip forbidden headers — browser sets these from the page's real origin
            if (key.equalsIgnoreCase("Origin") || key.equalsIgnoreCase("Referer")) continue;
            if (i > 0) hJson.append(",");
            hJson.append(JSON(key)).append(":").append(JSON(e.getValue()));
            i++;
        }
        hJson.append("}");

        String jsBody = escapeJS(body);

        // Execute fetch() from real js.stripe.com origin
        String js = "(function(){\n" +
            "try{\n" +
            "  fetch(" + JSON(url) + ",{\n" +
            "    method:'POST',\n" +
            "    headers:" + hJson + ",\n" +
            "    body:" + JSON(jsBody) + ",\n" +
            "    mode:'cors',\n" +
            "    credentials:'omit'\n" +
            "  }).then(function(r){\n" +
            "    return r.text().then(function(t){\n" +
            "      StripeBridge.onResult(r.status,t);\n" +
            "    });\n" +
            "  })[" + "catch](function(e){\n" +
            "    StripeBridge.onError(e.message||String(e));\n" +
            "  });\n" +
            "}catch(e){StripeBridge.onError(e.message||String(e));}\n" +
            "})()";

        final String fjs = js;
        if (activity != null) {
            activity.runOnUiThread(() -> {
                try {
                    webView.evaluateJavascript(fjs, value -> {
                        Log.d(TAG, "eval result: " + value);
                    });
                } catch (Exception e) {
                    Log.e(TAG, "eval failed: " + e.getMessage());
                    lastResult = "{\"error\":{\"message\":\"eval failed: " + e.getMessage() + "\"}}";
                    if (latch != null) latch.countDown();
                }
            });
        }

        try {
            boolean done = latch.await(30, TimeUnit.SECONDS);
            if (!done) Log.w(TAG, "Timeout waiting for Stripe response");
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted");
        }

        if (lastResult != null) return lastResult;
        return "{\"error\":{\"message\":\"No response from Stripe bridge\"}}";
    }

    private class BridgeJS {
        @JavascriptInterface
        public void onResult(int status, String body) {
            Log.i(TAG, "Stripe response: status=" + status + " len=" + (body != null ? body.length() : 0));
            lastResult = body;
            if (latch != null) latch.countDown();
        }

        @JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "JS error: " + msg);
            lastResult = "{\"error\":{\"message\":\"" + escapeJSON(msg) + "\"}}";
            if (latch != null) latch.countDown();
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

    // JSON string helper
    private static String JSON(String s) {
        return "'" + escapeJS(s) + "'";
    }

    private static String escapeJS(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("/", "\\/");
    }

    private static String escapeJSON(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r");
    }
}
