package com.cloudgatherer.lecturn.symba;

import android.app.Application;

public final class HostApplication extends Application {
    HostController controller;
    NativeConnect connect;
    boolean floatingChat;
    @Override public void onCreate() {
        super.onCreate();
        connect = new NativeConnect(this);
        connect.initialize();
        controller = new HostController(this);
        ChatWidget.clear(this);
    }
}
