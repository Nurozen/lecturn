package com.cloudgatherer.lecturn.symba;

import android.content.ContentResolver;
import android.net.Uri;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Proxy;
import java.net.URL;

final class PrivateDownload {
    // Keep authenticated URLs out of DownloadManager's shared database and external intents.
    static void save(ContentResolver resolver, Uri destination, String source, String cookie) throws Exception {
        if (!OriginPolicy.isUi(source) || !"content".equals(destination.getScheme())) throw new IllegalArgumentException("Invalid download");
        HttpURLConnection connection = (HttpURLConnection) new URL(source).openConnection(Proxy.NO_PROXY);
        try {
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(3000); connection.setReadTimeout(15000); connection.setUseCaches(false);
            if (cookie != null) connection.setRequestProperty("Cookie", cookie);
            if (connection.getResponseCode() != 200) throw new IllegalStateException("Download not available");
            try (InputStream in = connection.getInputStream(); OutputStream out = resolver.openOutputStream(destination, "wt")) {
                if (out == null) throw new IllegalStateException("Destination unavailable");
                byte[] buffer = new byte[32768]; long total = 0; int count;
                long deadline = android.os.SystemClock.elapsedRealtime() + 120000;
                while ((count = in.read(buffer)) != -1) {
                    total += count;
                    if (total > 256L * 1024 * 1024 || android.os.SystemClock.elapsedRealtime() > deadline) throw new IllegalStateException("Download limit reached");
                    out.write(buffer, 0, count);
                }
            }
        } finally { connection.disconnect(); }
    }
}
