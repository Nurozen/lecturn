import "vite-plus/test/config";
import { defineConfig } from "vite-plus";
import * as NodeURL from "node:url";

const DOM_TEST_ENVIRONMENT_ALLOWLIST: Array<string> = [];

const TEST_EXCLUDE = [
  "**/.repos/**",
  "**/.lecturn/**",
  "**/node_modules/**",
  "**/dist/**",
  "**/dist-electron/**",
  "**/.{idea,git,cache,output,temp}/**",
];

// Directories whose tests belong to a package's own test config. desktop also
// owns the kde-snap-shot tests through its `include`.
const TEST_CONFIG_PACKAGES = [
  "apps/desktop",
  "apps/mobile",
  "apps/server",
  "apps/web",
  "packages/client-runtime",
];

// `vp test run <file>` from the repo root hands each file to its package's
// config. Packages that borrow this config (`--config ../../vite.config.ts`) run
// from their own directory, as CI does, so they keep one plain project.
const isRepoRootTestRun = process.cwd() === import.meta.dirname;

const RESTRICTED_IMPORT_PATHS = [
  {
    name: "@lecturn/client-runtime",
    message:
      "Import from an explicit @lecturn/client-runtime/* subpath. The package has no root export.",
  },
  {
    name: "@pierre/diffs/react",
    importNames: ["CodeView"],
    message: "Use StyledDiffCodeView so web diff surfaces share styling and virtualized geometry.",
  },
];

const RESTRICTED_UI_VARIANT_PATTERNS = [
  {
    group: ["**/components/ui/*", "**/ui/*", "./ui/*"],
    importNames: ["buttonVariants", "toggleVariants", "badgeVariants", "selectTriggerVariants"],
    message:
      "Render the components/ui export instead of borrowing its class recipe (render={<Button …/>}, SelectButton, ToggleGroup).",
  },
];

const RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS = {
  name: "lucide-react",
  importNames: [
    "GitMerge",
    "GitMergeIcon",
    "GitPullRequest",
    "GitPullRequestIcon",
    "GitPullRequestArrow",
    "GitPullRequestArrowIcon",
    "GitPullRequestClosed",
    "GitPullRequestClosedIcon",
    "GitPullRequestDraft",
    "GitPullRequestDraftIcon",
    "GitPullRequestCreate",
    "GitPullRequestCreateIcon",
    "GitPullRequestCreateArrow",
    "GitPullRequestCreateArrowIcon",
  ],
  message:
    "Pick a glyph by meaning from PullRequestGlyph in apps/web/src/components/pullRequest/pullRequestIcons.tsx so every surface draws the same pull request the same way.",
};

