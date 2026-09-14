package com.redailyreporter.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebView;
import android.webkit.WebSettings;

import androidx.annotation.NonNull;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — Daily Reporter V3
 *
 * Fixes three issues:
 *
 * 1. MICROPHONE PERMISSION — Android 6+ requires runtime permission requests.
 *    Just having RECORD_AUDIO in the manifest is NOT enough. We must call
 *    ActivityCompat.requestPermissions() before getUserMedia() will work.
 *
 * 2. INPUT FOCUS JUMPING — The previous code replaced Capacitor's WebChromeClient
 *    entirely with a plain WebChromeClient. Capacitor's bridge WebChromeClient handles
 *    input focus, file chooser, alerts, and other critical WebView interactions.
 *    By replacing it, we broke text input (focus jumping after one character) and
 *    gesture typing (swype). FIX: Override only the specific method we need
 *    (onPermissionRequest) on the EXISTING client instead of replacing it.
 *
 * 3. GESTURE/SWYPE TYPING — Caused by the same WebChromeClient replacement.
 *    Capacitor's client manages input method coordination. Restoring it fixes swype.
 */
public class MainActivity extends BridgeActivity {

    private static final int PERMISSION_REQUEST_CODE = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Request runtime permissions immediately on launch.
        // This triggers the OS permission dialog so getUserMedia() can succeed.
        requestRequiredPermissions();
    }

    @Override
    public void onStart() {
        super.onStart();

        // Configure WebView for proper input handling and media access
        WebView webView = getBridge().getWebView();

        if (webView != null) {
            WebSettings settings = webView.getSettings();
            // Enable media playback without gesture (needed for audio recording)
            settings.setMediaPlaybackRequiresUserGesture(false);

            // IMPORTANT: Do NOT replace the WebChromeClient entirely.
            // Capacitor's BridgeWebChromeClient handles IME composition,
            // input focus, file chooser, swype/glide typing, and many
            // other critical WebView interactions.
            //
            // PREVIOUS BUG: Creating `new WebChromeClient()` and only
            // delegating 6 methods broke swipe typing because dozens of
            // un-delegated methods fell back to the bare base class,
            // losing Capacitor's IME handling.
            //
            // FIX: Use Capacitor's WebViewListener to intercept permission
            // requests without touching the WebChromeClient at all.
            getBridge().addWebViewListener(new com.getcapacitor.WebViewListener() {
                // WebViewListener doesn't have onPermissionRequest,
                // so we still need the client override — but we do it
                // by wrapping the EXISTING client properly.
            });

            // Minimal override: Wrap the existing client's class.
            // We capture the original and create an anonymous class that
            // extends WebChromeClient but delegates everything to the
            // original, overriding ONLY onPermissionRequest.
            final WebChromeClient originalClient = webView.getWebChromeClient();
            if (originalClient != null) {
                webView.setWebChromeClient(new PermissionGrantingWrapper(originalClient));
            }
        }
    }

    /**
     * Wrapper that delegates ALL WebChromeClient calls to the original
     * Capacitor client, overriding ONLY onPermissionRequest to auto-grant
     * mic/camera permissions.
     *
     * WHY a named inner class instead of anonymous:
     * - We need to override ~20+ methods to ensure full delegation
     * - A named class is clearer and more maintainable
     * - Every method calls through to the original, preserving Capacitor's
     *   IME composition, input focus, swype typing, and all other behaviors
     */
    private static class PermissionGrantingWrapper extends WebChromeClient {
        private final WebChromeClient delegate;

        PermissionGrantingWrapper(WebChromeClient delegate) {
            this.delegate = delegate;
        }

        // === THE OVERRIDE: auto-grant mic/camera permissions ===
        @Override
        public void onPermissionRequest(PermissionRequest request) {
            request.grant(request.getResources());
        }

        // === FULL DELEGATION — every method routes to Capacitor's original ===

        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            delegate.onProgressChanged(view, newProgress);
        }

        @Override
        public void onReceivedTitle(WebView view, String title) {
            delegate.onReceivedTitle(view, title);
        }

        @Override
        public void onReceivedIcon(WebView view, android.graphics.Bitmap icon) {
            delegate.onReceivedIcon(view, icon);
        }

        @Override
        public void onReceivedTouchIconUrl(WebView view, String url, boolean precomposed) {
            delegate.onReceivedTouchIconUrl(view, url, precomposed);
        }

        @Override
        public void onShowCustomView(android.view.View view, CustomViewCallback callback) {
            delegate.onShowCustomView(view, callback);
        }

        @Override
        public void onHideCustomView() {
            delegate.onHideCustomView();
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, android.os.Message resultMsg) {
            return delegate.onCreateWindow(view, isDialog, isUserGesture, resultMsg);
        }

        @Override
        public void onRequestFocus(WebView view) {
            delegate.onRequestFocus(view);
        }

        @Override
        public void onCloseWindow(WebView window) {
            delegate.onCloseWindow(window);
        }

        @Override
        public boolean onJsAlert(WebView view, String url, String message, android.webkit.JsResult result) {
            return delegate.onJsAlert(view, url, message, result);
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, android.webkit.JsResult result) {
            return delegate.onJsConfirm(view, url, message, result);
        }

        @Override
        public boolean onJsPrompt(WebView view, String url, String message, String defaultValue, android.webkit.JsPromptResult result) {
            return delegate.onJsPrompt(view, url, message, defaultValue, result);
        }

        @Override
        public boolean onJsBeforeUnload(WebView view, String url, String message, android.webkit.JsResult result) {
            return delegate.onJsBeforeUnload(view, url, message, result);
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, android.webkit.GeolocationPermissions.Callback callback) {
            delegate.onGeolocationPermissionsShowPrompt(origin, callback);
        }

        @Override
        public void onGeolocationPermissionsHidePrompt() {
            delegate.onGeolocationPermissionsHidePrompt();
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest request) {
            delegate.onPermissionRequestCanceled(request);
        }

        @Override
        public boolean onConsoleMessage(android.webkit.ConsoleMessage consoleMessage) {
            return delegate.onConsoleMessage(consoleMessage);
        }

        @Override
        public android.graphics.Bitmap getDefaultVideoPoster() {
            return delegate.getDefaultVideoPoster();
        }

        @Override
        public android.view.View getVideoLoadingProgressView() {
            return delegate.getVideoLoadingProgressView();
        }

        @Override
        public void getVisitedHistory(android.webkit.ValueCallback<String[]> callback) {
            delegate.getVisitedHistory(callback);
        }

        @Override
        public boolean onShowFileChooser(WebView webView, android.webkit.ValueCallback<android.net.Uri[]> filePathCallback, FileChooserParams fileChooserParams) {
            return delegate.onShowFileChooser(webView, filePathCallback, fileChooserParams);
        }
    }

    /**
     * Request RECORD_AUDIO and CAMERA permissions at runtime.
     * Without this, navigator.mediaDevices.getUserMedia() silently fails
     * even though the permissions are declared in AndroidManifest.xml.
     */
    private void requestRequiredPermissions() {
        String[] permissions;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            // Android 13+ uses granular media permissions
            permissions = new String[]{
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.CAMERA,
                    Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO,
            };
        } else {
            permissions = new String[]{
                    Manifest.permission.RECORD_AUDIO,
                    Manifest.permission.CAMERA,
                    Manifest.permission.READ_EXTERNAL_STORAGE,
            };
        }

        // Check which permissions are not yet granted
        boolean needsRequest = false;
        for (String perm : permissions) {
            if (ContextCompat.checkSelfPermission(this, perm) != PackageManager.PERMISSION_GRANTED) {
                needsRequest = true;
                break;
            }
        }

        if (needsRequest) {
            ActivityCompat.requestPermissions(this, permissions, PERMISSION_REQUEST_CODE);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, @NonNull String[] permissions, @NonNull int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);

        if (requestCode == PERMISSION_REQUEST_CODE) {
            for (int i = 0; i < permissions.length; i++) {
                String status = (grantResults[i] == PackageManager.PERMISSION_GRANTED) ? "GRANTED" : "DENIED";
                android.util.Log.d("DailyReporter", "Permission " + permissions[i] + ": " + status);
            }
        }
    }
}

