package com.cloudgatherer.lecturn.symba;

import android.app.Activity;
import android.app.AlertDialog;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.TextView;

final class DeviceAccessDialog {
    private AlertDialog dialog;
    private HostController.Completion pending;
    private boolean applying;
    private long generation;
    private void finish(HostState state) {
        HostController.Completion callback = pending;
        pending = null;
        if (callback != null) callback.complete(state);
    }
    void show(Activity activity, HostController host, String threadId) {
        show(activity, host, threadId, state -> {});
    }
    void show(Activity activity, HostController host, String threadId, HostController.Completion completion) {
        if (pending != null || dialog != null) { completion.complete(null); return; }
        long reviewGeneration = ++generation;
        pending = completion;
        applying = false;
        if (!host.verified() || host.busy) { finish(null); host.refresh(); return; }
        HostState reviewed = host.state;
        LinearLayout panel = new LinearLayout(activity);
        panel.setOrientation(LinearLayout.VERTICAL);
        int padding = Math.round(24 * activity.getResources().getDisplayMetrics().density);
        panel.setPadding(padding, padding / 2, padding, padding / 2);
        TextView explanation = new TextView(activity);
        explanation.setText(R.string.access_risks);
        panel.addView(explanation);
        if (threadId != null) {
            TextView thread = new TextView(activity);
            thread.setText(activity.getString(R.string.access_thread, threadId));
            panel.addView(thread);
        }
        TextView configured = new TextView(activity);
        configured.setText(activity.getString(R.string.configured_access,
                activity.getString(reviewed.fullAccess ? R.string.grant_on : R.string.grant_off),
                activity.getString(reviewed.computerUse ? R.string.grant_on : R.string.grant_off)));
        panel.addView(configured);
        TextView current = new TextView(activity);
        current.setText(activity.getString(R.string.effective_access,
                activity.getString(reviewed.effectiveFullAccess() ? R.string.full_access : R.string.limited_access),
                activity.getString(reviewed.effectiveComputerUse() ? R.string.grant_on : R.string.grant_off)));
        panel.addView(current);
        CheckBox full = new CheckBox(activity);
        full.setText(reviewed.appDataCapable ? R.string.full_checkbox : R.string.full_unavailable);
        full.setChecked(reviewed.appDataCapable && (threadId != null || reviewed.effectiveFullAccess())); full.setEnabled(reviewed.appDataCapable);
        full.setMinHeight(Math.round(48 * activity.getResources().getDisplayMetrics().density));
        panel.addView(full);
        CheckBox computer = new CheckBox(activity);
        computer.setText(reviewed.computerUseCapable ? R.string.computer_checkbox : R.string.computer_unavailable);
        computer.setChecked(reviewed.effectiveComputerUse()); computer.setEnabled(reviewed.computerUseCapable);
        computer.setMinHeight(Math.round(48 * activity.getResources().getDisplayMetrics().density));
        panel.addView(computer);
        computer.setEnabled(reviewed.computerUseCapable && full.isChecked());
        full.setOnCheckedChangeListener((button, checked) -> {
            if (!checked) computer.setChecked(false);
            computer.setEnabled(checked && reviewed.computerUseCapable);
        });
        android.widget.ScrollView scroll = new android.widget.ScrollView(activity); scroll.addView(panel);
        dialog = new AlertDialog.Builder(activity).setTitle("Allow device access?").setView(scroll)
                .setNegativeButton("Cancel", null)
                .setNeutralButton("Revoke all", (d, w) -> {
                    applying = true;
                    host.policy(reviewed.revision, false, false, state -> { if (generation == reviewGeneration) finish(state); });
                })
                .setPositiveButton("Apply device access", (d, w) -> {
                    applying = true;
                    host.policy(reviewed.revision, full.isChecked(), computer.isChecked(), state -> { if (generation == reviewGeneration) finish(state); });
                })
                .create();
        dialog.setOnDismissListener(d -> { dialog = null; if (!applying) finish(null); });
        dialog.show();
        if (android.os.Build.VERSION.SDK_INT >= 31) dialog.getWindow().setHideOverlayWindows(true);
    }
    void close() { generation++; finish(null); if (dialog != null) dialog.dismiss(); }
}
