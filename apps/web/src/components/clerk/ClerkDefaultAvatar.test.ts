import { describe, expect, it } from "vite-plus/test";

import { defaultAvatarCss } from "./ClerkDefaultAvatar";

describe("Clerk generated avatar replacement", () => {
  it("does not override uploaded or provider photos, or unloaded users", () => {
    expect(defaultAvatarCss(null)).toBeNull();
    expect(
      defaultAvatarCss({ hasImage: true, imageUrl: "https://images.example/photo" }),
    ).toBeNull();
  });

  it("matches only the known generated image and its query-based size derivatives", () => {
    const css = defaultAvatarCss({ hasImage: false, imageUrl: "https://images.example/generated" });
    expect(css).toContain('img[src="https://images.example/generated"]');
    expect(css).toContain('img[src^="https://images.example/generated?"]');
    expect(css).not.toContain('img[src^="https://images.example/generated"]');
    expect(
      defaultAvatarCss({ hasImage: false, imageUrl: "https://images.example/generated?width=80" }),
    ).toContain('img[src^="https://images.example/generated?width=80&"]');
  });

  it("escapes CSS quotes and style delimiters instead of interpreting source text", () => {
    const css = defaultAvatarCss({
      hasImage: false,
      imageUrl: 'https://images.example/a"</style>\\',
    });
    expect(css).not.toContain("</style>");
    expect(css).toContain("\\22 ");
    expect(css).toContain("\\3c ");
    expect(css).toContain("\\5c ");
  });
});
