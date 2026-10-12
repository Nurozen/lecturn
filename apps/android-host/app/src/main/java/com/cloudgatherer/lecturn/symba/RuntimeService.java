package com.cloudgatherer.lecturn.symba;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;

public final class RuntimeService extends Service implements HostController.Listener {
    static final String START = "com.cloudgatherer.lecturn.symba.START";
    static final String STOP = "com.cloudgatherer.lecturn.symba.STOP";
    static final String OPEN_TASK = "com.cloudgatherer.lecturn.symba.OPEN_TASK";
    private static final String CHANNEL = "local-runtime";
    private HostController host;
    private ActivityOverlay overlay;
    private PowerManager.WakeLock wake;
    private PowerManager.WakeLock startupWake;
    private final WorkLease lease = new WorkLease();
    private boolean stopping;
    private boolean foreground;

    @Override public void onCreate() {
        super.onCreate();
        host = ((HostApplication) getApplication()).controller;
        getSystemService(NotificationManager.class).createNotificationChannel(
                new NotificationChannel(CHANNEL, "Local Lecturn runtime", NotificationManager.IMPORTANCE_LOW));
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Lecturn:ActiveTask");
        wake.setReferenceCounted(false);
        startupWake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Lecturn:RuntimeStartup");
        startupWake.setReferenceCounted(false);
        overlay = new ActivityOverlay(this, host, () -> {
            stopping = true;
            host.stop();
        });
        host.add(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) { stopSelf(); return START_NOT_STICKY; }
        String action = intent.getAction();
        if (!START.equals(action) && !STOP.equals(action)) { stopSelf(); return START_NOT_STICKY; }
        Notification notification = notification();
        if (Build.VERSION.SDK_INT >= 34) startForeground(1, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        else startForeground(1, notification);
        foreground = true;
        if (STOP.equals(action)) { stopping = true; host.stop(); }
        else {
            stopping = host.hasPendingStop();
            if (host.verified() && ("ready".equals(host.state.runtime) || "starting".equals(host.state.runtime))) host.refresh();
            else host.start();
        }
        host.monitor(true);
        changed();
        return START_NOT_STICKY;
    }

    @Override public void changed() {
        boolean stopped = stopping && !host.busy && host.verified() && "stopped".equals(host.state.runtime);
        if (!host.stopping && !stopped) stopping = false;
        WorkLease.Action action = lease.update(host.state, host.verified() && !stopping,
                host.receivedAt, android.os.SystemClock.elapsedRealtime(), wake.isHeld());
        if (action == WorkLease.Action.ACQUIRE) wake.acquire(WorkLease.TIMEOUT_MS);
        else if (action == WorkLease.Action.RELEASE) wake.release();
        WorkLease.Action startupAction = host.startupLease.update(host.state, host.verified(),
                host.receivedAt, android.os.SystemClock.elapsedRealtime(), startupWake.isHeld(), stopping);
        if (startupAction == WorkLease.Action.ACQUIRE) startupWake.acquire(host.startupLease.timeoutMs());
        else if (startupAction == WorkLease.Action.RELEASE) startupWake.release();
        overlay.update();
        if (foreground) getSystemService(NotificationManager.class).notify(1, notification());
        if (stopped) {
            stopForeground(STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private Notification notification() {
        String text;
        if (!host.verified()) text = host.busy ? "Contacting local runtime…" : "Status unavailable · runtime unverified";
        else if (!"ready".equals(host.state.runtime)) text = "Runtime " + host.state.runtime;
        else text = "Runtime ready · " + host.state.activity;
        if (stopping && host.busy) text = "Stopping local runtime…";
        if (host.stopFailure != null) text = host.stopFailure;
        PendingIntent open = PendingIntent.getActivity(this, 0,
                new Intent(this, MainActivity.class).setAction(OPEN_TASK), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        PendingIntent stop = PendingIntent.getService(this, 1,
                new Intent(this, RuntimeService.class).setAction(STOP), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.lecturn_mark)
                .setContentTitle("Lecturn").setContentText(text).setContentIntent(open)
                .setOngoing(true).setOnlyAlertOnce(true).setVisibility(Notification.VISIBILITY_PRIVATE)
                .addAction(new Notification.Action.Builder(null, "Open", open).build())
                .addAction(new Notification.Action.Builder(null, "Stop", stop).build()).build();
    }

    @Override public void onDestroy() {
        host.remove(this);
        host.monitor(false);
        overlay.close();
        if (wake.isHeld()) wake.release();
        if (startupWake.isHeld()) startupWake.release();
        super.onDestroy();
    }
    @Override public IBinder onBind(Intent intent) { return null; }
}
