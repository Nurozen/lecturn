// @effect-diagnostics nodeBuiltinImport:off -- synthetic native boundary fixture only.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeV8 from "node:v8";
import { Effect } from "effect";
import { EnvironmentId } from "@lecturn/contracts";
import { ExtensionsSupervisor } from "../extensions/ExtensionsSupervisor.ts";
import type { ExtensionsRuntime } from "../extensions/ExtensionsRuntime.ts";
import { contextualBoundary } from "./ContextualSettings.ts";

export interface NativeFixtureMessage {
  ts: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
}

const variable = (value: number): Buffer => {
  const bytes: number[] = [];
  while (value >= 128) {
    bytes.push((value & 127) | 128);
    value >>>= 7;
  }
  return Buffer.from([...bytes, value]);
};
const field = (value: Buffer) => Buffer.concat([variable(value.length), value]);
const log = (payload: Buffer): Buffer => {
  if (payload.length >= 32761) throw new Error("Synthetic fixture exceeds one WAL block");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([Buffer.from([1]), payload])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(7);
  header.writeUInt32LE((((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0);
  header.writeUInt16LE(payload.length, 4);
  header[6] = 1;
  return Buffer.concat([header, payload]);
};

/** Fresh synthetic Chromium WAL; no installed Slack paths or credentials are consulted. */
export async function nativeContextualFixture(
  binary: string,
  messages: readonly NativeFixtureMessage[],
  host: { platform: NodeJS.Platform; architecture: string },
): Promise<{
  runtime: ExtensionsRuntime["Service"];
  replaceMessages: (messages: readonly NativeFixtureMessage[]) => Promise<void>;
  close: () => Promise<void>;
}> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "lecturn-contextual-native-")),
  );
  const profile = NodePath.join(root, "fixture");
  const database = NodePath.join(profile, "IndexedDB/https_app.slack.com_0.indexeddb.leveldb");
  let supervisor: ExtensionsSupervisor | undefined;
  try {
    await NodeFSP.mkdir(database, { recursive: true, mode: 0o700 });
    const replaceMessages = async (messages: readonly NativeFixtureMessage[]) => {
      const serialized = NodeV8.serialize({
        selfTeamIds: { teamId: "TTEST" },
        channels: { CTEST: { id: "CTEST", context_team_id: "TTEST", is_channel: true } },
        messages: {
          CTEST: Object.fromEntries(
            messages.map((message) => [
              message.ts,
              {
                type: "message",
                user: "UTEST",
                reply_count: 0,
                ...message,
              },
            ]),
          ),
        },
      });
      if (serialized[0] !== 255 || serialized[1] !== 15)
        throw new Error(
          "Synthetic native fixture requires a NodeV8 v15 serializer; never rewrite its header",
        );
      const key = Buffer.concat([
        Buffer.from([0, 1, 1, 1, 1]),
        variable(5),
        Buffer.from("redux", "utf16le").swap16(),
      ]);
      const version = Buffer.alloc(8);
      version.writeBigUInt64LE((16n << 32n) | 21n);
      const entries = [
        [Buffer.alloc(5), Buffer.from([5])],
        [Buffer.from([0, 0, 0, 0, 2]), version],
        [key, Buffer.concat([Buffer.from([1, 255, 21, 254]), Buffer.alloc(12), serialized])],
      ] as const;
      const batchHeader = Buffer.alloc(12);
      batchHeader.writeBigUInt64LE(1n);
      batchHeader.writeUInt32LE(entries.length, 8);
      const batch = Buffer.concat([
        batchHeader,
        ...entries.map(([key, value]) =>
          Buffer.concat([Buffer.from([1]), field(key), field(value)]),
        ),
      ]);
      const files = {
        CURRENT: Buffer.from("MANIFEST-000001\n"),
        "MANIFEST-000001": log(
          Buffer.concat([
            Buffer.from([1]),
            field(Buffer.from("idb_cmp1")),
            Buffer.from([2, 3, 4, 0]),
          ]),
        ),
        "000003.log": log(batch),
      };
      for (const [name, bytes] of Object.entries(files))
        await NodeFSP.writeFile(NodePath.join(database, name), bytes, { mode: 0o600 });
    };
    await replaceMessages(messages);
    supervisor = new ExtensionsSupervisor({
      platform: host.platform,
      architecture: host.architecture,
      bundledRoot: NodePath.join(root, "missing-bundle"),
      reviewBinary: {
        path: binary,
        sha256: NodeCrypto.createHash("sha256")
          .update(await NodeFSP.readFile(binary))
          .digest("hex"),
      },
      homeDir: NodePath.join(root, "home"),
      exportsDir: NodePath.join(root, "exports"),
      environmentId: "synthetic-env",
      hostName: "Synthetic native host",
      fixtureRoot: profile,
    });
    const owned = supervisor;
    await owned.start();
    return {
      runtime: {
        environmentId: EnvironmentId.make("synthetic-env"),
        hostName: "Synthetic native host",
        describe: Effect.tryPromise({ try: () => owned.start(), catch: contextualBoundary }),
        request: (operation, payload) =>
          Effect.tryPromise({
            try: (signal) => owned.request(operation, payload, signal),
            catch: contextualBoundary,
          }),
        readExport: (id) =>
          Effect.tryPromise({ try: () => owned.readExport(id), catch: contextualBoundary }),
      },
      replaceMessages,
      close: async () => {
        owned.close();
        await NodeFSP.rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    supervisor?.close();
    await NodeFSP.rm(root, { recursive: true, force: true });
    throw error;
  }
}