export default defineConfig({
  resolve: {
    alias: {
      "~": NodeURL.fileURLToPath(new URL("./apps/web/src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    exclude: TEST_EXCLUDE,
    hookTimeout: 60_000,
    testTimeout: 60_000,
    allowOnly: !process.env.CI,
    // Flaky tests are fixed, not retried.
    retry: 0,
    fakeTimers: {
      toFake: [
        "setTimeout",
        "clearTimeout",
        "setInterval",
        "clearInterval",
        "setImmediate",
        "clearImmediate",
        "Date",
        "performance",
        "requestAnimationFrame",
        "cancelAnimationFrame",
        "requestIdleCallback",
        "cancelIdleCallback",
      ],
    },
    setupFiles: [
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/longTempDir.ts", import.meta.url),
      ),
      NodeURL.fileURLToPath(
        new URL("./packages/shared/src/testing/providerEnv.ts", import.meta.url),
      ),
    ],
    ...(isRepoRootTestRun
      ? {
          projects: [
            ...TEST_CONFIG_PACKAGES,
            {
              extends: true,
              test: {
                name: "root",
                exclude: [
                  ...TEST_EXCLUDE,
                  ...TEST_CONFIG_PACKAGES.map((dir) => `${dir}/**`),
                  "native/kde-snap-shot/**",
                ],
              },
            },
          ],
        }
      : {}),
  },
  staged: {
    "*": "vp fmt --no-error-on-unmatched-pattern",
  },
  fmt: {
    ignorePatterns: [
      ".repos/**",
      // Macroscope's glob-per-line ignore grammar, not Markdown: formatting
      // it rewrites `*` as `_` and joins lines.
      ".macroscope/ignore.md",
      ".alchemy",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
      // Vendored and generated C.
      "apps/mobile/modules/lecturn-highlights/Vendor/**",
      "apps/mobile/modules/lecturn-highlights/cpp/generated/**",
      "*.icon/**",
    ],
    sortPackageJson: {},
    overrides: [
      {
        files: [".devcontainer/devcontainer.json"],
        options: {
          trailingComma: "none",
        },
      },
    ],
  },
  lint: {
    ignorePatterns: [
      ".repos",
      ".repos/**",
      "dist",
      "dist-electron",
      "node_modules",
      "pnpm-lock.yaml",
      "*.tsbuildinfo",
      "**/routeTree.gen.ts",
      "**/*.graphql.ts",
      "packages/source-control-github/schema/**",
      "apps/server/schema/**",
      "apps/mobile/android/**",
      "apps/mobile/ios/**",
      "apps/mobile/uniwind-types.d.ts",
    ],
    plugins: ["eslint", "oxc", "react", "unicorn", "typescript"],
    jsPlugins: ["./oxlint-plugin-lecturn/index.ts", "@shadcn/lint"],
    settings: {
      shadcn: { ui: "~/components/ui" },
    },
    categories: {
      correctness: "warn",
      suspicious: "warn",
      perf: "warn",
    },
    rules: {
      "unicorn/no-array-sort": "off",
      "unicorn/consistent-function-scoping": "off",
      "oxc/no-map-spread": "off",
      "react-in-jsx-scope": "off",
      "react-hooks/exhaustive-deps": "off",
      "eslint/no-shadow": "off",
      "eslint/no-await-in-loop": "off",
      "eslint/no-underscore-dangle": "off",
      "typescript/consistent-return": "off",
      "typescript/no-base-to-string": "off",
      "typescript/no-duplicate-type-constituents": "off",
      "typescript/no-floating-promises": "off",
      "typescript/no-implied-eval": "off",
      "typescript/no-meaningless-void-operator": "off",
      "typescript/no-redundant-type-constituents": "off",
      "typescript/no-unnecessary-boolean-literal-compare": "off",
      "typescript/no-unnecessary-type-conversion": "off",
      "typescript/no-unnecessary-type-arguments": "off",
      "typescript/no-unnecessary-type-assertion": "off",
      "typescript/no-unnecessary-type-parameters": "off",
      "typescript/no-unsafe-type-assertion": "off",
      "typescript/await-thenable": "off",
      "typescript/require-array-sort-compare": "off",
      "typescript/restrict-template-expressions": "off",
      "typescript/unbound-method": "off",
      "eslint/no-restricted-imports": [
        "error",
        { paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS] },
      ],
      "lecturn/no-global-process-runtime": "error",
      "lecturn/no-inline-schema-compile": "warn",
      "lecturn/no-low-value-comments": "error",
      "lecturn/no-manual-effect-runtime-in-tests": "error",
      "lecturn/no-native-title-tooltip": "error",
      // Test files only (the rule checks the filename).
      "lecturn/no-polling-loop-in-tests": "error",
      "lecturn/no-raw-mcp-registration": "error",
      "lecturn/no-real-time-wait-in-tests": "error",
      "lecturn/no-test-in-loop": "error",
      "lecturn/no-test-timeout-or-unreasoned-skip": "error",
      "lecturn/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }],
      "lecturn/no-unscoped-has": "error",
      "lecturn/no-wall-clock-in-tests": "error",
      "lecturn/namespace-node-imports": "error",
      "lecturn/prefer-catch-tags": "error",
      "lecturn/prefer-effect-fn": "error",
      "lecturn/require-centered-scroll-gutter": "error",
      "lecturn/require-suppression-reason": "error",
    },
    overrides: [
      {
        files: [
          "**/*.{test,spec,testkit}.{ts,tsx}",
          "**/{test,tests,testkit,testing,fixtures,integration}/**",
          "packages/provider-testing/**",
        ],
        rules: { "lecturn/prefer-effect-fn": "off" },
      },
      {
        files: ["apps/web/**/*.test.{ts,tsx}"],
        rules: { "lecturn/require-disposable-render": "error" },
      },
      {
        files: ["apps/web/src/**/*.browser.test.{ts,tsx}"],
        rules: { "lecturn/no-frame-waits-in-browser-tests": "error" },
      },
      {
        // Burn-down list: these files still have polling loops, so they stay at "warn".
        // Remove a file when you convert its loops. New polling loops in all other
        // test files fail lint. Do not add new files to this list.
        files: [
          "apps/mobile/src/features/agent-awareness/remoteRegistration.test.ts",
          "apps/server/src/background/HostPowerMonitor.test.ts",
          "apps/server/src/orchestration-v2/Adapters/AcpAdapterV2.test.ts",
          "apps/server/src/orchestration-v2/FoundationPersistence.test.ts",
          "apps/server/src/project/ProjectEnrichmentService.test.ts",
          "apps/server/src/project/ProjectService.test.ts",
          "apps/server/src/scheduledTasks/ScheduledTaskService.webhook.test.ts",
          "apps/server/src/usage/UsageService.test.ts",
          "packages/client-runtime/src/connection/supervisor.test.ts",
          "packages/client-runtime/src/rpc/client.test.ts",
          "packages/client-runtime/src/rpc/session.test.ts",
          "packages/client-runtime/src/state/shell-sync.test.ts",
          "packages/client-runtime/src/state/threads-sync.test.ts",
          "packages/shared/src/atomicWrite.test.ts",
        ],
        rules: { "lecturn/no-polling-loop-in-tests": "warn" },
      },
      {
        files: ["apps/**/src/**", "packages/**/src/**"],
        excludeFiles: DOM_TEST_ENVIRONMENT_ALLOWLIST,
        rules: { "lecturn/no-dom-test-environment": "error" },
      },
      {
        files: ["packages/client-runtime/src/state/**", "apps/{web,mobile,desktop}/src/**"],
        rules: { "lecturn/no-rpc-permission-bypass": ["error", { allowRawClientAccess: false }] },
      },
      {
        files: [
          "packages/client-runtime/src/state/runtime.ts",
          "packages/client-runtime/src/state/vcsAction.ts",
        ],
        rules: {
          "lecturn/no-rpc-permission-bypass": [
            "error",
            { allowGuardInstallation: true, allowRawClientAccess: false },
          ],
        },
      },
      {
        files: [
          "apps/web/src/components/settings/AuthorizedClientsSettings.tsx",
          "apps/web/src/components/settings/ConnectionsSettings.tsx",
          "apps/mobile/src/features/updates/app-updates.ts",
          "apps/web/src/components/device/DevicePhoneViewport.tsx",
          "apps/web/src/components/device/DeviceDuoViewport.tsx",
        ],
        rules: { "lecturn/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        // Clerk's multi-account `clerk.client` sessions and the Android chat widget publisher.
        files: [
          "apps/web/src/cloud/{accountAppearance,accountTokens,withActiveAccount}.ts",
          "apps/web/src/cloud/managedAuth.tsx",
          "apps/web/src/components/clerk/useConnectSignOut.{logic.ts,tsx}",
          "apps/web/src/hooks/useAndroidChatBridge.ts",
          "apps/mobile/src/features/cloud/{accountTokenReaders,mobileAccountSignOut}.ts",
          "apps/mobile/src/features/cloud/MultiAccountCloudAuthBridge.tsx",
          "apps/mobile/src/features/settings/mobileAccountProfile.logic.ts",
        ],
        rules: { "lecturn/no-rpc-permission-bypass": ["error", { allowRawClientAccess: true }] },
      },
      {
        files: ["packages/client-runtime/src/connection/outdatedHostUpdate.ts"],
        rules: { "lecturn/no-rpc-permission-bypass": "off" },
      },
      {
        files: [
          "packages/client-runtime/src/rpc/**",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "lecturn/no-rpc-permission-bypass": "off" },
      },
      {
        files: ["packages/shared/src/HostProcess.ts"],
        rules: { "lecturn/no-global-process-runtime": "off" },
      },
      {
        files: ["apps/server/src/mcp/McpHttpServer.ts"],
        rules: { "lecturn/no-raw-mcp-registration": "off" },
      },
      {
        // App tools are per-thread and dynamic, so they bypass the static McpToolAccess
        // declarations; AppToolkit gates each call by the app grant and runtime mode instead.
        files: ["apps/server/src/mcp/toolkits/app/**"],
        rules: { "lecturn/no-raw-mcp-registration": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: RESTRICTED_UI_VARIANT_PATTERNS,
            },
          ],
        },
      },
      {
        files: ["apps/web/src/components/pullRequest/pullRequestIcons.tsx"],
        rules: { "eslint/no-restricted-imports": ["error", { paths: RESTRICTED_IMPORT_PATHS }] },
      },
      {
        // The server and every client load a forge's shared definition, so a UI runtime
        // imported there would break the server; client-only forge code goes in `src/client/`.
        files: ["packages/source-control-*/src/shared/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: [
                {
                  group: [
                    "react",
                    "react/*",
                    "react-*",
                    "expo",
                    "expo-*",
                    "lucide-react",
                    "@lecturn/client-runtime",
                    "@lecturn/client-runtime/*",
                    "../client/*",
                    "../server/*",
                    "../../client/*",
                    "../../server/*",
                    "../../../client/*",
                    "../../../server/*",
                    "@lecturn/source-control-*/client/*",
                    "@lecturn/source-control-*/server/*",
                  ],
                  message:
                    "Shared forge definitions load on the server and every client; keep UI and server code out.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/server/src/**", "packages/source-control-*/src/server/**"],
        rules: {
          "eslint/no-restricted-imports": [
            "error",
            {
              paths: [...RESTRICTED_IMPORT_PATHS, RESTRICTED_PULL_REQUEST_GLYPH_IMPORTS],
              patterns: [
                {
                  group: [
                    "@lecturn/source-control-*/client/*",
                    "../client/*",
                    "../../client/*",
                    "../../../client/*",
                  ],
                  message:
                    "A forge's client entry is UI-only; the server reads its `shared/definition`.",
                },
              ],
            },
          ],
        },
      },
      {
        files: ["apps/mobile/src/**"],
        rules: { "lecturn/no-mobile-uniwind-theme-escape-hatches": "error" },
      },
      {
        files: ["apps/mobile/src/**"],
        excludeFiles: [
          "apps/mobile/src/components/ui/AppSymbol.tsx",
          "apps/mobile/src/components/ui/AppSymbol.ios.tsx",
          "apps/mobile/src/features/pull-requests/pullRequestGlyphs.ts",
        ],
        rules: { "lecturn/no-mobile-pull-request-glyph-literals": "error" },
      },
      {
        // React commits state set in a raw ResizeObserver callback after the paint, so derived
        // layout lands a frame late. observeResize flushes every observed resize in one render.
        files: ["apps/web/src/**"],
        excludeFiles: [
          "apps/web/src/lib/observeResize.ts",
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
        ],
        rules: { "lecturn/no-raw-resize-observer": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-unknown-classes": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "lecturn/no-outset-state-indicators": "error" },
      },
      {
        files: ["apps/*/src/**", "packages/*/src/**"],
        excludeFiles: [
          "**/*.{test,spec}.{ts,tsx,js,jsx,mts,cts,mjs,cjs}",
          "**/testkit/**",
          "**/_generated/**",
          // Real user quotes stay verbatim.
          "apps/marketing/src/lib/tweets.ts",
        ],
        rules: { "lecturn/no-em-dash-copy": "error" },
      },
      {
        files: ["apps/web/src/**"],
        rules: { "shadcn/no-raw-colors": "error" },
      },
      {
        // Third-party marks (brand logos, the macOS permission panes, Codex's Computer Use
        // mark) must keep their exact colors, so the files that hold them are exempt.
        files: ["apps/web/src/components/Icons.tsx", "apps/web/src/components/JetBrainsIcons.tsx"],
        rules: { "shadcn/no-raw-colors": "off" },
      },
      {
        files: ["apps/web/src/**"],
        excludeFiles: ["apps/web/src/components/ui/**"],
        rules: {
          "shadcn/require-static-classes": "error",
          "shadcn/no-arbitrary-values": [
            "error",
            {
              allow: [
                "layout",
                "transition",
                "rounded-[inherit]",
                "gap-[0.33em]",
                "px-[0.5em]",
                "rounded-[0.5em]",
                "text-[0.86em]",
                "rounded-[25%]",
                "text-[length:80cqh]",
                "bg-[Highlight]",
                "fill-[#26251E]",
                "fill-[#EDECEC]",
                "fill-[#0F0F0F]",
                "fill-[#F5F5F5]",
                "fill-[#d97757]",
                "text-[#d97757]",
              ],
            },
          ],
          "shadcn/no-restyle": [
            "error",
            {
              allow: ["layout"],
              contracts: [
                {
                  // CollapsibleTrigger is a bare button with no styled counterpart
                  // (a disclosure row is not a Button), so its className is the API.
                  // Every other trigger has one: style them with render={<Button …/>}.
                  pattern: "^CollapsibleTrigger$",
                  allow: ["layout", "color", "typography", "spacing", "shape", "effects", "motion"],
                },
              ],
            },
          ],
        },
      },
      {
        // Every web file must compile under the React Compiler. Its bailout rules are errors here,
        // and manual memoization is redundant. No upstream rule bans useMemo/useCallback, hence
        // lecturn/no-manual-memo.
        files: ["apps/web/src/**/*.{ts,tsx}"],
        rules: {
          "react/exhaustive-effect-dependencies": "error",
          "react/globals": "error",
          "react/hooks": "error",
          "react/immutability": "error",
          // The compiler memoizes context values; this rule would ask for useMemo.
          "react/jsx-no-constructed-context-values": "off",
          "react/memo-dependencies": "error",
          "react/preserve-manual-memoization": "error",
          // oxlint 1.88 treats `new Date()` as impure (oxc#26894) and also flags it inside event
          // handlers (oxc#27309). The compiler we ship (oxc-transform-react) still compiles
          // those files, and reactCompilerCoverage.test.ts fails on real bailouts.
          "react/purity": "warn",
          "react/refs": "error",
          "react/set-state-in-effect": "error",
          "react/set-state-in-render": "error",
          "react/static-components": "error",
          "react/unsupported-syntax": "error",
          "lecturn/no-manual-memo": "error",
        },
      },
      {
        // The sign-in masthead is brand artwork: fixed gradients, not theme surfaces.
        files: ["apps/web/src/components/auth/AuthSurfaceShell.tsx"],
        rules: { "shadcn/no-arbitrary-values": "off" },
      },
      {
        // Shared client code must not call APIs missing from Hermes. Our ESNext
        // TypeScript target accepts them even when they would crash mobile at launch.
        // Tests run on Node and are exempt.
        files: [
          "apps/mobile/src/**",
          "packages/client-runtime/src/**",
          "packages/contracts/src/**",
          "packages/shared/src/**",
        ],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "lecturn/no-hermes-unsupported-apis": "error" },
      },
      {
        // Mobile is ratcheting toward full React Compiler coverage
        // (apps/mobile/src/reactCompilerCoverage.test.ts). Directives would hide bailouts from it;
        // the manual memo hooks go once the allowlist there is empty.
        files: ["apps/mobile/src/**/*.{ts,tsx}"],
        rules: { "lecturn/no-manual-memo": ["error", { allowMemoHooks: true }] },
      },
      {
        // The compiler only compiles a use* function that calls a hook; one that calls none is
        // silently left as a plain function, so whatever it returns loses its caching.
        files: ["apps/web/src/**/*.{ts,tsx}", "apps/mobile/src/**/*.{ts,tsx}"],
        excludeFiles: ["**/*.test.ts", "**/*.test.tsx"],
        rules: { "lecturn/no-hookless-use-function": "error" },
      },
      {
        files: [
          // React Native gradient strings require resolved palette colors.
          "apps/mobile/src/components/GlassCard.tsx",
          "apps/mobile/src/components/GlassSurface.tsx",
          // Shared resolved colors for native glass, SVG strokes, and gradients.
          "apps/mobile/src/lib/useGlassPalette.ts",
          "apps/mobile/src/features/archive/ArchivedThreadsScreen.tsx",
          "apps/mobile/src/features/connection/ConnectionsNewRouteScreen.tsx",
          "apps/mobile/src/features/files/FileMarkdownPreview.tsx",
          "apps/mobile/src/features/files/SourceFileSurface.tsx",
          "apps/mobile/src/features/files/AttachmentFileScreen.tsx",
          "apps/mobile/src/features/files/ThreadFilesRouteScreen.tsx",
          "apps/mobile/src/features/files/thread-file-navigator-pane.tsx",
          "apps/mobile/src/features/home/HomeHeader.tsx",
          "apps/mobile/src/features/review/ReviewSheet.tsx",
          "apps/mobile/src/features/review/useNativeReviewDiffBridge.ts",
          "apps/mobile/src/features/settings/SettingsEnvironmentsRouteScreen.tsx",
          "apps/mobile/src/features/threads/GitActionProgressOverlay.tsx",
          "apps/mobile/src/features/threads/NewTaskDraftScreen.tsx",
          "apps/mobile/src/features/threads/ThreadComposer.tsx",
          "apps/mobile/src/features/threads/ThreadFeed.tsx",
          "apps/mobile/src/features/settings/appearance/components/FontSizeSliderRow.tsx",
          "apps/mobile/src/features/threads/NewTaskContextPickerScreens.tsx",
          "apps/mobile/src/features/threads/ThreadQueueControl.tsx",
          "apps/mobile/src/features/review/ReviewCommentCard.tsx",
          "apps/mobile/src/features/threads/ThreadSettingsSheet.tsx",
          "apps/mobile/src/features/threads/thread-list-items.tsx",
          "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
          "apps/mobile/src/lib/useMobileNavigationTheme.ts",
          "apps/mobile/src/native/LecturnComposerEditor.ios.tsx",
          "apps/mobile/src/native/LecturnComposerEditor.native.tsx",
          "apps/mobile/src/native/SelectableMarkdownText.tsx",
          "apps/mobile/src/native/useEnrichedLinkVariants.ts",
        ],
        rules: {
          "lecturn/no-mobile-uniwind-theme-escape-hatches": ["error", { allowUniwindTheme: true }],
        },
      },
    ],
    options: {
      reportUnusedDisableDirectives: "error",
      typeAware: false,
      typeCheck: false,
    },
  },
});
