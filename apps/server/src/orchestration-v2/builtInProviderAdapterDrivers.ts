import type { ProviderDriverKind } from "@lecturn/contracts";

import {
  AcpRegistryAdapterV2Driver,
  type AcpRegistryAdapterV2DriverEnv,
} from "@lecturn/provider-acp-registry/server";
import {
  ClaudeAdapterV2Driver,
  type ClaudeAdapterV2DriverEnv,
} from "./Adapters/ClaudeAdapterV2.ts";
import { CodexAdapterV2Driver, type CodexAdapterV2DriverEnv } from "./Adapters/CodexAdapterV2.ts";
import {
  CopilotAdapterV2Driver,
  type CopilotAdapterV2DriverEnv,
} from "./Adapters/CopilotAdapterV2.ts";
import {
  CursorAdapterV2Driver,
  type CursorAdapterV2DriverEnv,
} from "@lecturn/provider-cursor/server";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "@lecturn/provider-grok/server";
import {
  OpenCodeAdapterV2Driver,
  type OpenCodeAdapterV2DriverEnv,
} from "@lecturn/provider-opencode/server";
import { PiAdapterV2Driver, type PiAdapterV2DriverEnv } from "@lecturn/provider-pi/server";
import type { AnyProviderAdapterDriver } from "@lecturn/provider-core/server/adapterDriver";

export type BuiltInProviderAdapterDriversV2Env =
  | AcpRegistryAdapterV2DriverEnv
  | ClaudeAdapterV2DriverEnv
  | CodexAdapterV2DriverEnv
  | CopilotAdapterV2DriverEnv
  | CursorAdapterV2DriverEnv
  | GrokAdapterV2DriverEnv
  | OpenCodeAdapterV2DriverEnv
  | PiAdapterV2DriverEnv;

const BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2: ReadonlyArray<
  AnyProviderAdapterDriver<BuiltInProviderAdapterDriversV2Env>
> = [
  CodexAdapterV2Driver,
  ClaudeAdapterV2Driver,
  CursorAdapterV2Driver,
  OpenCodeAdapterV2Driver,
  GrokAdapterV2Driver,
  // Lecturn: GitHub Copilot CLI over ACP.
  CopilotAdapterV2Driver,
  PiAdapterV2Driver,
  AcpRegistryAdapterV2Driver,
];

export const BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2: ReadonlySet<ProviderDriverKind> = new Set(
  BUILT_IN_PROVIDER_ADAPTER_DRIVERS_V2.map((driver) => driver.driverKind),
);
