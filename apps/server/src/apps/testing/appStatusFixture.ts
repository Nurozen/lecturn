import { AppId, type AppEmbedOrigin, type AppGrantState, type AppStatus } from "@lecturn/contracts";

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export const makeAppStatus = (input: {
  readonly appId: string;
  readonly state: AppGrantState;
  readonly embedOrigins: ReadonlyArray<AppEmbedOrigin>;
}): AppStatus => ({
  appId: AppId.make(input.appId),
  name: input.appId,
  iconDataUrl: PNG_1PX,
  toolPrefix: "ex",
  refPrefixes: ["ex:"],
  openUrlTemplate: null,
  state: input.state,
  live: null,
  lastSeenAt: null,
  runtimeCeiling: null,
  headlessTools: null,
  gatedTools: [],
  embedOrigins: input.embedOrigins,
  pendingRequest: null,
});
