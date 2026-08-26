package com.h0checker.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;

import java.io.IOException;

public class MainActivity extends Activity {

    private static final String TAG = "H0Checker";
    private static final int SERVER_PORT = 8080;
    private static final String SERVER_URL = "http://127.0.0.1:" + SERVER_PORT;

    private WebView webView;
    private ProgressBar progressBar;
    private EmbeddedServer server;
    private static final int FILE_CHOOSER_REQUEST = 100;
    private ValueCallback<Uri[]> fileUploadCallback;
    private boolean serverReady = false;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestWindowFeature(Window.FEATURE_NO_TITLE);
        getWindow().setFlags(
            WindowManager.LayoutParams.FLAG_FULLSCREEN,
            WindowManager.LayoutParams.FLAG_FULLSCREEN
        );

        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webView);
        progressBar = findViewById(R.id.progressBar);

        DatabaseHelper.getInstance(this);

        startServer();

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setMediaPlaybackRequiresUserGesture(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            getWindow().setStatusBarColor(0xFF0A0A0F);
            getWindow().setNavigationBarColor(0xFF0A0A0F);
        }

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) {
                    return false;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
                startActivity(intent);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                Log.e(TAG, "WebView error: " + description + " URL: " + failingUrl);
                Toast.makeText(MainActivity.this, "Error: " + description, Toast.LENGTH_SHORT).show();
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                progressBar.setVisibility(View.GONE);
                injectAuth(view);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (newProgress < 100) {
                    progressBar.setVisibility(View.VISIBLE);
                    progressBar.setProgress(newProgress);
                } else {
                    progressBar.setVisibility(View.GONE);
                }
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                Log.d(TAG, "WebView: " + msg.message());
                return true;
            }

            @Override
            public boolean onShowFileChooser(WebView webView, ValueCallback<Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
                if (fileUploadCallback != null) {
                    fileUploadCallback.onReceiveValue(null);
                }
                fileUploadCallback = filePathCallback;
                Intent intent = fileChooserParams.createIntent();
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                } catch (Exception e) {
                    fileUploadCallback = null;
                    return false;
                }
                return true;
            }
        });

        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Initialize hidden WebView for Stripe API calls (Chromium TLS fingerprint)
        StripeWebBridge.init(this);

        // Load the app
        webView.loadUrl(SERVER_URL);
    }

    private void injectAuth(WebView view) {
        view.evaluateJavascript(
            "(function() {" +
            "  try {" +
            "    var u = localStorage.getItem('h0_user');" +
            "    if (!u) {" +
            "      localStorage.setItem('h0_user', JSON.stringify({id:'admin-001',username:'admin',role:'admin'}));" +
            "      console.log('[H0] Auth injected');" +
            "    }" +
            "  } catch(e) { console.log('[H0] Auth inject error:', e); }" +
            "})()", null
        );
    }

    private void startServer() {
        new Thread(() -> {
            try {
                server = new EmbeddedServer(this, SERVER_PORT);
                server.startServer();
                serverReady = true;
                Log.i(TAG, "Server running on " + SERVER_URL);
                runOnUiThread(() -> {
                    // Pre-inject auth BEFORE loading page
                    webView.evaluateJavascript(
                        "(function() {" +
                        "  try {" +
                        "    var u = localStorage.getItem('h0_user');" +
                        "    if (!u) {" +
                        "      localStorage.setItem('h0_user', JSON.stringify({id:'admin-001',username:'admin',role:'admin'}));" +
                        "    }" +
                        "  } catch(e) {}" +
                        "})()", null
                    );
                });
            } catch (IOException e) {
                Log.e(TAG, "Server failed", e);
                runOnUiThread(() ->
                    Toast.makeText(this, "Server failed: " + e.getMessage(), Toast.LENGTH_LONG).show()
                );
            }
        }).start();

        try { Thread.sleep(1000); } catch (InterruptedException ignored) {}
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && fileUploadCallback != null) {
            Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                String dataString = data.getDataString();
                if (dataString != null) results = new Uri[]{Uri.parse(dataString)};
            }
            fileUploadCallback.onReceiveValue(results);
            fileUploadCallback = null;
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        webView.onPause();
    }

    @Override
    protected void onDestroy() {
        StripeWebBridge bridge = StripeWebBridge.getInstance();
        if (bridge != null) bridge.destroy();
        if (server != null) server.stop();
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
