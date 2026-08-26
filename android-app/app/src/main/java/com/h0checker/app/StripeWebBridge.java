package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.util.Base64;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import org.json.JSONObject;

import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Hidden WebView that executes fetch() calls to Stripe API.
 * Uses Chromium's TLS fingerprint (JA3/JA4) so Stripe sees it as a real browser.
 * 
 * This is the key difference: Android HttpURLConnection uses Java/Conscrypt TLS
 * which has a different JA3 fingerprint. Stripe detects this and blocks with
 * "integration surface" error. WebView uses Chromium TLS = same fingerprint as Chrome.
 */
public class StripeWebBridge {

    private static final String TAG = "StripeWebBridge";
    private static StripeWebBridge instance;
    private WebView webView;
    private volatile boolean ready = false;
    private volatile String lastResult = null;
    private volatile int lastStatus = 0;
    private CountDownLatch latch;

    @SuppressLint("SetJavaScriptEnabled")
    public static void init(Activity activity) {
        if (instance != null) return;
        instance = new StripeWebBridge();
        instance.setup(activity);
    }

    public static StripeWebBridge getInstance() {
        return instance;
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setup(Activity activity) {
        activity.runOnUiThread(() -> {
            webView = new WebView(activity);
            webView.setLayoutParams(new ViewGroup.LayoutParams(1, 1));
            webView.setAlpha(0f);
            webView.setVisibility(View.GONE);

            WebSettings s = webView.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

            webView.addJavascriptInterface(new BridgeInterface(), "AndroidBridge");
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    ready = true;
                    Log.i(TAG, "WebView ready at: " + url);
                }
            });

            // Add to root view (invisible)
            ViewGroup root = (ViewGroup) activity.getWindow().getDecorView().findViewById(android.R.id.content);
            root.addView(webView);

            // Load a minimal page so fetch() works from same-origin context
            webView.loadDataWithBaseURL(
                "https://js.stripe.com",
                "<!DOCTYPE html><html><head><title>stripe-bridge</title></head><body></body></html>",
                "text/html", "UTF-8", null
            );
            Log.i(TAG, "StripeWebBridge initialized");
        });
    }

    /**
     * Execute a POST request to Stripe API via WebView's Chromium fetch().
     * Blocks until the response arrives (up to 30 seconds).
     */
    public String fetchStripePost(String url, Map<String, String> headers, String body) {
        if (!ready) {
            Log.w(TAG, "WebView not ready, waiting...");
            long deadline = System.currentTimeMillis() + 10000;
            while (!ready && System.currentTimeMillis() < deadline) {
                try { Thread.sleep(100); } catch (InterruptedException ignored) {}
            }
            if (!ready) {
                Log.e(TAG, "WebView still not ready after 10s");
                return "{\"error\":{\"message\":\"WebView not ready\"}}";
            }
        }

        latch = new CountDownLatch(1);
        lastResult = null;
        lastStatus = 0;

        // Build JavaScript fetch call
        StringBuilder jsHeaders = new StringBuilder("{");
        int i = 0;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (i > 0) jsHeaders.append(",");
            jsHeaders.append("'").append(escapeJs(e.getKey())).append("':'").append(escapeJs(e.getValue())).append("'");
            i++;
        }
        jsHeaders.append("}");

        // Escape body for JavaScript string literal
        String escapedBody = escapeJs(body);

        String js = String.format(
            "(function() {" +
            "  try {" +
            "    fetch('%s', {" +
            "      method: 'POST'," +
            "      headers: %s," +
            "      body: '%s'," +
            "      mode: 'cors'," +
            "      credentials: 'omit'" +
            "    }).then(function(r) {" +
            "      return r.text().then(function(t) {" +
            "        AndroidBridge.onResponse(r.status, t);" +
            "      });" +
            "    }).catch(function(e) {" +
            "      AndroidBridge.onError(e.message || String(e));" +
            "    });" +
            "  } catch(e) {" +
            "    AndroidBridge.onError(e.message || String(e));" +
            "  }" +
            "})()",
            escapeJs(url),
            jsHeaders.toString(),
            escapedBody
        );

        activity().runOnUiThread(() -> webView.evaluateJavascript(js, null));

        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted waiting for response");
        }

        if (lastResult != null) return lastResult;
        return "{\"error\":{\"message\":\"No response from WebView\"}}";
    }

    private Activity activity() {
        // Get the current activity from the main thread
        return (Activity) webView.getContext();
    }

    private String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("'", "\\'")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\u2028", "\\u2028")
                .replace("\u2029", "\\u2029");
    }

    private class BridgeInterface {
        @JavascriptInterface
        public void onResponse(int status, String body) {
            lastStatus = status;
            lastResult = body;
            if (latch != null) latch.countDown();
            Log.d(TAG, "Response received: status=" + status + " len=" + (body != null ? body.length() : 0));
        }

        @JavascriptInterface
        public void onError(String message) {
            lastResult = "{\"error\":{\"message\":\"" + message.replace("\"", "'") + "\"}}";
            if (latch != null) latch.countDown();
            Log.e(TAG, "JS Error: " + message);
        }
    }

    public void destroy() {
        if (webView != null) {
            webView.post(() -> {
                webView.loadDataWithBaseURL(null, "", "text/html", "UTF-8", null);
                webView.destroy();
            });
        }
        instance = null;
    }
}
