import { useAtomValue } from "@effect/atom-react";
import {
  createSquireKnockSession,
  randomSquireKnockPortrait,
  shouldSquireKnock,
  SQUIRE_KNOCK_BODY,
  SQUIRE_KNOCK_TITLE,
  squireKnockSnoozedUntil,
} from "@lecturn/client-runtime/state/squireKnock";
import type { SquireEnvironmentState } from "@lecturn/client-runtime/state/squire";
import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useEnvironmentIdentities } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { squireCapableAtom, squireEnvironment } from "../../state/squires";
import { environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { SquireIndicator } from "./SquireIndicator";

// The suggestion that offers Squires to a busy user while they are off. Copy and eligibility
// live in client-runtime, shared with mobile.

const knockSession = createSquireKnockSession();

/** Settings' "Show again" lets the suggestion return this session, not only the next one. */
export function releaseSquireKnock(environmentId: EnvironmentId) {
  knockSession.release(environmentId);
}

// Long enough for the live switch, the config push, and the Lead's creation.
const MEET_LEAD_TIMEOUT_MS = 20_000;
const PORTRAIT_PX = 40;

const NOT_ENSURING = Atom.make(false);

export function SquireKnockCoordinator() {
  const environments = useEnvironmentIdentities();
  return environments.map(({ environmentId, label }) => (
    <SquireKnockEnvironment
      key={environmentId}
      environmentId={environmentId}
      label={environments.length > 1 ? label : null}
    />
  ));
}

const NO_STATE = Atom.make<SquireEnvironmentState | null>(null);

function SquireKnockEnvironment(props: {
  readonly environmentId: EnvironmentId;
  /** Set when more than one environment could knock, so the toast says which. */
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const knock = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.squire.knock;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const runningThreadCount = useAtomValue(
    environmentThreadShells.runningThreadCountAtom(environmentId),
  );
  const capable = useAtomValue(squireCapableAtom(environmentId));
  const readable = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  // "Meet your Lead" waits here, past the toast, for the switch to apply and the Lead to exist.
  // Squires are subscribed only then, and only where this session may read them.
  const [meetingToast, setMeetingToast] = useState<string | null>(null);
  const waiting = meetingToast !== null && capable && readable;
  const lead = useAtomValue(waiting ? squireEnvironment.state(environmentId) : NO_STATE)?.lead;
  // Creates a missing Lead, as the sidebar does.
  useAtomValue(waiting ? squireEnvironment.ensureLead(environmentId) : NOT_ENSURING);
  const navigated = useRef<string | null>(null);
  const writeSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "squire suggestion",
    reportFailure: false,
  });
  const shownToast = useRef<string | null>(null);

  const capabilities = config?.environment.capabilities ?? null;
  const save = async (patch: ServerSettingsPatch) => {
    const result = await writeSettings({ environmentId, input: { patch } });
    if (result._tag === "Success") return true;
    toastManager.add({
      type: "error",
      title: "Setting not saved",
      description: "Try again from Settings → Squires.",
    });
    return false;
  };

  const meetLead = async () => {
    const toastId = toastManager.add({ type: "loading", title: "Waking your Lead…", timeout: 0 });
    // Waiting before the save returns, so a Lead that is quicker than the reply is not missed.
    setMeetingToast(toastId);
    const timer = setTimeout(() => {
      if (navigated.current === toastId) return;
      setMeetingToast(null);
      toastManager.update(toastId, {
        type: "info",
        title: "Squires are on",
        description: "Your Lead will appear in the sidebar once it is ready.",
        timeout: 8_000,
      });
    }, MEET_LEAD_TIMEOUT_MS);
    if (!(await save({ squire: { enabled: true } }))) {
      clearTimeout(timer);
      setMeetingToast(null);
      toastManager.close(toastId);
    }
  };

  // An event, so the clock is read outside render and the toast's handlers are current.
  const knockOnce = useEffectEvent(() => {
    if (capabilities === null) return;
    const eligible = shouldSquireKnock({
      capabilities,
      canWriteSettings,
      knock: knock ?? null,
      runningThreadCount,
      now: Date.now(),
    });
    if (!eligible || !knockSession.claim(environmentId)) return;
    const portrait = randomSquireKnockPortrait();
    const close = () => {
      if (shownToast.current !== null) toastManager.close(shownToast.current);
    };
    shownToast.current = toastManager.add({
      title: SQUIRE_KNOCK_TITLE,
      description:
        props.label === null ? SQUIRE_KNOCK_BODY : `On ${props.label}. ${SQUIRE_KNOCK_BODY}`,
      timeout: 0,
      onClose: () => {
        shownToast.current = null;
      },
      actionProps: {
        children: "Meet your Lead",
        onClick: () => {
          close();
          void meetLead();
        },
      },
      data: {
        leadingMedia: (
          <SquireIndicator
            state="waiting"
            presence="figure"
            appearance={portrait.appearance}
            hood={portrait.hood}
            palette={portrait.palette}
            size={PORTRAIT_PX}
            label="A Squire"
          />
        ),
        actionLayout: "stacked-end",
        secondaryActionProps: {
          children: "Enable",
          onClick: () => {
            close();
            void save({ squire: { enabled: true } });
          },
        },
        secondaryActionVariant: "outline",
        additionalActions: [
          {
            id: "dismiss",
            variant: "ghost",
            props: {
              children: "Don't show again",
              onClick: () => {
                close();
                void save({ squire: { knock: { dismissed: true } } });
              },
            },
          },
          {
            id: "snooze",
            variant: "ghost",
            props: {
              children: "Not now",
              onClick: () => {
                close();
                void save({
                  squire: { knock: { snoozedUntil: squireKnockSnoozedUntil(Date.now()) } },
                });
              },
            },
          },
        ],
      },
    });
  });
  // Eligible but for a snooze, which the event checks against the clock. Keyed by the saved
  // knock, so "Show again" in settings re-arms it.
  const candidate =
    capabilities !== null &&
    knock !== undefined &&
    shouldSquireKnock({
      capabilities,
      canWriteSettings,
      knock: { ...knock, snoozedUntil: "" },
      runningThreadCount,
      now: 0,
    })
      ? `${knock.dismissed}:${knock.snoozedUntil}`
      : null;
  useEffect(() => {
    if (candidate !== null) knockOnce();
  }, [candidate]);

  // Squires came on from anywhere: the offer is moot.
  useEffect(() => {
    if (!capable || shownToast.current === null) return;
    toastManager.close(shownToast.current);
    shownToast.current = null;
  }, [capable]);

  useEffect(() => {
    if (meetingToast === null || lead == null || navigated.current === meetingToast) return;
    // The waiting state is left set: the knock is spent for this session, and the sidebar
    // keeps the same subscription once Squires are on.
    navigated.current = meetingToast;
    toastManager.close(meetingToast);
    void navigate({
      to: "/squires/$environmentId/$squireId",
      params: { environmentId, squireId: lead },
    });
  }, [environmentId, lead, meetingToast, navigate]);

  return null;
}
