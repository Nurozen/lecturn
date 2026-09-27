// @effect-diagnostics nodeBuiltinImport:off -- native executable identity and codesign boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { Schema } from "effect";

const Manifest = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  buildVersion: Schema.String.check(Schema.isNonEmpty()),
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  signerTeamId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
  platform: Schema.Literals(["darwin-arm64", "darwin-x64"]),
});
const decodeManifest = Schema.decodeUnknownSync(Schema.fromJsonString(Manifest), {
  onExcessProperty: "error",
});
const execute = NodeUtil.promisify(NodeChildProcess.execFile);

export interface ExtensionsBinaryOptions {
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
  /** Trusted application resource root; never populated from RPC or user settings. */
  readonly bundledRoot: string;
  /** Supplied only by the isolated review bootstrap, with a build-time pinned digest. */
  readonly reviewBinary?: { readonly path: string; readonly sha256: string };
}
export interface ResolvedExtensionsBinary {
  readonly path: string;
  readonly sha256: string;
  readonly buildVersion: string;
  readonly source: "bundled" | "review";
}

const checkedFile = async (path: string) => {
  if (!NodePath.isAbsolute(path)) throw new Error("Extensions helper path must be absolute.");
  const stat = await NodeFSP.lstat(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o022) !== 0 ||
    (stat.mode & 0o111) === 0 ||
    stat.size > 128 * 1024 * 1024
  )
    throw new Error("Extensions helper is not a trusted executable.");
  return stat;
};

/** Missing proprietary artifacts are a supported community-build capability state. */
export async function resolveExtensionsBinary(
  options: ExtensionsBinaryOptions,
): Promise<ResolvedExtensionsBinary | null> {
  if (options.reviewBinary) {
    const { path, sha256 } = options.reviewBinary;
    await checkedFile(path);
    if (
      !/^[a-f0-9]{64}$/.test(sha256) ||
      NodeCrypto.createHash("sha256")
        .update(await NodeFSP.readFile(path))
        .digest("hex") !== sha256
    )
      throw new Error("Extensions helper digest mismatch.");
    return { path, sha256, buildVersion: "review", source: "review" };
  }
  if (options.platform !== "darwin" || !["arm64", "x64"].includes(options.architecture))
    return null;
  const root = NodePath.join(options.bundledRoot, `${options.platform}-${options.architecture}`);
  const manifestPath = NodePath.join(root, "manifest.json");
  let manifestText: string;
  try {
    manifestText = await NodeFSP.readFile(manifestPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (Buffer.byteLength(manifestText) > 4096) throw new Error("Invalid extensions manifest.");
  const manifest = decodeManifest(manifestText);
  if (manifest.platform !== `${options.platform}-${options.architecture}`)
    throw new Error("Extensions helper architecture mismatch.");
  const path = NodePath.join(root, "lecturn-extensions-helper");
  const before = await checkedFile(path);
  if (NodePath.dirname(await NodeFSP.realpath(path)) !== (await NodeFSP.realpath(root)))
    throw new Error("Extensions helper escaped its bundle.");
  const digest = NodeCrypto.createHash("sha256")
    .update(await NodeFSP.readFile(path))
    .digest("hex");
  if (digest !== manifest.sha256) throw new Error("Extensions helper digest mismatch.");
  await execute("/usr/bin/codesign", ["--verify", "--strict", path], {
    timeout: 10000,
    maxBuffer: 16384,
  });
  const signature = await execute("/usr/bin/codesign", ["-dv", "--verbose=4", path], {
    timeout: 10000,
    maxBuffer: 16384,
  });
  if (!signature.stderr.split("\n").includes(`TeamIdentifier=${manifest.signerTeamId}`))
    throw new Error("Extensions helper signer mismatch.");
  const after = await checkedFile(path);
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs)
    throw new Error("Extensions helper changed during verification.");
  return { path, sha256: digest, buildVersion: manifest.buildVersion, source: "bundled" };
}
