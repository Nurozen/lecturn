import type { StaveFeatureCommand, StaveFeatures, StaveOperation } from "@lecturn/contracts";

/** Flags used by Lecturn, including inherited global flags shown in nested help. */
export const STAVE_COMMAND_FLAGS = {
  "config show": [],
  "repos list": [],
  "space list": ["archived"],
  "space status": [],
  "saga list": [],
  "saga status": [],
  "memory providers": [],
  "memory list": [],
  setup: ["force"],
  "repos add": ["adopt", "dry-run"],
  "space init": ["kind", "spec"],
  "space create": [
    "kind",
    "spec",
    "edit",
    "reference",
    "memory",
    "saga",
    "after",
    "common",
    "include-weak",
    "no-learn",
    "dry-run",
  ],
  "space add": [
    "edit",
    "reference",
    "base",
    "branch",
    "no-fetch",
    "link-memory",
    "no-learn",
    "dry-run",
  ],
  "space remove": ["edit", "reference", "force", "dry-run"],
  "space sync": ["references-only"],
  "space retarget": ["repo", "base", "dry-run"],
  "space archive": ["force", "memory", "dry-run"],
  "space restore": ["from", "dry-run"],
  "space destroy": ["force", "memory", "dry-run"],
  "saga create": ["spec", "reference", "memory", "no-learn", "dry-run"],
  "saga add": ["after", "clear-after", "dry-run"],
  "saga remove": ["dry-run"],
  "saga sync": ["dry-run"],
  "saga archive": ["force", "memory", "dry-run"],
  "saga destroy": ["force", "memory", "dry-run"],
  "memory attach": ["provider", "use", "name", "edit", "link", "opt", "dry-run"],
  "memory detach": ["destroy", "keep", "force", "dry-run"],
} as const;
export type StaveFeatureVerb = keyof typeof STAVE_COMMAND_FLAGS;
export const STAVE_FEATURE_VERBS = Object.keys(STAVE_COMMAND_FLAGS) as StaveFeatureVerb[];
const OPERATION_COMMANDS = {
  setup: ["setup"],
  registerRepo: ["repos add"],
  createSpace: ["space create", "space list", "space status"],
  addRepo: ["space add"],
  removeRepo: ["space remove"],
  retarget: ["space retarget"],
  syncSpace: ["space sync"],
  archiveSpace: ["space archive", "space list"],
  restoreSpace: ["space restore", "space list"],
  destroySpace: ["space destroy", "space list"],
  memoryAttach: ["memory attach"],
  memoryDetach: ["memory detach"],
  createSaga: ["saga create", "saga list"],
  sagaAdd: ["saga add"],
  sagaRemove: ["saga remove"],
  sagaSync: ["saga sync"],
  sagaArchive: ["saga archive", "space list"],
  sagaDestroy: ["saga destroy", "space list"],
  removePartialSpace: ["saga remove", "space destroy", "space list"],
  lifecycleAction: [],
} satisfies Record<StaveOperation["kind"], ReadonlyArray<StaveFeatureVerb>>;

export const requiredFlags = (verb: StaveFeatureVerb): ReadonlyArray<string> => [
  "config",
  "json",
  ...STAVE_COMMAND_FLAGS[verb],
];
export function makeStaveFeatures(
  source: StaveFeatures["source"],
  commands: ReadonlyArray<StaveFeatureCommand>,
): StaveFeatures {
  const complete = (verb: StaveFeatureVerb) => {
    const command = commands.find((entry) => entry.verb === verb);
    return (
      command?.available === true &&
      requiredFlags(verb).every((flag) => command.flags.includes(flag))
    );
  };
  return {
    source,
    commands,
    unsupportedOperations: Object.entries(OPERATION_COMMANDS)
      .filter(([, verbs]) => !verbs.every(complete))
      .map(([kind]) => kind),
  };
}
export const bundledStaveFeatures = (): StaveFeatures =>
  makeStaveFeatures(
    "bundled",
    STAVE_FEATURE_VERBS.map((verb) => ({ verb, available: true, flags: requiredFlags(verb) })),
  );

/** Requires a matching Usage command, so a legacy CLI printing parent help cannot claim child support. */
export function parseStaveCommandHelp(verb: StaveFeatureVerb, output: string): StaveFeatureCommand {
  const escaped = verb.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll(" ", "\\s+");
  const available = new RegExp(
    `(?:^|\\n)\\s*(?:stave(?:\\.exe)?\\s+)${escaped}(?:\\s|$)`,
    "i",
  ).test(output);
  const flags = [
    ...new Set(
      Array.from(
        output.matchAll(/(?:^|[\s,])--([a-z][a-z0-9-]*)(?=[\s=,]|\[|$)/gm),
        (match) => match[1]!,
      ),
    ),
  ];
  return { verb, available, flags };
}

/** Returns unsupported flag names only; argv values never enter a diagnostic or analytics event. */
export function missingStaveFeatures(
  features: StaveFeatures,
  verb: string,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (verb === "version") return [];
  const command = features.commands.find((entry) => entry.verb === verb);
  if (!command?.available) return [verb];
  const flags = [
    "config",
    ...args.filter((arg) => arg.startsWith("--")).map((arg) => arg.slice(2).split("=", 1)[0]!),
  ];
  return [...new Set(flags)].filter((flag) => !command.flags.includes(flag));
}
