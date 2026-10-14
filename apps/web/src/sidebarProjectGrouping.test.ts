import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@lecturn/contracts";
import { deriveSidebarEnvironmentMetadata } from "./sidebarProjectGrouping";

const local = { environmentId: EnvironmentId.make("local"), environmentLabel: "This Mac" };
const remote = { environmentId: EnvironmentId.make("remote"), environmentLabel: "Build server" };
const sandbox = { environmentId: EnvironmentId.make("sandbox"), environmentLabel: "Linux sandbox" };
const metadata = (members: readonly (typeof local)[]) =>
  deriveSidebarEnvironmentMetadata({
    members,
    primaryEnvironmentId: local.environmentId,
    isDesktopLocalEnvironment: (id) => id === sandbox.environmentId,
  });
describe("physical sidebar environment presence", () => {
  it("splitting same-repository local and remote clones restores each physical marker", () => {
    expect(metadata([local, remote])).toEqual({
      environmentPresence: "mixed",
      allRemoteMembersAreWsl: false,
      allRemoteMembersAreDesktopLocal: false,
      remoteEnvironmentLabels: ["Build server"],
    });
    expect(metadata([local])).toEqual({
      environmentPresence: "local-only",
      allRemoteMembersAreWsl: false,
      allRemoteMembersAreDesktopLocal: false,
      remoteEnvironmentLabels: [],
    });
    expect(metadata([remote])).toEqual({
      environmentPresence: "remote-only",
      allRemoteMembersAreWsl: false,
      allRemoteMembersAreDesktopLocal: false,
      remoteEnvironmentLabels: ["Build server"],
    });
  });
  it("recomputes sandbox-only status after separating true remote and desktop-local checkouts", () => {
    expect(metadata([local, sandbox, remote]).allRemoteMembersAreDesktopLocal).toBe(false);
    expect(metadata([sandbox])).toEqual({
      environmentPresence: "remote-only",
      allRemoteMembersAreWsl: false,
      allRemoteMembersAreDesktopLocal: true,
      remoteEnvironmentLabels: ["Linux sandbox"],
    });
    expect(metadata([remote]).allRemoteMembersAreDesktopLocal).toBe(false);
  });
  it("keeps ordinary local groups simple and deduplicates multiple remote labels", () => {
    expect(metadata([local, local]).remoteEnvironmentLabels).toEqual([]);
    expect(metadata([remote, remote]).remoteEnvironmentLabels).toEqual(["Build server"]);
  });
  it("recomputes WSL presence when a mixed project group splits into physical rows", () => {
    const derive = (members: readonly (typeof local)[]) =>
      deriveSidebarEnvironmentMetadata({
        members,
        primaryEnvironmentId: local.environmentId,
        isDesktopLocalEnvironment: (id) => id === sandbox.environmentId,
        isWslEnvironment: (id) => id === sandbox.environmentId,
      });
    expect(derive([sandbox, remote]).allRemoteMembersAreWsl).toBe(false);
    expect(derive([sandbox]).allRemoteMembersAreWsl).toBe(true);
    expect(derive([local]).allRemoteMembersAreWsl).toBe(false);
    expect(derive([local, sandbox]).allRemoteMembersAreWsl).toBe(true);
  });
});
