package dev.lecturn.broker;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.*;
import org.json.*;

final class Protocol {
    static final int MAX_BODY = 384 * 1024, MAX_HEADERS = 8192;
    static final class Request {
        final String method, path;
        final JSONObject body;
        Request(String method, String path, JSONObject body) { this.method = method; this.path = path; this.body = body; }
    }
    static Request read(InputStream input, String token, int port) throws Exception {
        ByteArrayOutputStream header = new ByteArrayOutputStream();
        int state = 0;
        while (state != 4) {
            int b = input.read();
            if (b < 0) throw new Failure(400, "incomplete_headers");
            header.write(b);
            if (header.size() > MAX_HEADERS) throw new Failure(431, "headers_too_large");
            state = (state == 0 || state == 2) ? (b == '\r' ? state + 1 : 0)
                    : (b == '\n' ? state + 1 : (b == '\r' ? 1 : 0));
        }
        String[] lines = header.toString(StandardCharsets.US_ASCII.name()).split("\r\n");
        String[] first = lines[0].split(" ", -1);
        if (first.length != 3 || !first[2].equals("HTTP/1.1") || !first[1].matches("/v1/[a-z/]+"))
            throw new Failure(400, "invalid_request_line");
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon <= 0 || !lines[i].substring(0, colon).matches("[A-Za-z-]+")) throw new Failure(400, "invalid_header");
            String key = lines[i].substring(0, colon).toLowerCase(Locale.ROOT);
            String value = lines[i].substring(colon + 1).trim();
            if (headers.put(key, value) != null) throw new Failure(400, "duplicate_header");
        }
        // Native clients send no Origin; reject every browser origin, including opaque/null.
        if (headers.containsKey("origin") || headers.containsKey("referer")
                || (headers.containsKey("sec-fetch-site") && !headers.get("sec-fetch-site").equals("none")))
            throw new Failure(403, "browser_origin_forbidden");
        if (!Objects.equals(headers.get("host"), "127.0.0.1:" + port)) throw new Failure(403, "invalid_host");
        byte[] wanted = ("Bearer " + token).getBytes(StandardCharsets.US_ASCII);
        byte[] supplied = headers.getOrDefault("authorization", "").getBytes(StandardCharsets.US_ASCII);
        if (!MessageDigest.isEqual(wanted, supplied)) throw new Failure(401, "unauthorized");
        if (headers.containsKey("transfer-encoding") || headers.containsKey("expect")) throw new Failure(400, "unsupported_framing");
        String length = headers.getOrDefault("content-length", "0");
        if (!length.matches("0|[1-9][0-9]{0,6}")) throw new Failure(400, "invalid_length");
        int count = Integer.parseInt(length);
        if (count > MAX_BODY) throw new Failure(413, "body_too_large");
        if (!first[0].equals("POST") && !first[0].equals("GET")) throw new Failure(405, "method_not_allowed");
        if (first[0].equals("GET") && count != 0) throw new Failure(400, "get_body_forbidden");
        if (first[0].equals("POST") && (!headers.getOrDefault("content-type", "").equals("application/json") || count == 0))
            throw new Failure(400, "json_body_required");
        byte[] bytes = new byte[count];
        new DataInputStream(input).readFully(bytes);
        JSONObject body = count == 0 ? new JSONObject() : json(bytes);
        return new Request(first[0], first[1], body);
    }
    static JSONObject json(byte[] bytes) throws Exception {
        String source = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(java.nio.charset.CodingErrorAction.REPORT)
                .decode(java.nio.ByteBuffer.wrap(bytes)).toString();
        new Syntax(source).validate();
        JSONTokener t = new JSONTokener(source);
        Object v = t.nextValue();
        if (!(v instanceof JSONObject) || t.nextClean() != 0) throw new Failure(400, "invalid_json");
        return (JSONObject)v;
    }
    // Android JSONTokener accepts non-JSON syntax and silently replaces duplicate
    // keys. Validate before parsing so host and Android have identical boundaries.
    private static final class Syntax {
        final String source;
        int at;
        Syntax(String source) { this.source = source; }
        void invalid() throws Failure { throw new Failure(400, "invalid_json"); }
        void whitespace() {
            while (at < source.length() && " \t\r\n".indexOf(source.charAt(at)) >= 0) at++;
        }
        boolean take(char c) {
            whitespace();
            if (at < source.length() && source.charAt(at) == c) { at++; return true; }
            return false;
        }
        void validate() throws Exception {
            whitespace();
            if (at >= source.length() || source.charAt(at) != '{') invalid();
            value(0); whitespace();
            if (at != source.length()) invalid();
        }
        String string() throws Exception {
            whitespace(); int start = at;
            if (at >= source.length() || source.charAt(at++) != '"') invalid();
            while (at < source.length()) {
                char c = source.charAt(at++);
                if (c == '"') return (String)new JSONTokener(source.substring(start,at)).nextValue();
                if (c < 0x20) invalid();
                if (c == '\\') {
                    if (at == source.length()) invalid();
                    char escape = source.charAt(at++);
                    if (escape == 'u') {
                        for (int i = 0; i < 4; i++) {
                            if (at == source.length() || "0123456789abcdefABCDEF".indexOf(source.charAt(at++)) < 0) invalid();
                        }
                    } else if ("\"\\/bfnrt".indexOf(escape) < 0) invalid();
                }
            }
            invalid(); return "";
        }
        void value(int depth) throws Exception {
            if (depth > 32) invalid();
            whitespace();
            if (at == source.length()) invalid();
            char c = source.charAt(at);
            if (c == '{') {
                at++; Set<String> keys = new HashSet<>();
                if (take('}')) return;
                do {
                    if (!keys.add(string()) || !take(':')) invalid();
                    value(depth + 1);
                    if (take('}')) return;
                } while (take(','));
                invalid();
            } else if (c == '[') {
                at++; if (take(']')) return;
                do { value(depth + 1); if (take(']')) return; } while (take(','));
                invalid();
            } else if (c == '"') {
                string();
            } else {
                int start = at;
                while (at < source.length() && ",]} \t\r\n".indexOf(source.charAt(at)) < 0) at++;
                String scalar = source.substring(start,at);
                if (!scalar.matches("true|false|null|-?(0|[1-9][0-9]*)(\\.[0-9]+)?([eE][+-]?[0-9]+)?")) invalid();
            }
        }
    }
    static void fields(JSONObject o, String... allowed) throws Failure {
        Set<String> keys = new HashSet<>(Arrays.asList(allowed));
        Iterator<String> it = o.keys();
        while (it.hasNext()) if (!keys.contains(it.next())) throw new Failure(400, "unknown_argument");
    }
    static String string(JSONObject o, String key) throws Failure {
        Object v = o.opt(key);
        if (!(v instanceof String)) throw new Failure(400, "string_required");
        return (String)v;
    }
    static long integer(JSONObject o, String key, long min, long max) throws Failure {
        Object v = o.opt(key);
        if (!(v instanceof Integer) && !(v instanceof Long)) throw new Failure(400, "integer_required");
        long n = ((Number)v).longValue();
        if (n < min || n > max) throw new Failure(400, "integer_out_of_range");
        return n;
    }
    static boolean bool(JSONObject o, String key) throws Failure {
        Object v = o.opt(key);
        if (!(v instanceof Boolean)) throw new Failure(400, "boolean_required");
        return (Boolean)v;
    }
    static byte[] bounded(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) { if (out.size() + n > max) throw new IOException("bounded_output_exceeded"); out.write(buf, 0, n); }
        return out.toByteArray();
    }
    static void respond(OutputStream out, int status, JSONObject body) throws IOException {
        byte[] data = body.toString().getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + " Result\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nX-Content-Type-Options: nosniff\r\nContent-Length: " + data.length + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        out.write(data); out.flush();
    }
}
