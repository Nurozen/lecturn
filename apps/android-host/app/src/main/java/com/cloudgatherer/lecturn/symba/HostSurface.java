package com.cloudgatherer.lecturn.symba;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/** Native controls stay small so the full Lecturn workspace owns the screen. */
final class HostSurface extends LinearLayout {
    private static final int NAVY = 0xff122735, GOLD = 0xfff2c775, INK = 0xfff6efdf, MUTED = 0xffb9c9cf;
    final FrameLayout content;
    final TextView status, pairingStatus;
    private final ScrollView waiting;
    private final TextView title, detail;
    private final Button start, stop, device, more;
    private boolean lastVerifiedReady;

    HostSurface(Context context) {
        super(context);
        setOrientation(VERTICAL);
        setBackgroundColor(NAVY);
        LinearLayout header = new LinearLayout(context);
        header.setGravity(Gravity.CENTER_VERTICAL);
        header.setPadding(dp(12), dp(4), dp(8), dp(4));
        header.setMinimumHeight(dp(56));
        ImageView mark = new ImageView(context);
        mark.setImageResource(R.drawable.lecturn_mark);
        mark.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        header.addView(mark, new LayoutParams(dp(32), dp(32)));
        LinearLayout identity = new LinearLayout(context);
        identity.setOrientation(VERTICAL);
        identity.setPadding(dp(10), 0, dp(4), 0);
        TextView name = label(R.string.app_name, 17, INK);
        name.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        identity.addView(name);
        status = label(R.string.host_checking, 11, MUTED);
        identity.addView(status);
        header.addView(identity, new LayoutParams(0, -2, 1));
        device = button(R.string.host_device_access, false);
        device.setTextSize(12);
        header.addView(device, new LayoutParams(dp(100), -2));
        more = button(R.string.host_more, false);
        more.setTextSize(12);
        header.addView(more, new LayoutParams(dp(56), -2));
        addView(header);
        View divider = new View(context);
        divider.setBackgroundColor(0xff314955);
        addView(divider, new LayoutParams(-1, dp(1)));
        pairingStatus = label(R.string.host_pairing, 12, GOLD);
        pairingStatus.setPadding(dp(16), dp(8), dp(16), dp(8));
        pairingStatus.setVisibility(GONE);
        addView(pairingStatus);
        content = new FrameLayout(context);
        addView(content, new LayoutParams(-1, 0, 1));
        waiting = new ScrollView(context);
        waiting.setBackgroundColor(NAVY);
        waiting.setFillViewport(true);
        LinearLayout panel = new LinearLayout(context);
        panel.setOrientation(VERTICAL);
        panel.setGravity(Gravity.CENTER);
        panel.setPadding(dp(28), dp(24), dp(28), dp(24));
        ImageView book = new ImageView(context);
        book.setImageResource(R.drawable.lecturn_mark);
        book.setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
        panel.addView(book, new LayoutParams(dp(72), dp(72)));
        TextView eyebrow = label(R.string.host_on_phone_label, 11, GOLD);
        eyebrow.setLetterSpacing(0.12f);
        eyebrow.setPadding(0, dp(24), 0, dp(10));
        panel.addView(eyebrow);
        title = label(R.string.host_checking_title, 24, INK);
        title.setGravity(Gravity.CENTER);
        panel.addView(title);
        detail = label(R.string.host_checking_detail, 15, MUTED);
        detail.setGravity(Gravity.CENTER);
        detail.setPadding(0, dp(12), 0, dp(24));
        panel.addView(detail, new LayoutParams(-1, -2));
        start = button(R.string.host_start, true);
        panel.addView(start, new LayoutParams(-1, -2));
        stop = button(R.string.host_stop, false);
        LayoutParams stopSize = new LayoutParams(-1, -2);
        stopSize.topMargin = dp(8);
        panel.addView(stop, stopSize);
        waiting.addView(panel);
        content.addView(waiting, new FrameLayout.LayoutParams(-1, -1));
    }

    void actions(OnClickListener onStart, OnClickListener onStop, OnClickListener onDevice, OnClickListener onMore) {
        start.setOnClickListener(onStart); stop.setOnClickListener(onStop);
        device.setOnClickListener(onDevice); more.setOnClickListener(onMore);
    }

