import { requireOptionalNativeModule } from "expo";

interface LecturnMarkdownTextSelectionNativeModule {
  readonly installCopySanitizer: (reactTag: number) => void;
}

const nativeModule = requireOptionalNativeModule<LecturnMarkdownTextSelectionNativeModule>(
  "LecturnMarkdownTextSelection",
);

export function installMarkdownCopySanitizer(reactTag: number): void {
  nativeModule?.installCopySanitizer(reactTag);
}
