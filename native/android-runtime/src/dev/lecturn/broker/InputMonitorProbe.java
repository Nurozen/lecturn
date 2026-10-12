package dev.lecturn.broker;

import java.util.concurrent.atomic.AtomicLong;
import org.json.JSONObject;

/** Root-local, read-only qualification entry point. No tokens, listener, policy or injection. */
public final class InputMonitorProbe {
    public static void main(String[] args) throws Exception {
        if(args.length!=2 || android.os.Process.myUid()!=0) throw new IllegalArgumentException("root_library_seconds_required");
        int seconds=Integer.parseInt(args[1]);
        if(seconds<1 || seconds>60) throw new IllegalArgumentException("duration_out_of_range");
        System.load(args[0]);
        AtomicLong events=new AtomicLong();
        PhysicalInput source=new PhysicalInput();
        try {
            source.start(events::incrementAndGet);
            for(int sample=0;sample<=seconds;sample++) {
                System.out.println(new JSONObject().put("schemaVersion",1).put("kind","physicalInputProbe")
                        .put("sample",sample).put("ready",source.ready()).put("inputOrFailureNotifications",events.get())
                        .put("injectionTested",false));
                if(sample<seconds) Thread.sleep(1000);
            }
        } finally { source.close(); }
    }
}
