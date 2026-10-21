import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["lecturn", "lecturn-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each(["https://lecturn.cloudgatherer.net", "https://nightly.lecturn.cloudgatherer.net"])(
    "returns to the hosted client at %s",
    (origin) => {
      expect(providerAuthReturnUrl(`${origin}/welcome?code=secret#agents:machine-id`)).toBe(
        `${origin}/welcome#agents:machine-id`,
      );
    },
  );
  it.each([
    "lecturn://attacker/welcome",
    "lecturn://app:123/welcome",
    "lecturn://app/auth/callback",
    "lecturn://user@ app/welcome",
    "lecturn://app/welcome/../evil",
    "https://attacker.example/welcome",
    "https://lecturn.cloudgatherer.net.attacker.example/welcome",
    "file:///welcome",
    "javascript:alert(1)",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
