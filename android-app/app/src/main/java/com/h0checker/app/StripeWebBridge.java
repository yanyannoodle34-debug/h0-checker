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
 * Loads the gate's actual site in a hidden WebView, then uses the site's own
 * Stripe.js to tokenize cards. This ensures:
 * - Same TLS fingerprint as a real browser (WebView = Chromium)
 * - Same origin as the site (CORS works for api.stripe.com)
 * - Same integration surface the site already uses with Stripe.js
 * - Cookies, session, nonce all come from the real site
 */
public class StripeWebBridge {

    private static final String TAG = "StripeBridge";
    private static StripeWebBridge instance;
    private Activity activity;
    private WebView webView;
    private volatile boolean ready = false;
    private CountDownLatch latch;
    private String lastResult = null;
    private String loadedUrl = null;

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

        Log.i(TAG, "StripeWebBridge ready (waiting for siteUrl)");
    }

    /**
     * Load the gate's site in the WebView, then execute Stripe.js tokenization.
     */
    public String stripeTokenize(String siteUrl, String pk, String number, String month,
                                  String year, String cvv) {
        // Load the site if not already loaded
        if (siteUrl == null || siteUrl.isEmpty()) {
            return "{\"error\":{\"message\":\"No siteUrl\"}}";
        }

        final String cleanSite = siteUrl.replaceAll("/+$", "");

        if (!ready || !cleanSite.equals(loadedUrl)) {
            Log.i(TAG, "Loading site: " + cleanSite);
            loadedUrl = cleanSite;
            ready = false;

            if (activity == null) {
                return "{\"error\":{\"message\":\"Activity not available\"}}";
            }

            // Load the site on the UI thread
            final CountDownLatch loadLatch = new CountDownLatch(1);
            activity.runOnUiThread(() -> {
                webView.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onPageFinished(WebView view, String url) {
                        Log.i(TAG, "Site loaded: " + url);
                        ready = true;
                        loadLatch.countDown();
                    }

                    @Override
                    public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                        Log.e(TAG, "Load error: " + description + " URL: " + failingUrl);
                        ready = true; // unblock even on error
                        loadLatch.countDown();
                    }
                });
                webView.loadUrl(cleanSite);
            });

            try {
                loadLatch.await(20, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                return "{\"error\":{\"message\":\"Site load interrupted\"}}";
            }

            if (!ready) {
                return "{\"error\":{\"message\":\"Site did not load in 20s\"}}";
            }

            // Wait a bit for Stripe.js to initialize on the page
            try { Thread.sleep(2000); } catch (InterruptedException ignored) {}
        }

        // Now inject Stripe.js tokenization on the site's own page
        latch = new CountDownLatch(1);
        lastResult = null;

        String js = "(function(){" +
            "try{" +
            "  var stripe = Stripe('" + pk + "');" +
            "  stripe.createToken('card', {" +
            "    number: '" + number + "'," +
            "    exp_month: " + month + "," +
            "    exp_year: " + year + "," +
            "    cvc: '" + cvv + "'" +
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
                webView.evaluateJavascript(fjs, value -> Log.d(TAG, "eval: " + value));
            } catch (Exception e) {
                Log.e(TAG, "eval failed: " + e.getMessage());
                lastResult = "{\"error\":{\"message\":\"eval failed: " + e.getMessage() + "\"}}";
                if (latch != null) latch.countDown();
            }
        });

        try {
            latch.await(30, TimeUnit.SECONDS);
        } catch (InterruptedException e) {
            Log.e(TAG, "Interrupted");
        }

        if (lastResult != null) return lastResult;
        return "{\"error\":{\"message\":\"No response from Stripe bridge\"}}";
    }

    private class BridgeJS {
        @JavascriptInterface
        public void onResult(String result) {
            Log.i(TAG, "Stripe result: " + (result != null ? result.substring(0, Math.min(result.length(), 200)) : "null"));
            lastResult = result;
            if (latch != null) latch.countDown();
        }

        @JavascriptInterface
        public void onError(String msg) {
            Log.e(TAG, "JS error: " + msg);
            lastResult = "{\"error\":{\"message\":\"" + msg.replace("\"", "'") + "\"}}";
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
}
