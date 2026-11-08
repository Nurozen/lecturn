import { useAtomValue } from "@effect/atom-react";
import {
  createSquireKnockSession,
  randomSquireKnockPortrait,
  shouldSquireKnock,
  squireKnockSnoozedUntil,
  SQUIRE_KNOCK_BODY,
  SQUIRE_KNOCK_TITLE,
} from "@lecturn/client-runtime/state/squireKnock";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettingsPatch,
  type SquireCompanion,
  type SquireId,
} from "@lecturn/contracts";
import { useNavigation } from "@react-navigation/native";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { squireEnvironment } from "../../state/squire";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { RequestActionButton } from "../threads/RequestActionButton";
import { SquireIndicator } from "./SquireIndicator";

// Module-level so a remounted Home keeps a knock it already showed and never shows a second.
const knockSession = createSquireKnockSession();
const offeredKnocks = new Set<EnvironmentId>();

/** Settings' "Show the Squire suggestion again" lets it return this session too. */
export function releaseSquireKnock(environmentId: EnvironmentId) {
  knockSession.release(environmentId);
}

const LEAD_WAIT_MS = 20_000;

const NO_LEAD_ATOM = Atom.make<SquireId | null>(null);

/** Squire RPCs exist only once the capability flips, so the snapshot is read after that. */
const knockLeadAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): SquireId | null => {
    const config = get(serverEnvironment.configValueAtom(environmentId));
    if (config?.environment.capabilities.squire !== true) return null;
    get(squireEnvironment.ensureLead(environmentId));
    return get(squireEnvironment.state(environmentId))?.lead ?? null;
  }).pipe(Atom.withLabel(`mobile-squire-knock-lead:${environmentId}`)),
);

type KnockPhase = "offer" | "meeting" | "gave-up" | "done";

/** A Squire offering help to a busy user while Squires are off: one per environment. */
export function SquireKnockCards(props: {
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly connectionState: string;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly pane: "sidebar" | "screen";
}) {
  const connected = props.environments.filter(
    (environment) =>
      environment.connectionState === "connected" &&
      (props.selectedEnvironmentId === null ||
        environment.environmentId === props.selectedEnvironmentId),
  );
  return connected.map((environment) => (
    <SquireKnockSlot
      key={environment.environmentId}
      environmentId={environment.environmentId}
      label={props.environments.length > 1 ? environment.label : null}
      pane={props.pane}
    />
  ));
}

/** Remounts the card when the saved knock changes, so a reset from settings re-arms it. */
function SquireKnockSlot(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly pane: "sidebar" | "screen";
}) {
  const knock = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId))?.squire
    .knock;
  return (
    <SquireKnockCard
      key={knock === undefined ? "" : `${knock.dismissed}:${knock.snoozedUntil}`}
      {...props}
    />
  );
}

