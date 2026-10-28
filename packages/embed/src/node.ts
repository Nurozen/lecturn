export { connect, USER_SERVER_WATCH_INTERVAL_MS } from "./node/connect.ts";
export type {
  ConnectOptions,
  HostContextTarget,
  LecturnConnection,
  PendingLecturnConnection,
} from "./node/connect.ts";
export { LIVE_LEASE_HEARTBEAT_MS, LIVE_LEASE_TTL_SECONDS } from "./node/liveLease.ts";
export type { LiveTools } from "./node/liveLease.ts";
export { SidecarError } from "./node/sidecar.ts";
export type { SidecarOptions } from "./node/sidecar.ts";
export type {
  ConnectionEvent,
  ConnectionMode,
  ConnectionModeEvent,
  ConnectionPairing,
  ConnectionStatus,
  ConnectionStatusEvent,
  EmbedConnectionSource,
  EmbedTarget,
  EmbedTargetSource,
} from "./target.ts";
