package dev.lecturn.broker;

import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.os.PowerManager;
import android.os.UserManager;
import android.os.SystemClock;
import android.view.InputEvent;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.KeyEvent;
import java.lang.reflect.Method;
import java.util.*;
import org.json.*;

final class AndroidAccess implements Policy.Visibility {
    final Context context;
    private final Object trustManager;
    private final Method deviceLocked;
    private final Object windowManager;
    private final Method keyguardLocked;
    private ScreenArbiter arbiter;
    void initializeArbitration(Policy policy) {
        try { arbiter=new ScreenArbiter(policy,new PhysicalInput(),new FrameworkGestures()); }
        catch(Exception | LinkageError e) { policy.setArbitration(()->false,()->{}); }
    }
    private static final class FrameworkGestures implements ScreenArbiter.GestureAdapter {
        private final Object manager;
        private final Method inject;
        private long downTime, keyDownTime;
        FrameworkGestures() throws Exception {
            Class<?> type;
            try { type=Class.forName("android.hardware.input.InputManagerGlobal"); }
            catch(ClassNotFoundException e) { type=Class.forName("android.hardware.input.InputManager"); }
            manager=type.getMethod("getInstance").invoke(null);
            inject=type.getMethod("injectInputEvent",InputEvent.class,int.class);
        }
        private void send(InputEvent event) throws Exception {
            // Mode 0 enqueues without waiting for app dispatch/finish. No shell process can outlive the lease.
            if(!Boolean.TRUE.equals(inject.invoke(manager,event,0))) throw new Failure(503,"input_injection_failed");
        }
        public void touch(int action,float x,float y) throws Exception {
            long now=SystemClock.uptimeMillis();if(action==MotionEvent.ACTION_DOWN)downTime=now;
            MotionEvent event=MotionEvent.obtain(downTime,now,action,x,y,0);
            event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
            try { send(event); } finally { event.recycle(); }
        }
        public void key(int action,int code) throws Exception {
            long now=SystemClock.uptimeMillis();if(action==KeyEvent.ACTION_DOWN)keyDownTime=now;
            send(new KeyEvent(keyDownTime,now,action,code,0,0,-1,0,0,InputDevice.SOURCE_KEYBOARD));
        }
        public void cancelKey(int code) throws Exception {
            send(new KeyEvent(keyDownTime,SystemClock.uptimeMillis(),KeyEvent.ACTION_UP,code,0,0,-1,0,
                    KeyEvent.FLAG_CANCELED,InputDevice.SOURCE_KEYBOARD));
        }
    }
    AndroidAccess() throws Exception {
        Class<?> thread=Class.forName("android.app.ActivityThread");
        Object activity=thread.getMethod("systemMain").invoke(null);
        context=(Context)thread.getMethod("getSystemContext").invoke(activity);
        Object trustBinder=Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"trust");
        if(trustBinder==null) throw new IllegalStateException("trust_service_unavailable");
        trustManager=Class.forName("android.app.trust.ITrustManager$Stub")
                .getMethod("asInterface",android.os.IBinder.class).invoke(null,trustBinder);
        deviceLocked=Class.forName("android.app.trust.ITrustManager").getMethod("isDeviceLocked",int.class,int.class);
        Object windowBinder=Class.forName("android.os.ServiceManager").getMethod("getService",String.class).invoke(null,"window");
        if(windowBinder==null) throw new IllegalStateException("window_service_unavailable");
        windowManager=Class.forName("android.view.IWindowManager$Stub")
                .getMethod("asInterface",android.os.IBinder.class).invoke(null,windowBinder);
        keyguardLocked=Class.forName("android.view.IWindowManager").getMethod("isKeyguardLocked");
    }
    public boolean userDataAvailable() {
        try {
            Method current=Class.forName("android.app.ActivityManager").getMethod("getCurrentUser");
            if (((Number)current.invoke(null)).intValue()!=0) return false;
            UserManager users=(UserManager)context.getSystemService(Context.USER_SERVICE);
            // CE stays available after first unlock, including with the display off.
            return users!=null && users.isUserUnlocked();
        } catch (Exception e) { return false; }
    }
    public boolean unlockedAndVisible() {
        try {
            if (!userDataAvailable()) return false;
            PowerManager power=(PowerManager)context.getSystemService(Context.POWER_SERVICE);
            // app_process lacks ApplicationSharedMemory used by KeyguardManager.
            // Query both framework services directly; unknown state denies access.
            return Boolean.FALSE.equals(deviceLocked.invoke(trustManager,0,0))
                    && Boolean.FALSE.equals(keyguardLocked.invoke(windowManager))
                    && power!=null && power.isInteractive();
        } catch (Exception e) { return false; }
    }

    boolean installed(String pkg) {
        try { context.getPackageManager().getApplicationInfo(pkg,0);return true; } catch (Exception e) { return false; }
    }
    JSONArray packages() throws Exception {
        List<ApplicationInfo> apps=context.getPackageManager().getInstalledApplications(0);
        if (apps.size()>4096) throw new Failure(413,"package_list_too_large");
        JSONArray out=new JSONArray();
        for (ApplicationInfo app:apps) {
            try { SecureFiles.target("ce",app.packageName,""); }
            catch (Failure denied) { continue; }
            out.put(new JSONObject().put("package",app.packageName));
        }
        return out;
    }
    JSONObject screen(String tool,JSONObject args,Policy policy,long epoch,String lease) throws Exception {
        if(arbiter==null) throw new Failure(501,"physical_input_arbitration_unavailable");
        return arbiter.run(new ScreenArbiter.Guard() {
            public void check() throws Exception { policy.checkScreen(epoch,lease); }
            public void current() throws Exception { policy.checkScreenLease(epoch,lease); }
        },()->screenAction(tool,args));
    }
    private JSONObject screenAction(String tool,JSONObject args) throws Exception {
        switch (tool) {
            case "mobile_screenshot":
                Protocol.fields(args,"leaseId");
                byte[] png=RuntimeAdapter.run(3,8*1024*1024,"/system/bin/screencap","-p");
                if (png.length<8 || png[0]!=(byte)137 || png[1]!=80 || png[2]!=78 || png[3]!=71 || png[4]!=13 || png[5]!=10 || png[6]!=26 || png[7]!=10) throw new Failure(502,"invalid_screenshot");
                return new JSONObject().put("mimeType","image/png").put("data",Base64.getEncoder().encodeToString(png));
            case "mobile_tap":
                Protocol.fields(args,"leaseId","x","y");
                arbiter.touch(0,coordinate(args,"x"),coordinate(args,"y"));
                arbiter.touch(1,coordinate(args,"x"),coordinate(args,"y"));break;
            case "mobile_swipe":
                Protocol.fields(args,"leaseId","x1","y1","x2","y2","durationMs");
                arbiter.swipe(coordinate(args,"x1"),coordinate(args,"y1"),coordinate(args,"x2"),coordinate(args,"y2"),(int)Protocol.integer(args,"durationMs",50,1000));break;
            case "mobile_key":
                Protocol.fields(args,"leaseId","key");
                String key=Protocol.string(args,"key");
                if (!key.matches("HOME|BACK|APP_SWITCH|ENTER|DPAD_UP|DPAD_DOWN|DPAD_LEFT|DPAD_RIGHT")) throw new Failure(400,"key_not_allowed");
                int code=KeyEvent.keyCodeFromString("KEYCODE_"+key);
                arbiter.key(0,code);arbiter.key(1,code);break;
            case "mobile_launch_package":
                Protocol.fields(args,"leaseId","package");
                String pkg=Protocol.string(args,"package");SecureFiles.target("ce",pkg,"");
                Intent intent=context.getPackageManager().getLaunchIntentForPackage(pkg);
                if (intent==null) throw new Failure(404,"launch_activity_unavailable");
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                arbiter.step(()->{context.startActivity(intent);return null;});break;
            default: throw new Failure(404,"unknown_screen_tool");
        }
        return new JSONObject().put("accepted",true);
    }
    private static float coordinate(JSONObject a,String k) throws Exception { return Protocol.integer(a,k,0,16383); }
}
