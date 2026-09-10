import { useUser } from "@clerk/react";

import accountAvatar from "../../assets/lecturn-account-avatar.svg";

// Escape a quoted CSS value, including style-element delimiters. The URL comes
// from Clerk's user resource; no image-host or generated-avatar URL is assumed.
const cssString = (value: string) =>
  `"${value.replace(/["\\\n\r\f<>]/g, (character) => `\\${character.codePointAt(0)!.toString(16)} `)}"`;

/** Only replace the current account's generated placeholder. A real uploaded or
 * provider photo keeps its original pixels, including after an in-place upload.
 * Source selectors also cover Clerk's portaled account menu and profile editor. */
export function defaultAvatarCss(user: { hasImage: boolean; imageUrl: string } | null | undefined) {
  if (!user || user.hasImage !== false || !user.imageUrl) return null;
  const source = user.imageUrl;
  const transformedSource = `${source}${source.includes("?") ? "&" : "?"}`;
  return `
    img[src=${cssString(source)}], img[src^=${cssString(transformedSource)}] {
      content: url(${cssString(accountAvatar)});
      object-fit: cover;
      background: #102432;
      border-radius: 50%;
    }
  `;
}

export function ClerkDefaultAvatar() {
  const { user } = useUser();
  const css = defaultAvatarCss(user);
  return css ? <style>{css}</style> : null;
}
