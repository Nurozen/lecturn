// Dev-only Squire lab, rendered by main.tsx beside it and never by the app. Fixtures other
// than "lab" exist for apps/web/scripts/squire-b4-capture.ts: each one renders
// only what a capture needs, so no other animation can paint during a trace or a recording.
import type { SquireIndicatorStateName } from "@lecturn/client-runtime/state/squireIndicator";
import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";

import { SquireCompanion, type SquireCompanionHandle } from "~/components/squire/SquireCompanion";
import { SquireIndicator } from "~/components/squire/SquireIndicator";
import { SquireMark } from "~/components/squire/SquireMark";
import {
  COMPANION_GESTURES,
  COMPANION_STATES,
  EMBLEM_CHOICES,
  RIG_CHOICES,
  type CompanionDebugStateBase,
  type CompanionElement,
  type CompanionState,
  type GestureResult,
  type SquireCompanion as SquireCompanionChoice,
} from "~/components/squire/companion/types";

const INDICATOR_STATES = [
  "idle",
  "working",
  "waiting",
  "needs_provider",
] as const satisfies readonly SquireIndicatorStateName[];
const SIDEBAR_SIZE = 26;
const ENLARGED_SIZE = 96;
const PANEL = { width: 340, height: 500 } as const;

export type LabIndicatorForm = "portrait" | "lead" | "mark";

export interface LabIndicator {
  readonly id: string;
  readonly form: LabIndicatorForm;
  readonly appearance: SquireCompanionChoice["appearance"];
  readonly hood: SquireCompanionChoice["hood"];
  readonly palette: SquireCompanionChoice["palette"];
  readonly state: SquireIndicatorStateName;
  readonly size: number;
  /** Placed far below the viewport, for the offscreen pause check. */
  readonly offscreen: boolean;
}

export interface LabStill {
  readonly id: string;
  readonly companion: SquireCompanionChoice;
  readonly state: CompanionState;
  readonly crest: boolean;
}

export type SquireLabFixture =
  | { readonly kind: "lab" }
  | {
      readonly kind: "stage";
      readonly companion: SquireCompanionChoice;
      readonly state: CompanionState;
      readonly crest: boolean;
    }
  | { readonly kind: "indicators"; readonly items: readonly LabIndicator[] }
  | { readonly kind: "stills"; readonly items: readonly LabStill[]; readonly columns: number };

const DEFAULT_COMPANION: SquireCompanionChoice = {
  presence: "figure",
  appearance: "female",
  hood: "down",
  equipment: "helmet",
  palette: "brass",
  frame: "orbit",
  weight: "regular",
  glow: "soft",
  motion: "subtle",
};

function pick<T extends string>(
  value: string | null | undefined,
  choices: readonly T[],
  fallback: T,
): T {
  return choices.find((choice) => choice === value) ?? fallback;
}

function companionFrom(read: (key: string) => string | null): SquireCompanionChoice {
  return {
    presence: pick(read("presence"), ["figure", "emblem"], DEFAULT_COMPANION.presence),
    appearance: pick(read("appearance"), RIG_CHOICES.appearance, DEFAULT_COMPANION.appearance),
    hood: pick(read("hood"), RIG_CHOICES.hood, DEFAULT_COMPANION.hood),
    equipment: pick(read("equipment"), RIG_CHOICES.equipment, DEFAULT_COMPANION.equipment),
    palette: pick(read("palette"), RIG_CHOICES.palette, DEFAULT_COMPANION.palette),
    frame: pick(read("frame"), EMBLEM_CHOICES.frame, DEFAULT_COMPANION.frame),
    weight: pick(read("weight"), EMBLEM_CHOICES.weight, DEFAULT_COMPANION.weight),
    glow: pick(read("glow"), EMBLEM_CHOICES.glow, DEFAULT_COMPANION.glow),
    motion: pick(read("motion"), RIG_CHOICES.motion, DEFAULT_COMPANION.motion),
  };
}

