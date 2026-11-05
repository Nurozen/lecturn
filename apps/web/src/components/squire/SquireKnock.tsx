import { useAtomValue } from "@effect/atom-react";
import {
  createSquireKnockSession,
  randomSquireKnockPortrait,
  shouldSquireKnock,
  SQUIRE_KNOCK_BODY,
  SQUIRE_KNOCK_TITLE,
  squireKnockSnoozedUntil,
} from "@lecturn/client-runtime/state/squireKnock";
import {
  AuthSettingsWriteScope,
  type EnvironmentId,
  type ServerSettingsPatch,
} from "@lecturn/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import { useEnvironmentIdentities } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import {
  squireCapableAtom,
  squireEnvironment,
  useSquireEnvironmentState,
} from "../../state/squires";
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
  return environments.map(({ environmentId }) => (
    <SquireKnockEnvironment key={environmentId} environmentId={environmentId} />
  ));
}

function SquireKnockEnvironment(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const navigate = useNavigate();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const knock = useAtomValue(serverEnvironment.settingsValueAtom(environmentId))?.squire.knock;
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const runningThreadCount = useAtomValue(
    environmentThreadShells.runningThreadCountAtom(environmentId),
  );
  const capable = useAtomValue(squireCapableAtom(environmentId));
  const lead = useSquireEnvironmentState(environmentId)?.lead ?? null;
  const writeSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "squire suggestion",
    reportFailure: false,
  });
  // Creates a missing Lead once Squires run, as the sidebar does, for "Meet your Lead".
  useAtomValue(capable ? squireEnvironment.ensureLead(environmentId) : NOT_ENSURING);
  const shownToast = useRef<string | null>(null);
  // "Meet your Lead" waits here, past the toast, for the switch to apply and the Lead to exist.
  const meetingToast = useRef<string | null>(null);

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
    if (!(await save({ squire: { enabled: true } }))) {
      toastManager.close(toastId);
      return;
    }
    meetingToast.current = toastId;
    setTimeout(() => {
      if (meetingToast.current !== toastId) return;
      meetingToast.current = null;
      toastManager.update(toastId, {
        type: "info",
        title: "Squires are on",
        description: "Your Lead will appear in the sidebar once it is ready.",
        timeout: 8_000,
      });
    }, MEET_LEAD_TIMEOUT_MS);
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
      description: SQUIRE_KNOCK_BODY,
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
  // Eligible but for a snooze, which the event checks against the clock.
  const candidate =
    capabilities !== null &&
    shouldSquireKnock({
      capabilities,
      canWriteSettings,
      knock: knock === undefined ? null : { ...knock, snoozedUntil: "" },
      runningThreadCount,
      now: 0,
    });
  useEffect(() => {
    if (candidate) knockOnce();
  }, [candidate]);

  // Squires came on from anywhere: the offer is moot.
  useEffect(() => {
    if (!capable || shownToast.current === null) return;
    toastManager.close(shownToast.current);
    shownToast.current = null;
  }, [capable]);

  useEffect(() => {
    const toastId = meetingToast.current;
    if (toastId === null || !capable || lead === null) return;
    meetingToast.current = null;
    toastManager.close(toastId);
    void navigate({
      to: "/squires/$environmentId/$squireId",
      params: { environmentId, squireId: lead },
    });
  }, [capable, environmentId, lead, navigate]);

  return null;
}
