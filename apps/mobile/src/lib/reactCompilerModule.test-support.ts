// @effect-diagnostics nodeBuiltinImport:off - compiles real source files on disk for tests.
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

const mobileRoot = NodePath.resolve(__dirname, "../..");
const requireFromMobile = NodeModule.createRequire(NodePath.join(mobileRoot, "package.json"));

export interface CompiledMobileModule {
  readonly exports: Record<string, unknown>;
  /** React Compiler logger event kinds for the file, e.g. "CompileSuccess". */
  readonly compilerEvents: readonly string[];
}

/**
 * Loads a mobile source file (relative to apps/mobile) as Metro's Android release transform
 * emits it, React Compiler on. Imports come from `modules`; an unlisted one throws. Babel
 * helpers are inlined: @babel/runtime only resolves via pnpm's NODE_PATH shim, which CI's
 * global vp lacks. `expose` hands out top-level bindings the module does not export.
 */
export function loadCompiledMobileModule(input: {
  readonly file: string;
  readonly modules: Readonly<Record<string, unknown>>;
  readonly expose?: readonly string[];
  /** Metro inlines `Platform.OS`, so a stubbed Platform cannot pick the other platform's path. */
  readonly platform?: "android" | "ios";
}): CompiledMobileModule {
  const babel: {
    transformFileSync: (file: string, options: Record<string, unknown>) => { code: string };
  } = requireFromMobile("@babel/core");
  const compilerEvents: string[] = [];
  const babelConfig = requireFromMobile("./babel.config.js")({ cache: () => {} });
  const presets = babelConfig.presets.map(([name, options]: [string, object]) =>
    name === "babel-preset-expo"
      ? [
          requireFromMobile.resolve(name),
          {
            ...options,
            enableBabelRuntime: false,
            "react-compiler": {
              logger: {
                logEvent: (_: string, event: { kind: string }) => compilerEvents.push(event.kind),
              },
            },
          },
        ]
      : [name, options],
  );
  const file = NodePath.join(mobileRoot, input.file);
  const { code } = babel.transformFileSync(file, {
    babelrc: false,
    configFile: false,
    cwd: mobileRoot,
    presets,
    caller: {
      name: "metro",
      bundler: "metro",
      platform: input.platform ?? "android",
      isDev: false,
      isServer: false,
      isNodeModule: false,
      supportsStaticESM: false,
      supportsReactCompiler: true,
    },
  });

  const module = { exports: {} as Record<string, unknown> };
  const requireModule = (specifier: string) => {
    if (specifier in input.modules) return input.modules[specifier];
    throw new Error(`${input.file} imports an unstubbed module: ${specifier}`);
  };
  const exposed = (input.expose ?? [])
    .map((name) => `module.exports.${name} = ${name};`)
    .join("\n");
  NodeVM.runInThisContext(`(function (require, module, exports) {${code}\n${exposed}\n})`, {
    filename: file,
  })(requireModule, module, module.exports);
  return { exports: module.exports, compilerEvents };
}