/**
 * URL shapes (all values fall back to defaults):
 *   ?view=stage&presence=figure&appearance=male&equipment=lance&state=attentive&crest=on
 *   ?view=indicators&items=portrait:female:down:brass:idle:26,mark:-:-:sage:working:26:offscreen
 *   ?view=stills&cols=6&items=female:down:helmet:gold:idle:on,emblem:orbit:regular:soft:sage:idle
 */
export function parseSquireLabFixture(search: URLSearchParams): SquireLabFixture {
  const view = search.get("view");
  const tokens = (search.get("items") ?? "").split(",").filter((token) => token !== "");
  if (view === "stage") {
    return {
      kind: "stage",
      companion: companionFrom((key) => search.get(key)),
      state: pick(search.get("state"), COMPANION_STATES, "idle"),
      crest: search.get("crest") === "on",
    };
  }
  if (view === "indicators") {
    return {
      kind: "indicators",
      items: tokens.map((token, index) => {
        const [form, appearance, hood, palette, state, size, placement] = token.split(":");
        return {
          id: `i${index}`,
          form: pick(form, ["portrait", "lead", "mark"], "portrait"),
          appearance: pick(appearance, RIG_CHOICES.appearance, "female"),
          hood: pick(hood, RIG_CHOICES.hood, "down"),
          palette: pick(palette, RIG_CHOICES.palette, "brass"),
          state: pick(state, INDICATOR_STATES, "idle"),
          size: Number(size) > 0 ? Number(size) : SIDEBAR_SIZE,
          offscreen: placement === "offscreen",
        };
      }),
    };
  }
  if (view === "stills") {
    return {
      kind: "stills",
      columns: Number(search.get("cols")) > 0 ? Number(search.get("cols")) : 6,
      items: tokens.map((token, index) => {
        const parts = token.split(":");
        if (parts[0] === "emblem") {
          const [, frame, weight, glow, palette, state] = parts;
          const values: Record<string, string | undefined> = {
            presence: "emblem",
            frame,
            weight,
            glow,
            palette,
          };
          return {
            id: `s${index}`,
            companion: { ...companionFrom((key) => values[key] ?? null), motion: "still" },
            state: pick(state, COMPANION_STATES, "idle"),
            crest: false,
          };
        }
        const [appearance, hood, equipment, palette, state, crest] = parts;
        const values: Record<string, string | undefined> = { appearance, hood, equipment, palette };
        return {
          id: `s${index}`,
          companion: { ...companionFrom((key) => values[key] ?? null), motion: "still" },
          state: pick(state, COMPANION_STATES, "idle"),
          crest: crest === "on",
        };
      }),
    };
  }
  return { kind: "lab" };
}

function describeCompanion(companion: SquireCompanionChoice) {
  return companion.presence === "figure"
    ? `${companion.appearance}/${companion.hood}/${companion.equipment}/${companion.palette}`
    : `emblem/${companion.frame}/${companion.weight}/${companion.glow}/${companion.palette}`;
}

function LabIndicatorView({ item }: { readonly item: LabIndicator }) {
  const label = `${item.form} ${item.state}`;
  const indicator =
    item.form === "mark" ? (
      <SquireMark state={item.state} palette={item.palette} size={item.size} label={label} />
    ) : (
      <SquireIndicator
        state={item.state}
        palette={item.palette}
        appearance={item.appearance}
        hood={item.hood}
        isLead={item.form === "lead"}
        size={item.size}
        label={label}
      />
    );
  return (
    <span
      data-testid={`squire-lab-indicator-${item.id}`}
      className="inline-flex p-1"
      style={item.offscreen ? { position: "absolute", top: 4000, left: 0 } : undefined}
    >
      {indicator}
    </span>
  );
}

function Section(props: {
  readonly title: string;
  readonly testId: string;
  readonly children: ReactNode;
}) {
  return (
    <section data-testid={props.testId} className="flex flex-col gap-3 border-b border-border p-4">
      <h2 className="text-sm font-semibold">{props.title}</h2>
      {props.children}
    </section>
  );
}

const INDICATOR_SUBJECTS: ReadonlyArray<
  Omit<LabIndicator, "id" | "state" | "size" | "offscreen"> & { readonly key: string }