function SquireKnockCard(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
  readonly pane: "sidebar" | "screen";
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const runningThreadCount = useAtomValue(
    environmentThreadShells.runningThreadCountAtom(environmentId),
  );
  const capabilities = config?.environment.capabilities;
  const squiresOn = capabilities?.squire === true;
  const knock = settings?.squire.knock ?? null;

  const [offered, setOffered] = useState(() => offeredKnocks.has(environmentId));
  const [phase, setPhase] = useState<KnockPhase>("offer");
  const [error, setError] = useState<string | null>(null);
  const [companion] = useState(
    (): Pick<SquireCompanion, "presence" | "appearance" | "hood" | "palette"> => ({
      presence: "figure",
      ...randomSquireKnockPortrait(),
    }),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "squire knock settings update",
    reportFailure: true,
  });
  const lead = useAtomValue(phase === "meeting" ? knockLeadAtom(environmentId) : NO_LEAD_ATOM);

  // In an effect because `now` moves on: a snooze that ends is seen on the next change here.
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- claims this environment's knock in the session-wide knock registry once it becomes eligible
  useEffect(() => {
    if (offered || capabilities === undefined) return;
    const eligible = shouldSquireKnock({
      capabilities,
      canWriteSettings,
      knock,
      runningThreadCount,
      now: Date.now(),
    });
    if (eligible && knockSession.claim(environmentId)) offeredKnocks.add(environmentId);
    // oxlint-disable-next-line react/set-state-in-effect -- The claim lives in a session that outlives this mount.
    if (offeredKnocks.has(environmentId)) setOffered(true);
  }, [capabilities, canWriteSettings, environmentId, knock, offered, runningThreadCount]);

  // Turned on elsewhere: the offer has nothing left to do.
  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- drops the session-wide offered-knock entry once squires are turned on elsewhere
  useEffect(() => {
    if (squiresOn && phase === "offer") offeredKnocks.delete(environmentId);
  }, [environmentId, phase, squiresOn]);

  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- opens the Lead's squire through the navigator once the server reports it
  useEffect(() => {
    if (phase !== "meeting" || lead === null) return;
    // oxlint-disable-next-line react/set-state-in-effect -- The Lead arrived; the offer is spent.
    setPhase("done");
    navigation.navigate("Squire", { environmentId, squireId: lead });
  }, [environmentId, lead, navigation, phase]);

  // oxlint-disable-next-line lecturn/no-unreasoned-state-sync -- starts the Lead wait timeout and clears it on cleanup
  useEffect(() => {
    if (phase !== "meeting") return;
    const timer = setTimeout(() => setPhase("gave-up"), LEAD_WAIT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!offered || phase === "done" || (squiresOn && phase === "offer")) return null;

  const write = async (patch: ServerSettingsPatch, next: "meeting" | "done") => {
    setError(null);
    setPhase(next);
    // Spent before the reply: the saved knock remounts this card, which must not offer again.
    offeredKnocks.delete(environmentId);
    const result = await updateSettings({ environmentId, input: { patch } });
    if (result._tag === "Failure") {
      offeredKnocks.add(environmentId);
      setPhase("offer");
      setError("Couldn't save that. Try again.");
    }
  };
  const meeting = phase === "meeting";

  return (
    <View className={cn("pb-3", props.pane === "sidebar" ? "px-3" : "px-4")}>
      <View className="gap-3 rounded-2xl border border-border bg-card px-3.5 py-3">
        <View className="flex-row items-start gap-3">
          <SquireIndicator state="waiting" companion={companion} size={44} label="A Squire" />
          <View className="min-w-0 flex-1 gap-0.5">
            {props.label === null ? null : (
              <Text className="font-sans text-2xs text-foreground-muted" numberOfLines={1}>
                {props.label}
              </Text>
            )}
            <Text className="font-lecturn-bold text-sm text-foreground">{SQUIRE_KNOCK_TITLE}</Text>
            <Text className="font-sans text-sm text-foreground-secondary">{SQUIRE_KNOCK_BODY}</Text>
          </View>
        </View>
        {phase === "gave-up" ? (
          <View className="flex-row items-center gap-3">
            <Text className="min-w-0 flex-1 font-sans text-sm text-foreground-secondary">
              Squires are on. Your Lead will appear under Squires shortly.
            </Text>
            <KnockTextButton label="OK" onPress={() => setPhase("done")} />
          </View>
        ) : (
          <>
            <View className="flex-row flex-wrap gap-2">
              <RequestActionButton
                label={meeting ? "Waking your Lead…" : "Meet your Lead"}
                disabled={meeting}
                onPress={() => void write({ squire: { enabled: true } }, "meeting")}
              />
              <RequestActionButton
                label="Enable"
                tone="secondary"
                disabled={meeting}
                onPress={() => void write({ squire: { enabled: true } }, "done")}
              />
            </View>
            <View className="flex-row flex-wrap gap-4">
              <KnockTextButton
                label="Not now"
                disabled={meeting}
                onPress={() =>
                  void write(
                    { squire: { knock: { snoozedUntil: squireKnockSnoozedUntil(Date.now()) } } },
                    "done",
                  )
                }
              />
              <KnockTextButton
                label="Don't show again"
                disabled={meeting}
                onPress={() => void write({ squire: { knock: { dismissed: true } } }, "done")}
              />
            </View>
          </>
        )}
        {error === null ? null : (
          <Text accessibilityRole="alert" className="font-sans text-sm text-danger-foreground">
            {error}
          </Text>
        )}
      </View>
    </View>
  );
}

function KnockTextButton(props: {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={8}
      className="py-1 active:opacity-60 disabled:opacity-50"
    >
      <Text className="font-lecturn-bold text-sm text-foreground-secondary">{props.label}</Text>
    </Pressable>
  );
}
