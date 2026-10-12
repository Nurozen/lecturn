package com.cloudgatherer.lecturn.symba;

import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.PowerManager;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.LinearLayout;

/** Moves the host's existing authenticated WebView; never creates a second session. */
final class FloatingChatWindow {
    private final Context context;
    private final WindowManager windows;
    private final WebView web;
    private final BookView book;
    private final android.os.Handler animation = new android.os.Handler(android.os.Looper.getMainLooper());
    private boolean working;
    private int frame;
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (!closed && attached && working && root.getVisibility() == View.VISIBLE
                    && android.animation.ValueAnimator.areAnimatorsEnabled()) {
                frame = (frame + 1) % BookView.CYCLE_FRAMES; book.frame(frame);
                animation.postDelayed(this, 167);
            } else { frame = 0; book.frame(0); }
        }
    };
    private final LinearLayout root, toolbar;
    private final Runnable onClose;
    private final java.util.function.Consumer<Boolean> onInteractive;
    private final WindowManager.LayoutParams params;
    private boolean attached, closed, minimized, wasInteractive;
    private int x = 12, y = 80;
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { visibility(); }
    };

    FloatingChatWindow(Context context, WebView web, Runnable open, Runnable back, java.util.function.Consumer<Boolean> onInteractive, Runnable onClose) {
        this.context = context; this.web = web; this.onClose = onClose; this.onInteractive = onInteractive;
        windows = context.getApplicationContext().getSystemService(WindowManager.class);
        root = new LinearLayout(context) {
            @Override protected void onAttachedToWindow() {
                super.onAttachedToWindow();
                if (Build.VERSION.SDK_INT >= 33) {
                    var dispatcher = findOnBackInvokedDispatcher();
                    if (dispatcher != null) dispatcher.registerOnBackInvokedCallback(
                            android.window.OnBackInvokedDispatcher.PRIORITY_DEFAULT, back::run);
                }
            }
            @Override public boolean dispatchKeyEvent(KeyEvent event) {
                if (event.getKeyCode() == KeyEvent.KEYCODE_BACK) {
                    if (event.getAction() == KeyEvent.ACTION_UP) back.run();
                    return true;
                }
                return super.dispatchKeyEvent(event);
            }
        };
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(4), dp(4), dp(4), dp(4));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(18, 39, 53)); background.setCornerRadius(dp(16));
        background.setStroke(dp(1), Color.rgb(200, 153, 84)); root.setBackground(background);
        toolbar = new LinearLayout(context);
        book = new BookView(context);
        book.setContentDescription("Lecturn chat. Tap to expand or minimize; drag to move.");
        toolbar.addView(book, new LinearLayout.LayoutParams(dp(48), dp(48)));
        book.setOnClickListener(v -> minimize(!minimized));
        book.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY; int startX, startY; boolean dragged;
            @Override public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX(); downY = event.getRawY(); startX = x; startY = y; dragged = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (Math.abs(dx) + Math.abs(dy) > dp(8)) dragged = true;
                        if (dragged) { x = startX + (int) dx; y = startY + (int) dy; layout(); }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!dragged) v.performClick(); return true;
                    case MotionEvent.ACTION_CANCEL: return true;
                    default: return false;
                }
            }
        });
        toolbar.addView(button("Minimize", () -> minimize(true)), new LinearLayout.LayoutParams(0, dp(48), 1));
        toolbar.addView(button("Open task", open), new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(toolbar);
        root.addView(web, new LinearLayout.LayoutParams(-1, 0, 1));
        params = new WindowManager.LayoutParams(dp(380), dp(560), WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        params.softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE;
        // The overlay must remain focusable and below the IME for composer editing.
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                int ime = insets.getInsets(WindowInsets.Type.ime()).bottom;
                root.setPadding(dp(4), dp(4), dp(4), Math.max(dp(4), ime - Math.max(0, screenHeight() - params.y - params.height)));
            }
            return insets;
        });
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON); filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(Intent.ACTION_CONFIGURATION_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(screen, filter);
    }
    boolean show() {
        layout();
        try { windows.addView(root, params); attached = true; visibility(); web.requestFocus(); return true; }
        catch (WindowManager.BadTokenException | SecurityException e) { return false; }
    }
    void working(boolean value) {
        if (working == value) return;
        working = value; animation.removeCallbacks(tick); tick.run();
    }
    boolean interactive() {
        return attached && !closed && !minimized && root.isShown() && web.isShown()
                && android.provider.Settings.canDrawOverlays(context) && context.getSystemService(PowerManager.class).isInteractive()
                && !context.getSystemService(KeyguardManager.class).isKeyguardLocked();
    }
    void minimize(boolean value) {
        minimized = value;
        if (value) context.getSystemService(InputMethodManager.class).hideSoftInputFromWindow(web.getWindowToken(), 0);
        for (int i = 1; i < toolbar.getChildCount(); i++) toolbar.getChildAt(i).setVisibility(value ? View.GONE : View.VISIBLE);
        web.setVisibility(value ? View.GONE : View.VISIBLE);
        params.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL | (value ? WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE : 0);
        layout(); visibility();
        if (!value) web.requestFocus();
    }
    private void visibility() {
        if (!attached) return;
        boolean unlocked = context.getSystemService(PowerManager.class).isInteractive()
                && !context.getSystemService(KeyguardManager.class).isKeyguardLocked();
        root.setVisibility(unlocked ? View.VISIBLE : View.GONE);
        params.flags = WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                | (!unlocked || minimized ? WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE : 0);
        animation.removeCallbacks(tick); tick.run();
        boolean active = interactive();
        if (active) web.onResume(); else web.onPause();
        if (active != wasInteractive) { wasInteractive = active; onInteractive.accept(active); }
        layout();
    }
    private int screenHeight() { return context.getResources().getDisplayMetrics().heightPixels; }
    private void layout() {
        int width = context.getResources().getDisplayMetrics().widthPixels, height = screenHeight();
        int top = dp(28), bottom = dp(28);
        if (Build.VERSION.SDK_INT >= 30) {
            var metrics = windows.getCurrentWindowMetrics(); width = metrics.getBounds().width(); height = metrics.getBounds().height();
            var bars = metrics.getWindowInsets().getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            top = bars.top; bottom = bars.bottom;
        }
        params.width = Math.min(dp(minimized ? 56 : 380), width);
        params.height = Math.min(dp(minimized ? 56 : 560), height - top - bottom);
        x = Math.max(0, Math.min(x, width - params.width)); y = Math.max(top, Math.min(y, height - bottom - params.height));
        params.x = x; params.y = y;
        if (attached) {
            try { windows.updateViewLayout(root, params); }
            catch (IllegalArgumentException | SecurityException e) { close(); }
        }
    }
    void close() {
        if (closed) return; closed = true;
        animation.removeCallbacks(tick);
        context.unregisterReceiver(screen);
        if (attached) { windows.removeView(root); attached = false; }
        root.removeView(web); onClose.run();
    }
    private Button button(String title, Runnable action) {
        Button button = new Button(context); button.setText(title); button.setTextSize(12);
        button.setPadding(0, 0, 0, 0); button.setOnClickListener(v -> action.run()); return button;
    }
    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