    void render(HostController host, boolean hasWorkspace, boolean bridgeAvailable, UiPairing pairing) {
        boolean verified = host.verified();
        HostState state = host.state;
        boolean ready = verified && "ready".equals(state.runtime);
        boolean starting = verified && "starting".equals(state.runtime);
        boolean stopped = verified && "stopped".equals(state.runtime);
        // Preserve a ready document through lost contact, but not through a confirmed exit or Stop.
        if (host.stopping) lastVerifiedReady = false;
        else if (verified) lastVerifiedReady = ready;
        boolean showWorkspace = hasWorkspace && bridgeAvailable && !host.stopping && lastVerifiedReady;
        status.setText(host.stopping ? R.string.host_stopping : !verified ? (host.busy ? R.string.host_checking : R.string.host_unavailable)
                : starting ? R.string.host_starting : ready ? (host.monitoring ? R.string.host_on_phone : R.string.host_background_off)
                : "stopped".equals(state.runtime) ? R.string.host_stopped : R.string.host_attention);
        device.setEnabled(!host.busy);
        pairingStatus.setVisibility(host.stopFailure != null || (showWorkspace && (pairing.error != null || pairing.waiting)) ? VISIBLE : GONE);
        pairingStatus.setText(host.stopFailure != null ? host.stopFailure
                : pairing.error != null ? pairing.error : getResources().getString(R.string.host_pairing));
        for (int i = 0; i < content.getChildCount(); i++) {
            View child = content.getChildAt(i);
            if (child != waiting) child.setVisibility(showWorkspace ? VISIBLE : INVISIBLE);
        }
        waiting.setVisibility(showWorkspace ? GONE : VISIBLE);
        if (showWorkspace) return;
        waiting.bringToFront();
        if (!bridgeAvailable) {
            title.setText(R.string.host_update_webview);
            detail.setText(R.string.webview_update_required);
        } else if (host.stopping) {
            title.setText(R.string.host_stopping_title);
            detail.setText(R.string.host_stopping_detail);
        } else if (!verified) {
            title.setText(host.busy ? R.string.host_checking_title : R.string.host_unavailable_title);
            detail.setText(host.busy ? R.string.host_checking_detail
                    : R.string.host_unavailable_detail);
        } else if (starting) {
            title.setText(R.string.host_starting_title);
            detail.setText(host.monitoring ? R.string.host_starting_detail
                    : R.string.host_keep_running_detail);
        } else if (ready) {
            title.setText(R.string.host_ready_title);
            detail.setText(R.string.host_ready_detail);
        } else if ("error".equals(state.runtime)) {
            title.setText(R.string.host_error_title);
            detail.setText(R.string.host_error_detail);
        } else {
            title.setText(R.string.host_welcome_title);
            detail.setText(R.string.host_welcome_detail);
        }
        start.setText((ready || starting) && !host.monitoring ? R.string.host_keep_running : starting ? R.string.host_starting : R.string.host_start);
        start.setEnabled(!host.busy && !host.stopping && (!(ready || starting) || !host.monitoring));
        start.setVisibility((ready || starting) && host.monitoring ? GONE : VISIBLE);
        stop.setVisibility(!stopped && (host.monitoring || starting || ready || host.stopping) ? VISIBLE : GONE);
        stop.setEnabled(!host.stopping || !host.busy);
    }

    private TextView label(int text, int size, int color) {
        TextView view = new TextView(getContext());
        view.setText(text); view.setTextSize(size); view.setTextColor(color);
        return view;
    }
    private Button button(int text, boolean primary) {
        Button view = new Button(getContext());
        view.setText(text); view.setTextSize(15); view.setAllCaps(false);
        view.setMinHeight(dp(48)); view.setMinimumHeight(dp(48)); view.setMinWidth(0); view.setMinimumWidth(0);
        view.setPadding(dp(8), dp(10), dp(8), dp(10));
        view.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled}, new int[]{}},
                new int[]{primary ? 0xff435767 : MUTED, primary ? NAVY : GOLD}));
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(primary ? GOLD : Color.TRANSPARENT); shape.setCornerRadius(dp(12));
        view.setBackground(new RippleDrawable(ColorStateList.valueOf(0x334f7185), shape, null));
        return view;
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
