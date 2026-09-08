import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each([
    "https://lecturn.cloudgatherer.net/legal",
    "https://lecturn.cloudgatherer.net/legal/",
    "https://lecturn.cloudgatherer.net/privacy-policy?source=app",
    "https://lecturn.cloudgatherer.net/terms-of-service#updates",
    "https://lecturn.cloudgatherer.net/security-policy",
  ])("allows a configured legal document: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(true);
  });

  it.each([
    "https://lecturn.cloudgatherer.net/download",
    "https://example.com/legal",
    "javascript:alert(1)",
    "not-a-url",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
