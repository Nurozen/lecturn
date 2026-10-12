package dev.lecturn.broker;

public final class SecureFilesTest {
    private static void denied(String root, String pkg, String path) throws Exception {
        try { SecureFiles.target(root,pkg,path); }
        catch (Failure expected) {
            if (expected.status == 400) return;
            throw new AssertionError("Unexpected rejection status",expected);
        }
        throw new AssertionError("Allowed forbidden target: " + root + ":" + path);
    }
    static void paths() throws Exception {
        for (String path : new String[]{"", "DCIM/Camera/photo.jpg", "Pictures/image.png",
                "Movies/video.mp4", "Music/song.flac", "Recordings/audio.wav", "Download/file",
                "Documents/notes", "owner-file.txt", "Android-backup/file", "nested/Android/file"})
            SecureFiles.target("storage","",path);
        for (String path : new String[]{"Android", "Android/data", "android/media/com.example.app/file",
                "ANDROID/obb/com.example.app/file", "Android/data/com.cloudgatherer.lecturn.symba/files/token",
                "Android/media/com.android.keychain/file", "../10/DCIM/file", "/data/media/10/file",
                "DCIM/../../1/file", "DCIM//file", "DCIM/./file", "DCIM/../file", "DCIM\\file",
                "DCIM/\0file", "DCIM/.LECTURN-stage", ".lecturn-stage"})
            denied("storage","",path);
        denied("storage","com.example.app","DCIM/file");
        denied("/data/media/0","","DCIM/file");
        denied("storage10","","DCIM/file");
        for (String root : new String[]{"ce", "de", "shared", "media", "obb"}) {
            SecureFiles.target(root,"com.example.app","files/keys/private.key");
            denied(root,"com.cloudgatherer.lecturn.symba","files/token");
            denied(root,"com.android.keychain","files/key");
            denied(root,"","file");
        }
        if (!SecureFiles.publicRoot("storage") || SecureFiles.publicRoot("obb"))
            throw new AssertionError("Package installation gate classification changed");
    }
    public static void main(String[] args) throws Exception {
        paths();
        System.out.println("SecureFilesTest: owner storage and package boundaries passed");
    }
}
