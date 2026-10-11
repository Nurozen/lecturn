package dev.lecturn.broker;

final class SecureFiles {
    static final int MAX_FILE = 256 * 1024;
    static native byte[] privateFile(String absolute, int max, int allowedUid);
    static native boolean supported();
    static final class Chunk {
        final byte[] data;
        final long totalBytes;
        Chunk(byte[] data,long totalBytes) { this.data=data;this.totalBytes=totalBytes; }
    }
    static native Chunk read(String root, String pkg, String path,long offset,int length);
    static boolean publicRoot(String root) { return root.equals("storage") || root.equals("downloads") || root.equals("documents"); }
    static native String[] list(String root, String pkg, String path);
    static native long stage(String root, String pkg, String path, byte[] data);
    static native void commit(long handle);
    static native void discard(long handle);
    static native void delete(String root, String pkg, String path);
    static void target(String root, String pkg, String path) throws Failure {
        if (publicRoot(root) ? !pkg.isEmpty() : (!root.matches("ce|de|shared|media|obb") || !pkg.matches("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")
                || pkg.length() > 200 || pkg.equals("com.cloudgatherer.lecturn.symba")
                || pkg.equals("com.android.keychain")))
            throw new Failure(400, "target_forbidden");
        if (path.length() > 1024 || path.startsWith("/") || path.contains("\\") || path.indexOf('\0') >= 0)
            throw new Failure(400, "invalid_path");
        // Keep Android package directories behind the installed-package check, including
        // case variants on casefolded shared-storage filesystems.
        if (root.equals("storage") && path.split("/", 2)[0].equalsIgnoreCase("Android"))
            throw new Failure(400, "path_forbidden");
        if (path.isEmpty()) return; // listing the selected root only
        for (String segment : path.split("/", -1)) {
            String lower = segment.toLowerCase(java.util.Locale.ROOT);
            if (segment.isEmpty() || segment.equals(".") || segment.equals("..") || segment.length() > 200
                    || lower.startsWith(".lecturn-"))
                throw new Failure(400, "path_forbidden");
        }
    }
}
