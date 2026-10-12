// Runs only in a fresh qualification cwd/HOME. Resolve native deps from the installed package.
import * as NodeAssert from "node:assert/strict";
import * as NodeModule from "node:module";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const [kind, packageRoot] = process.argv.slice(2);
NodeAssert.ok(packageRoot, "Pass the installed Lecturn package root");
const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(packageRoot, "package.json"), "utf8"));
NodeAssert.equal(pkg.name, "lecturn");
NodeAssert.equal(pkg.version, "0.0.51-nightly.20261008.98");
const require = NodeModule.createRequire(
  NodePath.join(NodeFS.realpathSync(packageRoot), "package.json"),
);
const report = { kind, node: process.versions.node, package: packageRoot };
const unwrap = (result) => {
  NodeAssert.equal(result.ok, true, result.error);
  return result.value;
};

if (kind === "sqlite") {
  // This is the native API used by the packaged nodeSqliteClient, not a substitute DB.
  const { DatabaseSync } = require("node:sqlite");
  const path = NodePath.resolve("qualification.sqlite");
  let db = new DatabaseSync(path);
  try {
    db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE probes (id INTEGER PRIMARY KEY, value TEXT NOT NULL); BEGIN",
    );
    db.prepare("INSERT INTO probes(value) VALUES (?)").run("synthetic-committed");
    db.exec("COMMIT; BEGIN");
    db.prepare("INSERT INTO probes(value) VALUES (?)").run("synthetic-rolled-back");
    db.exec("ROLLBACK");
    const stmt = db.prepare("SELECT id, value FROM probes ORDER BY id");
    NodeAssert.deepEqual(
      stmt.columns().map((c) => c.name),
      ["id", "value"],
    );
    NodeAssert.deepEqual(
      stmt.all().map((r) => ({ ...r })),
      [{ id: 1, value: "synthetic-committed" }],
    );
  } finally {
    db.close();
  }
  db = new DatabaseSync(path, { readOnly: true });
  try {
    NodeAssert.equal(db.prepare("SELECT count(*) AS n FROM probes").get().n, 1);
  } finally {
    db.close();
  }
  report.transactionRollbackAndReopen = true;
} else if (kind === "search") {
  // fff-node exposes only its ESM import condition. Resolve its installed
  // package from Lecturn's dependency search paths, then load that public entry.
  const searchRoot = require.resolve
    .paths("@ff-labs/fff-node")
    .map((base) => NodePath.join(base, "@ff-labs/fff-node"))
    .find((base) => NodeFS.existsSync(NodePath.join(base, "package.json")));
  NodeAssert.ok(searchRoot, "Installed fff-node missing");
  const searchPackage = JSON.parse(
    NodeFS.readFileSync(NodePath.join(searchRoot, "package.json"), "utf8"),
  );
  report.resolved = NodePath.resolve(searchRoot, searchPackage.exports["."].import);
  const { FileFinder } = await import(NodeURL.pathToFileURL(report.resolved).href);
  NodeFS.writeFileSync("qualification-needle.txt", "synthetic_qualification_content_731\n");
  const finder = unwrap(
    FileFinder.create({
      basePath: process.cwd(),
      disableMmapCache: true,
      disableContentIndexing: false,
      aiMode: false,
      enableFsRootScanning: false,
      enableHomeDirScanning: false,
    }),
  );
  try {
    NodeAssert.equal(unwrap(await finder.waitForIndexReady(15000)), true);
    const files = unwrap(finder.fileSearch("qualification-needle", { pageSize: 10 }));
    NodeAssert.ok(files.items.some((f) => f.relativePath === "qualification-needle.txt"));
    const content = unwrap(
      finder.grep("synthetic_qualification_content_731", {
        mode: "plain",
        smartCase: false,
        maxMatchesPerFile: 10,
        pageSize: 10,
        timeBudgetMs: 1000,
      }),
    );
    NodeAssert.ok(
      content.items.some(
        (f) =>
          f.relativePath === "qualification-needle.txt" &&
          f.lineContent.includes("synthetic_qualification_content_731"),
      ),
    );
    report.pathAndContentSearch = true;
  } finally {
    finder.destroy();
  }
} else if (kind === "pty") {
  report.resolved = require.resolve("node-pty");
  const pty = require("node-pty");
  // Node itself is the terminal child: no shell profiles or untracked shell children.
  const child = pty.spawn(
    process.execPath,
    [
      "-e",
      `
    if (!process.stdout.isTTY) process.exit(2);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', () => {
      console.log('SIZE=' + process.stdout.columns + 'x' + process.stdout.rows);
      process.exit(process.stdout.columns === 103 && process.stdout.rows === 37 ? 0 : 3);
    });
    process.stdout.on('resize', () => console.log('RESIZED'));
    console.log('READY');
  `,
    ],
    { name: "xterm-256color", cols: 80, rows: 24, cwd: process.cwd(), env: process.env },
  );
  report.ptyPid = child.pid;
  NodeFS.appendFileSync(
    NodePath.resolve("..", "pty-process.jsonl"),
    JSON.stringify({ pid: child.pid, executable: process.execPath }) + "\n",
  );
  let exited = false;
  const kill = () => {
    if (!exited) child.kill("SIGKILL");
  };
  const terminate = () => {
    kill();
    process.exitCode = 143;
  };
  process.on("SIGTERM", terminate);
  process.on("SIGINT", terminate);
  let transcript = "",
    resized = false,
    inputSent = false;
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => {
        kill();
        fail(new Error("PTY timed out"));
      }, 8000);
      child.onData((data) => {
        transcript += data;
        if (!resized && transcript.includes("READY")) {
          resized = true;
          child.resize(103, 37);
        }
        if (!inputSent && transcript.includes("RESIZED")) {
          inputSent = true;
          child.write("check\r");
        }
      });
      child.onExit(({ exitCode, signal }) => {
        exited = true;
        clearTimeout(timer);
        if (exitCode === 0 && !signal && transcript.includes("SIZE=103x37")) done();
        else fail(new Error(`PTY failed: code=${exitCode} signal=${signal} output=${transcript}`));
      });
    });
    report.spawnResizeInputExit = true;
  } finally {
    kill();
    process.off("SIGTERM", terminate);
    process.off("SIGINT", terminate);
  }
} else {
  throw new Error("Unknown dependency test; expected sqlite, search, or pty");
}
console.log(JSON.stringify(report));
