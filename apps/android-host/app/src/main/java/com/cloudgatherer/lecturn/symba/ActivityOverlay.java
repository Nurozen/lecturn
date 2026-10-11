package com.cloudgatherer.lecturn.symba;

import android.animation.ValueAnimator;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

final class ActivityOverlay {
    private final Context context;
    private final HostController host;
    private final Runnable stop;
    private final WindowManager windows;
    private final Handler main = new Handler(Looper.getMainLooper());
    private LinearLayout root;
    private BookView book;
    private TextView title, detail;
    private WindowManager.LayoutParams params;
    private boolean expanded, visible, closed;
    private int frame;
    private int x = 16, y = 120;
    private final BroadcastReceiver screen = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) { update(); }
    };
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (closed) return;
            update();
            boolean animate = shouldAnimate();
            if (animate) { frame = (frame + 1) % BookView.CYCLE_FRAMES; book.frame(frame); }
            main.postDelayed(this, animate ? 167 : 1000);
        }
    };

    ActivityOverlay(Context context, HostController host, Runnable stop) {
        this.context = context; this.host = host; this.stop = stop;
        windows = context.getSystemService(WindowManager.class);
        IntentFilter filter = new IntentFilter(Intent.ACTION_SCREEN_OFF);
        filter.addAction(Intent.ACTION_SCREEN_ON);
        filter.addAction(Intent.ACTION_USER_PRESENT);
        filter.addAction(Intent.ACTION_CONFIGURATION_CHANGED);
        if (Build.VERSION.SDK_INT >= 33) context.registerReceiver(screen, filter, Context.RECEIVER_NOT_EXPORTED);
        else context.registerReceiver(screen, filter);
        main.post(tick);
    }

    void update() {
        if (closed) return;
        boolean active = host.state != null && (host.state.working() || !"idle".equals(host.state.activity)) && !"stopped".equals(host.state.runtime);
        boolean shouldShow = !((HostApplication) context.getApplicationContext()).floatingChat && host.monitoring && Settings.canDrawOverlays(context)
                && context.getSystemService(PowerManager.class).isInteractive()
                && !context.getSystemService(KeyguardManager.class).isKeyguardLocked()
                && (active || (visible && !host.verified()));
        if (!shouldShow) { hide(); return; }
        if (root == null) create();
        String label = !host.verified() ? "Status stale · runtime unverified" : host.state.title.isEmpty() ? "Lecturn · " + host.state.activity : host.state.title;
        String description = !host.verified() ? "Open Lecturn to reconnect. Stop remains available."
                : host.state.activity + " · " + host.state.progress() + "\n" + host.state.detail;
        if (host.verified() && host.state.working())
            description += "\nWorking tasks: " + host.state.workingCount;
        if (host.verified() && !"ready".equals(host.state.runtime)) {
            label = "Runtime " + host.state.runtime;
            description = host.state.message;
        }
        if (!label.contentEquals(title.getText())) title.setText(label);
        if (!description.contentEquals(detail.getText())) detail.setText(description);
        book.setContentDescription(label + ". Tap to expand; drag to move.");
        if (!visible) {
            try { clamp(); windows.addView(root, params); visible = true; }
            catch (WindowManager.BadTokenException | SecurityException e) { hide(); }
        } else clampAndMove();
        if (!shouldAnimate()) resetFrame();
    }

    private boolean shouldAnimate() {
        return visible && host.verified() && host.state.working() && ValueAnimator.areAnimatorsEnabled();
    }
    private void resetFrame() {
        frame = 0;
        if (book != null) book.frame(0);
    }

    private void create() {
        root = new LinearLayout(context);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setLayoutDirection(View.LAYOUT_DIRECTION_LTR);
        root.setPadding(dp(6), dp(6), dp(6), dp(6));
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.rgb(18, 39, 53)); background.setCornerRadius(dp(20));
        background.setStroke(dp(1), Color.rgb(200, 153, 84));
        root.setBackground(background);
        book = new BookView(context);
        root.addView(book, new LinearLayout.LayoutParams(dp(56), dp(56)));
        book.setOnClickListener(v -> expand(!expanded));
        book.setOnTouchListener(new View.OnTouchListener() {
            float downX, downY; int startX, startY; boolean dragged;
            @Override public boolean onTouch(View v, MotionEvent event) {
                switch (event.getActionMasked()) {
                    case MotionEvent.ACTION_DOWN:
                        downX = event.getRawX(); downY = event.getRawY(); startX = x; startY = y; dragged = false; return true;
                    case MotionEvent.ACTION_MOVE:
                        float dx = event.getRawX() - downX, dy = event.getRawY() - downY;
                        if (Math.abs(dx) + Math.abs(dy) > dp(8)) dragged = true;
                        if (dragged) { x = startX + (int) dx; y = startY + (int) dy; clampAndMove(); }
                        return true;
                    case MotionEvent.ACTION_UP:
                        if (!dragged) v.performClick();
                        return true;
                    case MotionEvent.ACTION_CANCEL: return true;
                    default: return false;
                }
            }
        });
        title = text(16); title.setMaxLines(2); root.addView(title);
        detail = text(13); detail.setMaxLines(4); root.addView(detail);
        LinearLayout actions = new LinearLayout(context);
        actions.addView(button("Open", v -> {
            context.startActivity(new Intent(context, MainActivity.class).setAction(Intent.ACTION_MAIN)
                    .putExtra("widget_thread_url", ChatWidget.selectedUrl())
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP));
        }));
        actions.addView(button("Stop", v -> stop.run()));
        actions.addView(button("Chat", v -> context.startActivity(new Intent(context, MainActivity.class)
                .setAction(MainActivity.FLOAT_CHAT).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP))));
        root.addView(actions);
        root.addView(button("Minimize", v -> expand(false)));
        params = new WindowManager.LayoutParams(dp(68), WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT);
        params.gravity = Gravity.TOP | Gravity.START;
        expand(false);
    }
    private TextView text(int size) {
        TextView view = new TextView(context); view.setTextColor(Color.rgb(229, 209, 172));
        view.setTextSize(size); view.setPadding(dp(8), dp(4), dp(8), dp(4)); return view;
    }
    private Button button(String label, View.OnClickListener action) {
        Button button = new Button(context); button.setText(label); button.setContentDescription(label + " Lecturn");
        button.setMinHeight(dp(48)); button.setOnClickListener(action); return button;
    }
    private void expand(boolean value) {
        expanded = value;
        for (int i = 1; i < root.getChildCount(); i++) root.getChildAt(i).setVisibility(value ? View.VISIBLE : View.GONE);
        params.width = dp(value ? 280 : 68);
        root.post(() -> {
            if (!visible) return;
            clamp();
            try { windows.updateViewLayout(root, params); }
            catch (IllegalArgumentException | SecurityException e) { hide(); }
        });
    }
    private void clamp() {
        Rect bounds;
        int left = 0, top = 0, right = 0, bottom = 0;
        if (Build.VERSION.SDK_INT >= 30) {
            var metrics = windows.getCurrentWindowMetrics(); bounds = metrics.getBounds();
            var insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            left = insets.left; top = insets.top; right = insets.right; bottom = insets.bottom;
        } else {
            var metrics = context.getResources().getDisplayMetrics(); bounds = new Rect(0, 0, metrics.widthPixels, metrics.heightPixels);
        }
        params.width = Math.min(dp(expanded ? 280 : 68), bounds.width() - left - right);
        root.measure(View.MeasureSpec.makeMeasureSpec(params.width, View.MeasureSpec.EXACTLY),
                View.MeasureSpec.makeMeasureSpec(bounds.height() - top - bottom, View.MeasureSpec.AT_MOST));
        x = Math.max(left, Math.min(x, bounds.width() - right - params.width));
        y = Math.max(top, Math.min(y, bounds.height() - bottom - root.getMeasuredHeight()));
        params.x = x; params.y = y;
    }
    private void clampAndMove() {
        if (!visible || root == null) return;
        int oldX = params.x, oldY = params.y, oldWidth = params.width, oldHeight = root.getMeasuredHeight();
        clamp();
        if (oldX == params.x && oldY == params.y && oldWidth == params.width && oldHeight == root.getMeasuredHeight()) return;
        try { windows.updateViewLayout(root, params); }
        catch (IllegalArgumentException | SecurityException e) { hide(); }
    }
    private void hide() {
        resetFrame();
        if (visible && root != null) windows.removeView(root);
        visible = false;
    }
    void close() { closed = true; main.removeCallbacks(tick); context.unregisterReceiver(screen); hide(); }
    private int dp(int value) { return Math.round(value * context.getResources().getDisplayMetrics().density); }
}
