import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location("mobile_mcp", Path(__file__).parents[1] / "client/mobile_mcp.py")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class FakeAgent:
    def __init__(self):
        self.calls = []

    def call(self, name, arguments):
        self.calls.append((name, arguments))
        return {"content": [{"type": "text", "text": "synthetic fixture"}]}


class MCPTest(unittest.TestCase):
    def setUp(self):
        self.agent = FakeAgent()
        self.mcp = m.MCP(self.agent)

    def req(self, method, params=None, request_id=1):
        return self.mcp.handle({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})

    def initialize(self):
        return self.req("initialize", {"protocolVersion": "2025-03-26"})

    def test_init_and_tools(self):
        self.assertEqual(self.req("tools/list")["error"]["code"], -32000)
        self.assertEqual(self.initialize()["result"]["protocolVersion"], "2025-03-26")
        tools = self.req("tools/list")["result"]["tools"]
        self.assertEqual(len(tools), 12)
        self.assertTrue(all(t["name"].startswith("mobile_") for t in tools))
        self.assertFalse(any("shell" in t["name"] or "policy" in t["name"] for t in tools))
        self.assertIn("error", self.initialize())

    def test_notifications_never_execute(self):
        self.initialize()
        self.assertIsNone(self.mcp.handle({"jsonrpc": "2.0", "method": "tools/call", "params": {"name": "mobile_list_apps"}}))
        self.assertEqual(self.agent.calls, [])

    def test_typed_calls(self):
        self.initialize()
        self.assertIn("result", self.req("tools/call", {"name": "mobile_read_file", "arguments": {"root": "ce", "package": "com.example.app", "path": "file"}}))
        self.assertEqual(len(self.agent.calls), 1)
        for params in [
            {"name": "mobile_shell", "arguments": {"command": "id"}},
            {"name": "mobile_screen_lease", "arguments": {"seconds": True}},
            {"name": "mobile_screen_lease", "arguments": {"seconds": 16}},
            {"name": "mobile_press_button", "arguments": {"leaseId": "x", "key": "POWER"}},
            {"name": "mobile_list_apps", "arguments": {"fullAccess": True}},
            {"name": "mobile_list_apps", "arguments": {}, "mode": "full-access"},
            {"name": "mobile_list_apps", "arguments": {}, "_meta": []},
        ]:
            self.assertIn("error", self.req("tools/call", params))
        self.assertEqual(len(self.agent.calls), 1)

    def test_chunked_reads_and_public_roots(self):
        self.initialize()
        args = {"root": "downloads", "package": "", "path": "large.bin", "offset": 262144, "length": 4096}
        self.assertIn("result", self.req("tools/call", {"name": "mobile_read_file", "arguments": args}))
        self.assertEqual(self.agent.calls[-1][1], args)
        for field, value in [("offset", -1), ("offset", True), ("offset", 9223372036854775807), ("length", 0), ("length", 262145)]:
            self.assertIn("error", self.req("tools/call", {"name": "mobile_read_file", "arguments": {**args, field: value}}))
        schema = m.BY_NAME["mobile_read_file"]["inputSchema"]
        self.assertNotIn("offset", schema["required"])
        self.assertNotIn("length", schema["required"])
        self.assertIn("documents", schema["properties"]["root"]["enum"])

    def test_owner_storage_and_write_limit(self):
        self.initialize()
        for name in ("mobile_list_files", "mobile_read_file", "mobile_write_file", "mobile_delete_file"):
            args = {"root": "storage", "package": "", "path": "DCIM/Camera/photo.jpg"}
            if name == "mobile_write_file":
                args["data"] = base64.b64encode(b"x" * 262144).decode()
            self.assertIn("result", self.req("tools/call", {"name": name, "arguments": args}))
            self.assertEqual(self.agent.calls[-1], (name, args))
            roots = m.BY_NAME[name]["inputSchema"]["properties"]["root"]["enum"]
            self.assertIn("storage", roots)
            self.assertIn("obb", roots)
        args = {"root": "storage", "package": "", "path": "file",
                "data": base64.b64encode(b"x" * 262147).decode()}
        self.assertIn("error", self.req("tools/call", {"name": "mobile_write_file", "arguments": args}))
        args["data"] = ""
        args["offset"] = 262144
        self.assertIn("error", self.req("tools/call", {"name": "mobile_write_file", "arguments": args}))

    def test_framing(self):
        source = io.BytesIO(b'{"jsonrpc":"2.0","id":1,"method":"ping"}\n' + b'x' * (m.MAX_FRAME + 1) + b'\n' + b'{"id":1,"id":2}\n' + b'{"jsonrpc":"2.0","id":2,"method":"ping"}')
        dest = io.StringIO()
        m.serve(self.mcp, source, dest)
        replies = [json.loads(line) for line in dest.getvalue().splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["result"], {})
        self.assertEqual(replies[1]["error"]["message"], "Frame too large")
        self.assertEqual(replies[2]["error"]["code"], -32700)

    def test_token_file(self):
        with tempfile.TemporaryDirectory(dir=os.environ["BROKER_TEST_TMP"]) as folder:
            token = Path(folder) / "agent-token"
            token.write_text("a" * 64)
            token.chmod(0o600)
            self.assertEqual(m.read_token(str(token)), "a" * 64)
            token.chmod(0o644)
            with self.assertRaises(ValueError):
                m.read_token(str(token))
            token.chmod(0o600)
            link = Path(folder) / "link"
            link.symlink_to(token)
            with self.assertRaises(OSError):
                m.read_token(str(link))
            token.write_text("a" * 65)
            with self.assertRaises(ValueError):
                m.read_token(str(token))

    def test_cli_refuses_guest_root(self):
        with mock.patch.object(m.os, "geteuid", return_value=0), \
                mock.patch.object(m.sys, "argv", ["mobile_mcp.py", "--token-file", "never-opened"]), \
                mock.patch.object(m, "read_token") as token, \
                mock.patch.object(m.sys, "stderr", io.StringIO()):
            self.assertEqual(m.main(), 1)
            token.assert_not_called()

    def test_http_is_agent_only_and_image_content(self):
        png = base64.b64encode(b"\x89PNG\r\n\x1a\nfixture").decode()
        fake = mock.MagicMock()
        fake.getresponse.return_value.status = 200
        fake.getresponse.return_value.read.return_value = json.dumps({"result": {"mimeType": "image/png", "data": png}, "receipt": {"id": "synthetic"}}).encode()
        with mock.patch.object(m.http.client, "HTTPConnection", return_value=fake) as connect:
            out = m.Agent("b" * 64).call("mobile_take_screenshot", {"leaseId": "fixture"})
            connect.assert_called_once_with("127.0.0.1", 18769, timeout=10)
            self.assertEqual(out["content"][0]["type"], "image")
            self.assertEqual(fake.request.call_args.args[:2], ("POST", "/v1/tools/call"))
            self.assertEqual(json.loads(fake.request.call_args.args[2])["name"], "mobile_screenshot")
            fake.getresponse.return_value.status = 403
            fake.getresponse.return_value.read.return_value = b'secret-must-not-echo'
            out = m.Agent("b" * 64).call("mobile_list_apps", {})
            self.assertTrue(out["isError"])
            self.assertNotIn("secret-must-not-echo", json.dumps(out))


if __name__ == "__main__":
    unittest.main()
