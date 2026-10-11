#!/usr/bin/env python3
"""Pinned, no-inference qualification. --guest is Linux UID 1000 only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import selectors
import signal
import socket
import subprocess
import sys
import tempfile
import time

PINS = {"node": "24.14.1", "codex": "0.160.1", "claude": "2.1.291",
        "lecturn": "0.0.51-nightly.20261008.98"}
MODES = {
    "approval-required": ("untrusted", "read-only", "user", "readOnly"),
    "auto-accept-edits": ("on-request", "workspace-write", "user", "workspaceWrite"),
    "auto": ("on-request", "workspace-write", "auto_review", "workspaceWrite"),
    "full-access": ("never", "danger-full-access", "user", "dangerFullAccess"),
}
HERE = Path(__file__).resolve().parent
ACTIVE = set()


def stop(process):
    # The group ID is captured at spawn, never discovered by name or path.
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        pass
    finally:
        # Also reap descendants if the group leader exited before its children.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=2)
        ACTIVE.discard(process)


def interrupted(signum, _frame):
    for process in list(ACTIVE):
        stop(process)
    raise SystemExit(128 + signum)


def isolated_env(home):
    home.mkdir(parents=True)
    for name in [".codex", ".claude", ".config", ".cache", ".local/share", "tmp"]:
        (home / name).mkdir(parents=True)
    # Allowlist: no ambient API keys, auth helpers, NODE_OPTIONS, proxy or provider config.
    return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "HOME": str(home), "CODEX_HOME": str(home / ".codex"),
            "CLAUDE_CONFIG_DIR": str(home / ".claude"),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_DATA_HOME": str(home / ".local/share"),
            "TMPDIR": str(home / "tmp"), "LANG": "C.UTF-8", "TERM": "xterm-256color",
            "DISABLE_AUTOUPDATER": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def enum_values(value):
    if isinstance(value, dict):
        result = set(value.get("enum", []))
        for child in value.values():
            result |= enum_values(child)
        return result
    if isinstance(value, list):
        result = set()
        for child in value:
            result |= enum_values(child)
        return result
    return set()


def schema_modes(schema):
    defs, props = schema["definitions"], schema["properties"]
    for field in ["approvalPolicy", "sandbox", "approvalsReviewer"]:
        require(field in props, f"Missing thread/start field: {field}")
    policies = enum_values(defs["AskForApproval"])
    sandboxes = enum_values(defs["SandboxMode"])
    reviewers = enum_values(defs["ApprovalsReviewer"])
    for mode, (policy, sandbox, reviewer, _) in MODES.items():
        require(policy in policies and sandbox in sandboxes and reviewer in reviewers,
                f"Unsupported mode {mode}; no fallback permitted")
    return {"policies": sorted(policies), "sandboxes": sorted(sandboxes),
            "reviewers": sorted(reviewers)}


def verify_thread(result, mode):
    policy, _, reviewer, sandbox = MODES[mode]
    require(result.get("approvalPolicy") == policy, f"{mode}: approval policy drift")
    require(result.get("approvalsReviewer") == reviewer, f"{mode}: reviewer drift")
    actual = result.get("sandbox", {})
    require(actual.get("type") == sandbox, f"{mode}: sandbox drift")
    if sandbox in ("readOnly", "workspaceWrite"):
        require(actual.get("networkAccess", False) is False, f"{mode}: network unexpectedly allowed")
    thread_id = result.get("thread", {}).get("id")
    require(isinstance(thread_id, str) and bool(thread_id), "Missing real thread ID")


class Suite:
    def __init__(self, root):
        self.root = root
        self.results = []

    def record(self, name, status, detail):
        self.results.append({"test": name, "status": status, "detail": detail})
        print(f"{status}: {name}: {str(detail)[:300]}", flush=True)
        (self.root / "results.json").write_text(json.dumps(self.results, indent=2) + "\n")

    def test(self, name, fn):
        try:
            detail = fn()
            self.record(name, "PASS", detail)
            return detail
        except Exception as error:
            self.record(name, "FAIL", str(error))
            return None

    def case(self, name):
        path = self.root / name
        path.mkdir()
        env = isolated_env(path / "home")
        workspace = path / "workspace"
        workspace.mkdir()
        return path, workspace, env

    def spawn(self, argv, cwd, env, **kwargs):
        process = subprocess.Popen(argv, cwd=cwd, env=env, start_new_session=True, **kwargs)
        ACTIVE.add(process)
        with (self.root / "processes.jsonl").open("a") as log:
            log.write(json.dumps({"pid": process.pid, "argv": argv, "cwd": str(cwd)}) + "\n")
        return process

    def command(self, name, argv, timeout=25):
        path, cwd, env = self.case(name)
        with (path / "stdout.txt").open("w") as out, (path / "stderr.txt").open("w") as err:
            process = self.spawn(argv, cwd, env, stdout=out, stderr=err, stdin=subprocess.DEVNULL)
            try:
                process.wait(timeout=timeout)
                require(process.returncode == 0, f"exit {process.returncode}; see {path}")
            finally:
                stop(process)
        return (path / "stdout.txt").read_text()

    def rpc_mode(self, mode):
        path, cwd, env = self.case("rpc-" + mode)
        # No provider substitutions, credentials, tools, prompts, or turn/start.
        argv = ["codex", "app-server", "--listen", "stdio://"]
        with (path / "stderr.txt").open("w") as err, (path / "wire.jsonl").open("w") as wire:
            process = self.spawn(argv, cwd, env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err)
            sel = selectors.DefaultSelector()
            sel.register(process.stdout, selectors.EVENT_READ)
            pending, buffer, next_id = [], b"", 0

            def send(message):
                wire.write(json.dumps({"send": message}) + "\n"); wire.flush()
                process.stdin.write((json.dumps(message) + "\n").encode()); process.stdin.flush()

            def request(method, params):
                nonlocal buffer, next_id
                require(method in ("initialize", "thread/start", "thread/unsubscribe"), "Forbidden RPC")
                next_id += 1
                ident = next_id
                send({"id": ident, "method": method, "params": params})
                deadline = time.monotonic() + 20
                while time.monotonic() < deadline:
                    while pending:
                        message = pending.pop(0)
                        wire.write(json.dumps({"receive": message}) + "\n"); wire.flush()
                        require(not ("method" in message and "id" in message), "Unexpected server request; abort without approving")
                        if message.get("id") == ident:
                            require("error" not in message, f"{method}: {message.get('error')}")
                            return message["result"]
                    if not sel.select(max(0, deadline - time.monotonic())):
                        break
                    data = os.read(process.stdout.fileno(), 65536)
                    require(data, f"app-server exited during {method}")
                    buffer += data
                    require(len(buffer) < 4 * 1024 * 1024, "Oversized RPC frame")
                    while b"\n" in buffer:
                        line, buffer = buffer.split(b"\n", 1)
                        if line.strip():
                            pending.append(json.loads(line))
                raise RuntimeError(f"{method} timed out; no retry or fallback")

            thread_id = None
            try:
                request("initialize", {"clientInfo": {"name": "lecturn_guest_qualification", "version": "1"},
                                       "capabilities": {"experimentalApi": True}})
                send({"method": "initialized"})
                policy, sandbox, reviewer, _ = MODES[mode]
                result = request("thread/start", {"cwd": str(cwd), "ephemeral": True,
                    "approvalPolicy": policy, "sandbox": sandbox, "approvalsReviewer": reviewer})
                thread_id = result.get("thread", {}).get("id")
                verify_thread(result, mode)
                require(result.get("cwd") == str(cwd), "Workspace mismatch")
                return {"effective": result, "scope": "No-turn ephemeral thread negotiation only"}
            finally:
                try:
                    if thread_id:
                        disposed = request("thread/unsubscribe", {"threadId": thread_id})
                        require(disposed.get("status") == "unsubscribed", f"Dispose not confirmed: {disposed}")
                finally:
                    sel.close()
                    process.stdin.close()
                    # EOF normally shuts down stdio; force only this captured group if necessary.
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        pass
                    stop(process)
                    process.stdout.close()


def cli_checks(suite):
    pins_ok = True
    for cli in ("node", "codex", "claude"):
        def check(cli=cli):
            output = suite.command(cli + "-version", [cli, "--version"])
            require(re.search(r"(?<![\d.])" + re.escape(PINS[cli]) + r"(?![\d.])", output),
                    f"Expected {cli} {PINS[cli]}, got {output.strip()}")
            return output.strip()
        pins_ok = suite.test(cli + "-version", check) is not None and pins_ok
    if not pins_ok:
        suite.record("provider-probes", "FAIL", "Exact CLI version gate failed; refusing provider probes")
        return False
    codex = suite.test("codex-help", lambda: suite.command("codex-help", ["codex", "--help"]))
    claude = suite.test("claude-help", lambda: suite.command("claude-help", ["claude", "--help"]))
    def help_contract():
        require(codex and "--approve-for-me" in codex and "workspace-write" in codex, "Missing Codex auto-review/sandbox flags")
        require(claude, "Missing Claude help")
        match = re.search(r'--permission-mode\s+<mode>(.*?)(?=\n\s+--)', claude, re.S)
        require(match, "Cannot parse permission-mode help; no fallback")
        modes = re.findall(r'"([A-Za-z]+)"', match.group(1))
        require(set(["manual", "acceptEdits", "auto", "bypassPermissions"]) <= set(modes), "Claude permission mode drift")
        return {"claude_advertised": modes, "codex_auto_flag": "--approve-for-me",
                "limit": "Help surface only; Claude startup/default/auto classifier not exercised"}
    help_ok = suite.test("help-contract", help_contract) is not None
    def schema_check():
        target = suite.root / "codex-schema"
        suite.command("schema-generation", ["codex", "app-server", "generate-json-schema", "--experimental", "--out", str(target)])
        return schema_modes(json.loads((target / "v2/ThreadStartParams.json").read_text()))
    schema_ok = suite.test("schema-contract", schema_check) is not None
    return help_ok and schema_ok


def guest_checks(suite, package):
    interfaces = sorted(name for _, name in socket.if_nameindex())
    require(set(interfaces) <= {"lo"}, f"Unexpected network interfaces: {interfaces}")
    suite.record("offline-netns", "PASS", {"interfaces": interfaces, "uid": os.getuid()})
    def package_check():
        data = json.loads((package / "package.json").read_text())
        require(data.get("name") == "lecturn" and data.get("version") == PINS["lecturn"], "Lecturn package pin mismatch")
        entry = package / "dist/bin.mjs"
        require(entry.is_file(), "Missing packaged server entry")
        return {"path": str(package), "version": data["version"],
                "entry_sha256": hashlib.sha256(entry.read_bytes()).hexdigest(),
                "limit": "Version/hash provenance, not proof of packaged adapter mappings"}
    package_ok = suite.test("lecturn-package", package_check) is not None
    if package_ok:
        def version_check():
            output = suite.command("lecturn-version", ["node", str(package / "dist/bin.mjs"), "--version"])
            require(PINS["lecturn"] in output, f"Packaged CLI version mismatch: {output.strip()}")
            return output.strip()
        package_ok = suite.test("lecturn-version", version_check) is not None
    cli_ok = cli_checks(suite)
    if cli_ok:
        for mode in MODES:
            suite.test("codex-thread-" + mode, lambda mode=mode: suite.rpc_mode(mode))
    if package_ok:
        for kind in ("sqlite", "pty", "search"):
            suite.test("packaged-" + kind, lambda kind=kind: suite.command(
                "packaged-" + kind, ["node", str(HERE / "dependencies.mjs"), kind, str(package)], timeout=30).strip())
    suite.record("claude-runtime-modes", "NOT_RUN", "Help choices only; omitted default, SDK startup and auto classifier require parent runtime verification")
    suite.record("nightly-adapter-parity", "NOT_RUN", "Package version/hash checked; source mapping has not been compared to the running nightly adapter")
    suite.record("authenticated-ui-and-inference", "NOT_RUN", "Parent owns UI, server 3773, auth, real turns, approval enforcement, MCP device calls and background sessions")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument("--local-contracts", action="store_true", help="Only --version, --help, generated schema; safe on Mac")
    choice.add_argument("--guest", action="store_true", help="Enter an isolated network namespace then qualify installed guest")
    choice.add_argument("--inside-netns", help=argparse.SUPPRESS)
    parser.add_argument("--package", type=Path, default=Path("/opt/lecturn-tools/node_modules/lecturn"))
    args = parser.parse_args()
    os.umask(0o077)
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, interrupted)
    if args.guest or args.inside_netns:
        require(sys.platform == "linux" and os.getuid() == 1000 and os.geteuid() == 1000,
                "Guest qualification requires Linux, real/effective UID 1000; do not run as root")
    if args.guest:
        # No network fallback: inability to create a user+network namespace is a failure.
        ns = os.readlink("/proc/self/ns/net")
        argv = ["unshare", "--user", "--map-current-user", "--net", sys.executable,
                str(Path(__file__).resolve()), "--inside-netns", ns, "--package", str(args.package.resolve())]
        process = subprocess.Popen(argv, start_new_session=True)
        ACTIVE.add(process)
        print(f"Captured network-namespace runner PID {process.pid}", flush=True)
        try:
            process.wait(timeout=600)
            return process.returncode
        finally:
            # Let the nested runner finish its captured-child cleanup before force-kill.
            if process.poll() is None:
                os.killpg(process.pid, signal.SIGTERM)
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
            stop(process)
    if args.inside_netns:
        require(os.readlink("/proc/self/ns/net") != args.inside_netns, "Network namespace was not changed")
    root = Path(tempfile.mkdtemp(prefix="lecturn-offline-qualification-")).resolve()
    print(f"Evidence: {root}", flush=True)
    suite = Suite(root)
    try:
        if args.local_contracts:
            cli_checks(suite)
            suite.record("guest-runtime", "NOT_RUN", "Local help/schema only; no device execution")
        else:
            guest_checks(suite, args.package.resolve())
    finally:
        for process in list(ACTIVE):
            stop(process)
    return int(any(row["status"] == "FAIL" for row in suite.results))


if __name__ == "__main__":
    sys.exit(main())
