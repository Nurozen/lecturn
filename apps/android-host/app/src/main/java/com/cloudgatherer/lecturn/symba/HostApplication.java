package com.cloudgatherer.lecturn.symba;

import android.app.Application;

public final class HostApplication extends Application {
    HostController controller;
    boolean floatingChat;
    @Override public void onCreate() {
        super.onCreate();
        controller = new HostController(this);
        ChatWidget.clear(this);
    }
}