> = [
  {
    key: "female-down-brass",
    form: "portrait",
    appearance: "female",
    hood: "down",
    palette: "brass",
  },
  {
    key: "female-up-moonstone",
    form: "portrait",
    appearance: "female",
    hood: "up",
    palette: "moonstone",
  },
  { key: "male-down-sage", form: "portrait", appearance: "male", hood: "down", palette: "sage" },
  { key: "male-up-rose", form: "portrait", appearance: "male", hood: "up", palette: "rose" },
  { key: "lead-male-down", form: "lead", appearance: "male", hood: "down", palette: "gold" },
  { key: "mark-sage", form: "mark", appearance: "female", hood: "down", palette: "sage" },
  { key: "mark-lead", form: "lead", appearance: "female", hood: "down", palette: "gold" },
];

function IndicatorMatrix() {
  return (
    <Section title="Indicators (sidebar 26 px, enlarged 96 px)" testId="squire-lab-indicators">
      <table className="text-xs">
        <thead>
          <tr>
            <th className="p-1 text-left">subject</th>
            {INDICATOR_STATES.map((state) => (
              <th key={state} className="p-1 text-left">
                {state}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {INDICATOR_SUBJECTS.map((subject) => (
            <tr key={subject.key}>
              <td className="p-1">{subject.key}</td>
              {INDICATOR_STATES.map((state) => (
                <td key={state} className="p-1">
                  <span className="inline-flex items-center gap-2">
                    {[SIDEBAR_SIZE, ENLARGED_SIZE].map((size) => (
                      <LabIndicatorView
                        key={size}
                        item={{
                          ...subject,
                          id: `${subject.key}-${state}-${size}`,
                          // The mark-lead row is the Lead in emblem presence, so it renders as a mark.
                          form: subject.key === "mark-lead" ? "mark" : subject.form,
                          state,
                          size,
                          offscreen: false,
                        }}
                      />
                    ))}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}

function Choice<T extends string>(props: {
  readonly name: string;
  readonly value: T;
  readonly choices: readonly T[];
  readonly onChange: (value: T) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs">
      {props.name}
      <select
        data-testid={`squire-lab-control-${props.name}`}
        className="rounded-md border border-border bg-background px-2 py-1"
        value={props.value}
        onChange={(event) => props.onChange(pick(event.target.value, props.choices, props.value))}
      >
        {props.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    </label>
  );
}

function companionElementIn(host: HTMLElement | null): CompanionElement | null {
  return host?.querySelector<CompanionElement>("squire-rig, squire-emblem") ?? null;
}

function readDebug(element: CompanionElement | null) {
  if (!element || !("debugState" in element)) return null;
  const debug: CompanionDebugStateBase = element.debugState;
  return {
    paused: debug.paused,
    reason: debug.reason,
    frameCount: debug.frameCount,
    fps: debug.fps,
    state: debug.state,
    activeGesture: debug.activeGesture,
    settling: debug.settling,
    time: Math.round(debug.time * 100) / 100,
  };
}

function CompanionPanel({
  companion,
  state,
  crest,
  testId,
  ref,
}: {
  readonly companion: SquireCompanionChoice;
  readonly state: CompanionState;
  readonly crest: boolean;
  readonly testId: string;
  readonly ref?: Ref<SquireCompanionHandle>;
}) {
  return (
    <div
      data-testid={testId}
      data-companion={describeCompanion(companion)}
      className="flex shrink-0 items-center justify-center overflow-hidden"
      style={{ width: PANEL.width, height: PANEL.height }}
    >
      <SquireCompanion
        ref={ref}
        companion={companion}
        state={state}
        crest={crest}
        label={describeCompanion(companion)}
        className="w-full"
      />
    </div>
  );
}

function LiveCompanion() {
  const [companion, setCompanion] = useState<SquireCompanionChoice>(DEFAULT_COMPANION);
  const [state, setState] = useState<CompanionState>("idle");
  const [crest, setCrest] = useState(false);
  const [lastPlay, setLastPlay] = useState<GestureResult | null>(null);
  const [debug, setDebug] = useState<ReturnType<typeof readDebug>>(null);
  const handle = useRef<SquireCompanionHandle>(null);
  const panel = useRef<HTMLDivElement>(null);

  // Polling reads debugState only; it never wakes or repaints the companion.
  useEffect(() => {
    const timer = setInterval(() => setDebug(readDebug(companionElementIn(panel.current))), 250);
    return () => clearInterval(timer);
  }, []);

  const set =
    <K extends keyof SquireCompanionChoice>(key: K) =>
    (value: SquireCompanionChoice[K]) =>
      setCompanion((current) => ({ ...current, [key]: value }));

  return (
    <Section title="Live companion" testId="squire-lab-live">
      <div className="flex flex-wrap gap-4">
        <div ref={panel} className="rounded-md border border-border">
          <CompanionPanel
            companion={companion}
            state={state}
            crest={crest}
            testId="squire-lab-live-panel"
            ref={handle}
          />
        </div>
        <div className="flex max-w-md flex-col gap-3">
          <div className="grid grid-cols-3 gap-2">
            <Choice
              name="presence"
              value={companion.presence}
              choices={["figure", "emblem"]}
              onChange={set("presence")}
            />
            <Choice
              name="appearance"
              value={companion.appearance}
              choices={RIG_CHOICES.appearance}
              onChange={set("appearance")}
            />
            <Choice
              name="hood"
              value={companion.hood}
              choices={RIG_CHOICES.hood}
              onChange={set("hood")}
            />
            <Choice
              name="equipment"
              value={companion.equipment}
              choices={RIG_CHOICES.equipment}
              onChange={set("equipment")}
            />
            <Choice
              name="palette"
              value={companion.palette}
              choices={RIG_CHOICES.palette}
              onChange={set("palette")}
            />
            <Choice
              name="motion"
              value={companion.motion}
              choices={RIG_CHOICES.motion}
              onChange={set("motion")}
            />
            <Choice name="state" value={state} choices={COMPANION_STATES} onChange={setState} />
            <Choice
              name="crest"
              value={crest ? "on" : "off"}
              choices={RIG_CHOICES.crest}
              onChange={(value) => setCrest(value === "on")}
            />
            <Choice
              name="frame"
              value={companion.frame}
              choices={EMBLEM_CHOICES.frame}
              onChange={set("frame")}
            />
            <Choice
              name="weight"
              value={companion.weight}
              choices={EMBLEM_CHOICES.weight}
              onChange={set("weight")}
            />
            <Choice
              name="glow"
              value={companion.glow}
              choices={EMBLEM_CHOICES.glow}
              onChange={set("glow")}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            {COMPANION_GESTURES.map((gesture) => (
              <button
                key={gesture}
                type="button"
                data-testid={`squire-lab-gesture-${gesture}`}
                className="rounded-md border border-border px-2 py-1 text-xs"
                onClick={() => {
                  void handle.current?.play(gesture).then(setLastPlay);
                }}
              >
                {gesture}
              </button>
            ))}
          </div>
          <pre
            data-testid="squire-lab-debug"
            className="rounded-md border border-border p-2 text-xs"
          >
            {JSON.stringify({ ...debug, lastPlay }, null, 2)}
          </pre>
        </div>
      </div>
    </Section>
  );
}

const DEFAULT_STILLS: readonly LabStill[] = [
  { id: "d0", companion: { ...DEFAULT_COMPANION, motion: "still" }, state: "idle", crest: false },
  {
    id: "d1",
    companion: {
      ...DEFAULT_COMPANION,
      appearance: "male",
      hood: "up",
      equipment: "lance",
      palette: "moonstone",
      motion: "still",
    },
    state: "attentive",
    crest: false,
  },
  {
    id: "d2",
    companion: {
      ...DEFAULT_COMPANION,
      appearance: "male",
      equipment: "grimoire",
      palette: "gold",
      motion: "still",
    },
    state: "thinking",
    crest: true,
  },
  {
    id: "d3",
    companion: { ...DEFAULT_COMPANION, presence: "emblem", palette: "sage", motion: "still" },
    state: "attentive",
    crest: false,
  },
];

function StillCell({ still }: { readonly still: LabStill }) {
  return (
    <figure className="flex flex-col items-center gap-1">
      <CompanionPanel
        companion={still.companion}
        state={still.state}
        crest={still.crest}
        testId={`squire-lab-still-${still.id}`}
      />
      <figcaption className="text-xs text-muted-foreground">
        {describeCompanion(still.companion)} · {still.state}
        {still.crest ? " · crest" : ""}
      </figcaption>
    </figure>
  );
}

function StillGrid(props: { readonly items: readonly LabStill[]; readonly columns: number }) {
  return (
    <div
      data-testid="squire-lab-stills"
      className="grid gap-2"
      style={{ gridTemplateColumns: `repeat(${props.columns}, ${PANEL.width}px)` }}
    >
      {props.items.map((still) => (
        <StillCell key={still.id} still={still} />
      ))}
    </div>
  );
}

function StillComposer() {
  const [draft, setDraft] = useState<SquireCompanionChoice>({
    ...DEFAULT_COMPANION,
    motion: "still",
  });
  const [state, setState] = useState<CompanionState>("idle");
  const [crest, setCrest] = useState(false);
  const [items, setItems] = useState<readonly LabStill[]>(DEFAULT_STILLS);
  const set =
    <K extends keyof SquireCompanionChoice>(key: K) =>
    (value: SquireCompanionChoice[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));
  return (
    <Section title="Still rigs (motion still)" testId="squire-lab-still-composer">
      <div className="flex flex-wrap items-end gap-2">
        <Choice
          name="still-presence"
          value={draft.presence}
          choices={["figure", "emblem"]}
          onChange={set("presence")}
        />
        <Choice
          name="still-appearance"
          value={draft.appearance}
          choices={RIG_CHOICES.appearance}
          onChange={set("appearance")}
        />
        <Choice
          name="still-hood"
          value={draft.hood}
          choices={RIG_CHOICES.hood}
          onChange={set("hood")}
        />
        <Choice
          name="still-equipment"
          value={draft.equipment}
          choices={RIG_CHOICES.equipment}
          onChange={set("equipment")}
        />
        <Choice
          name="still-palette"
          value={draft.palette}
          choices={RIG_CHOICES.palette}
          onChange={set("palette")}
        />
        <Choice
          name="still-frame"
          value={draft.frame}
          choices={EMBLEM_CHOICES.frame}
          onChange={set("frame")}
        />
        <Choice name="still-state" value={state} choices={COMPANION_STATES} onChange={setState} />
        <Choice
          name="still-crest"
          value={crest ? "on" : "off"}
          choices={RIG_CHOICES.crest}
          onChange={(value) => setCrest(value === "on")}
        />
        <button
          type="button"
          data-testid="squire-lab-still-add"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() =>
            setItems((current) => [
              ...current,
              { id: `a${current.length}`, companion: draft, state, crest },
            ])
          }
        >
          Add still
        </button>
        <button
          type="button"
          data-testid="squire-lab-still-clear"
          className="rounded-md border border-border px-2 py-1 text-xs"
          onClick={() => setItems([])}
        >
          Clear
        </button>
      </div>
      <StillGrid items={items} columns={3} />
    </Section>
  );
}

export function SquireLab({ fixture }: { readonly fixture: SquireLabFixture }) {
  if (fixture.kind === "stage") {
    return (
      <CompanionPanel
        companion={fixture.companion}
        state={fixture.state}
        crest={fixture.crest}
        testId="squire-lab-stage"
      />
    );
  }
  if (fixture.kind === "indicators") {
    return (
      <div data-testid="squire-lab-indicator-fixture" className="flex flex-wrap gap-6 p-4">
        {fixture.items.map((item) => (
          <LabIndicatorView key={item.id} item={item} />
        ))}
      </div>
    );
  }
  if (fixture.kind === "stills")
    return <StillGrid items={fixture.items} columns={fixture.columns} />;
  return (
    <main data-testid="squire-lab" className="flex flex-col">
      <IndicatorMatrix />
      <LiveCompanion />
      <StillComposer />
    </main>
  );
}
