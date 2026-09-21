// @effect-diagnostics globalTimers:off -- This isolated Electron preload has no Effect runtime; the timeout bounds command feedback.
import type {
  DesktopActivityAction,
  DesktopActivityRow,
  DesktopActivitySnapshot,
} from "@lecturn/contracts";
import {
  activityVisualState,
  activityVisualPresentation,
} from "@lecturn/client-runtime/state/activityContext";
import { ipcRenderer } from "electron";
import { activityCheckSummary, activityCheckTally, checkPresentation } from "./activity/checks.ts";
import {
  reconcilePeekRows,
  isViewedActivityThread,
  type ActivityMode,
  type ActivityInteraction,
} from "./activity/interaction.ts";
import * as Channels from "./activity/channels.ts";
import { ActivitySnapshotChangeTracker } from "./activity/changes.ts";
import { ActivityHoverIntent } from "./activity/hover.ts";
import { activityStateColorVariable } from "./activity/theme.ts";

window.addEventListener("DOMContentLoaded", () => {
  const pill = document.getElementById("pill")!;
  const cards = document.getElementById("cards")!;
  const feedback = document.getElementById("feedback")!;
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) entry.target.classList.toggle("visible", entry.isIntersecting);
    },
    { root: cards },
  );
  document.addEventListener("visibilitychange", () => {
    document.body.classList.toggle("hidden", document.hidden);
  });
  let mode: ActivityMode = "collapsed";
  let hovered = false;
  let peekIds: string[] | null = null;
  let revealRowId: string | null = null;
  let hoverLeaveTimeout: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let pendingTimeout: ReturnType<typeof setTimeout> | undefined;
  const drafts = new Map<string, string>();
  const sentDrafts = new Map<string, string>();
  const expandedChecks = new Set<string>();
  const expandedContext = new Set<string>();
  const changes = new ActivitySnapshotChangeTracker();
  let microRowId: string | null = null;
  let microLabel = "";
  let microColor = "var(--activity-accent)";
  let microInteracted = false;
  let microTimer: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  const dismissMicro = () => {
    clearTimeout(microTimer);
    if (mode === "micro") interact("dismiss");
  };
  const engageMicro = () => {
    if (mode !== "micro") return;
    clearTimeout(microTimer);
    if (microInteracted) return;
    microInteracted = true;
    interact("micro-interact");
  };
  const updateSummary = () => {
    const label = document.getElementById("summary")!;
    label.textContent = document.body.classList.contains("attached")
      ? String(snapshot.rows.length)
      : snapshot.summary;
    pill.setAttribute("title", snapshot.summary);
  };
  let snapshot: DesktopActivitySnapshot = { summary: "Connecting to Lecturn…", rows: [] };
  const interact = (event: ActivityInteraction) => {
    void ipcRenderer.invoke(Channels.ACTIVITY_MODE, event);
  };
  let contentReveal: Animation | undefined;
  const setMode = (next: ActivityMode) => {
    const changed = mode !== next;
    mode = next;
    if (mode !== "peek") peekIds = null;
    if (mode !== "micro") {
      clearTimeout(microTimer);
      microRowId = null;
      microInteracted = false;
    }
    document.body.classList.toggle("micro", mode === "micro");
    document.body.classList.toggle("expanded", mode === "expanded");
    document.body.classList.toggle("peek", mode === "peek");
    pill.setAttribute("aria-expanded", String(mode === "expanded"));
    pill.setAttribute(
      "aria-label",
      `${mode === "expanded" ? "Collapse" : "Expand"} Lecturn activity`,
    );
    document.getElementById("chevron")!.textContent = mode === "expanded" ? "⌃" : "⌄";
    render();
    if (changed) {
      contentReveal?.cancel();
      if (next !== "collapsed" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        contentReveal = document.getElementById("content")!.animate(
          [
            { opacity: 0, transform: "translateY(-6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration: 220, easing: "cubic-bezier(.2,.8,.2,1)" },
        );
      }
    }
  };
  pill.addEventListener("click", () => interact("toggle"));
  const shell = document.getElementById("shell")!;
  const hoverIntent = new ActivityHoverIntent();
  document.getElementById("open-app")!.addEventListener("click", () => {
    void ipcRenderer.invoke(Channels.ACTIVITY_OPEN_APP).catch((error: unknown) => {
      feedback.textContent = error instanceof Error ? error.message : "Unable to open Lecturn.";
    });
  });
  shell.addEventListener("mouseover", (event) => {
    if (event.relatedTarget instanceof Node && shell.contains(event.relatedTarget)) return;
    hoverIntent.enter(event);
    clearTimeout(hoverLeaveTimeout);
  });
  shell.addEventListener("mousemove", (event) => {
    if (!hoverIntent.move(event)) return;
    if (event.target instanceof Element && event.target.closest("#open-app")) return;
    clearTimeout(hoverLeaveTimeout);
    if (mode === "micro") engageMicro();
    else if (!hovered) interact("hover-enter");
    hovered = true;
  });
  shell.addEventListener("mouseleave", () => {
    hoverIntent.leave();
    clearTimeout(hoverLeaveTimeout);
    hoverLeaveTimeout = setTimeout(() => {
      hovered = false;
      interact("hover-leave");
    }, 180);
  });
  cards.addEventListener("pointerdown", engageMicro);
  cards.addEventListener("focusin", engageMicro);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") interact("dismiss");
  });
  document.getElementById("hide")!.addEventListener("click", () => {
    void ipcRenderer.invoke(Channels.ACTIVITY_SET_ENABLED, false);
  });
  const element = (tag: string, text: string, className?: string) => {
    const result = document.createElement(tag);
    result.textContent = text;
    if (className) result.className = className;
    return result;
  };
  const stateFor = (row: DesktopActivityRow) => row.visualState ?? activityVisualState(row);
  const resumeMotion = (element: HTMLElement, state: ReturnType<typeof stateFor>) => {
    const duration = state === "active" ? 4000 : state === "attention" ? 2400 : 0;
    // Rebuilt cards resume the same clock phase while live snapshots stream in.
    // The bounded negative delay avoids resetting the perimeter/pulse at every update.
    if (duration)
      element.style.setProperty("--activity-phase", `${-(performance.now() % duration)}ms`);
  };
  const stateGlyph = (row: DesktopActivityRow) => {
    const presentation = activityVisualPresentation[stateFor(row)];
    const icon = element("span", presentation.glyph, "state-glyph");
    icon.style.color = activityStateColorVariable(stateFor(row));
    icon.title = row.status || presentation.label;
    icon.setAttribute("aria-label", row.status || presentation.label);
    return icon;
  };
  const projectIdentity = (row: DesktopActivityRow) => {
    const identity = element("span", "", "project-identity");
    identity.title = row.projectLabel ?? row.subtitle;
    const icon = element(
      "span",
      row.projectIcon?.kind === "emoji"
        ? row.projectIcon.emoji
        : row.projectKind === "saga"
          ? "≋"
          : row.projectKind === "space"
            ? "✧"
            : "◇",
      "project-icon",
    );
    icon.setAttribute("aria-hidden", "true");
    if (row.projectIconDataUrl) {
      const image = document.createElement("img");
      image.src = row.projectIconDataUrl;
      image.alt = "";
      image.width = 18;
      image.height = 18;
      icon.replaceChildren(image);
    }
    identity.append(icon, element("span", row.projectLabel ?? row.subtitle, "project-label"));
    if (row.accountId && row.accountLabel) {
      const account = element("span", row.accountLabel, "account-mark");
      account.setAttribute("aria-label", `Connect account: ${row.accountLabel}`);
      const dot = element("span", "", "account-dot");
      dot.setAttribute("aria-hidden", "true");
      if (row.accountColor && /^#[0-9a-fA-F]{6}$/.test(row.accountColor)) {
        dot.style.backgroundColor = row.accountColor;
      }
      account.prepend(dot);
      identity.append(account);
    }
    return identity;
  };
  const checkMeter = (row: DesktopActivityRow) => {
    const meter = element("div", "", "check-meter");
    meter.setAttribute("aria-hidden", "true");
    for (const check of row.checks ?? []) meter.append(element("span", "", check.status));
    if ((row.checkTotal ?? 0) > (row.checks?.length ?? 0))
      meter.append(element("span", "", "unknown"));
    return meter;
  };
  const dispatch = async (
    row: DesktopActivityRow,
    kind: DesktopActivityAction["kind"],
    text?: string,
  ) => {
    if (pending) return;
    // Recovery belongs to this request, never a later action on the same card.
    sentDrafts.delete(row.id);
    pending = true;
    feedback.textContent = kind === "merge" ? "Sending instruction…" : "Sending…";
    pendingTimeout = setTimeout(() => {
      pending = false;
      feedback.textContent =
        "No update received yet. Open Lecturn to check the connection before retrying.";
      render();
    }, 20_000);
    render();
    try {
      await ipcRenderer.invoke(Channels.ACTIVITY_ACTION, {
        rowId: row.id,
        environmentId: row.environmentId,
        projectId: row.projectId,
        ...(row.threadId ? { threadId: row.threadId } : {}),
        ...(row.watchId ? { watchId: row.watchId } : {}),
        ...(row.watchRevision !== undefined ? { watchRevision: row.watchRevision } : {}),
        kind,
        ...(text ? { text } : {}),
      } satisfies DesktopActivityAction);
      feedback.textContent =
        kind === "merge" ? "Instruction sent. Awaiting thread acknowledgment…" : "Request sent.";
      if (kind === "steer") {
        if (text) sentDrafts.set(row.id, text);
        drafts.delete(row.id);
        dismissMicro();
      }
    } catch (error) {
      pending = false;
      clearTimeout(pendingTimeout);
      feedback.textContent = error instanceof Error ? error.message : "Unable to send request.";
      render();
    }
  };
  const render = () => {
    const scrollTop = cards.scrollTop;
    const focusedKey =
      document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.focusKey
        : undefined;
    const restoreFocus = () => {
      if (revealRowId && mode === "expanded") {
        const card = [...cards.querySelectorAll<HTMLElement>("article")].find(
          (item) => item.dataset.rowId === revealRowId,
        );
        revealRowId = null;
        const target = card?.querySelector<HTMLElement>(".check-summary") ?? card;
        target?.focus({ preventScroll: true });
        card?.scrollIntoView({ block: "nearest" });
      } else if (focusedKey) {
        [...cards.querySelectorAll<HTMLElement>("[data-focus-key]")]
          .find((item) => item.dataset.focusKey === focusedKey)
          ?.focus({ preventScroll: true });
      }
    };
    const focused =
      document.activeElement instanceof HTMLInputElement
        ? document.activeElement.dataset.rowId
        : undefined;
    const selectionEnd =
      document.activeElement instanceof HTMLInputElement
        ? document.activeElement.selectionEnd
        : null;
    const selection =
      document.activeElement instanceof HTMLInputElement
        ? document.activeElement.selectionStart
        : null;
    updateSummary();
    visibility.disconnect();
    cards.replaceChildren();
    if (!snapshot.rows.length)
      cards.append(
        element(
          "p",
          "No active work yet. Open a project in Lecturn to watch a pull request or direct an agent.",
          "empty",
        ),
      );
    const previewRows = snapshot.rows.filter(
      (row) => !isViewedActivityThread(row, snapshot.viewedThread),
    );
    if (mode === "peek") {
      const rows = reconcilePeekRows(
        previewRows,
        peekIds ?? [],
        peekIds !== null && (hovered || Boolean(focusedKey)),
      );
      if (!rows.length && snapshot.rows.length) {
        interact("dismiss");
        return;
      }
      peekIds = rows.map((row) => row.id);
      void ipcRenderer.invoke(Channels.ACTIVITY_PEEK_COUNT, rows.length);
      for (const row of rows) {
        const item = element("button", "", `peek-row activity-state ${stateFor(row)}`);
        resumeMotion(item, stateFor(row));
        item.dataset.focusKey = `${row.id}:peek`;
        item.setAttribute(
          "title",
          `${row.projectLabel ? `${row.projectLabel} · ` : ""}${row.title}\n${row.status}${row.excerpt ? `\n${row.excerpt}` : ""}\nExpand activity`,
        );
        const copy = element("span", "", "peek-copy");
        const identity = projectIdentity(row);
        identity.append(element("span", row.title, "peek-title"));
        copy.append(identity, element("span", row.excerpt ?? row.subtitle, "peek-excerpt"));
        item.append(stateGlyph(row), copy);
        const checks = activityCheckSummary(row);
        if (checks.total) {
          const tally = element("span", activityCheckTally(row), "peek-ci");
          tally.style.color = activityStateColorVariable(stateFor(row));
          tally.title = checks.label;
          tally.setAttribute("aria-label", checks.label);
          item.append(tally, checkMeter(row));
        }
        item.addEventListener("click", () => {
          revealRowId = row.id;
          if (checks.total) expandedChecks.add(row.id);
          interact("expand");
        });
        cards.append(item);
        visibility.observe(item);
      }
      const expand = element("button", "⌄", "peek-expand");
      expand.dataset.focusKey = "peek:expand";
      expand.setAttribute("aria-label", "Expand all activity");
      expand.title = "Expand all activity";
      expand.addEventListener("click", () => interact("expand"));
      cards.append(expand);
      restoreFocus();
      return;
    }
    const groups =
      mode === "micro"
        ? [{ title: "", rows: previewRows.filter((row) => row.id === microRowId) }]
        : [
            { title: "Pull requests", rows: snapshot.rows.filter((row) => row.watchId) },
            {
              title: "Recent threads",
              rows: snapshot.rows.filter((row) => !row.watchId && row.recent),
            },
            {
              title: "Active threads",
              rows: snapshot.rows.filter((row) => !row.watchId && !row.recent),
            },
          ];
    for (const group of groups) {
      if (!group.rows.length) continue;
      if (group.title) cards.append(element("h2", group.title, "section-title"));
      for (const row of group.rows) {
        const card = document.createElement("article");
        const checksSummary = activityCheckSummary(row);
        const visualState = stateFor(row);
        const active = visualState === "active";
        card.dataset.rowId = row.id;
        card.dataset.focusKey = `${row.id}:card`;
        card.tabIndex = -1;
        card.classList.add("activity-state", visualState);
        resumeMotion(card, visualState);
        card.classList.toggle("thread-card", !row.watchId);
        const heading = element("div", "", "card-heading");
        const attention =
          visualState === "attention" || visualState === "failed" || visualState === "offline";
        const glyph = stateGlyph(row);
        const openAction = row.actions.find((action) => action.id === "open");
        const headingTitle = element("h2", "");
        if (openAction && row.threadId && !row.watchId) {
          const titleButton = document.createElement("button");
          titleButton.className = "card-title";
          titleButton.textContent = row.title;
          titleButton.title = openAction.label;
          titleButton.dataset.focusKey = `${row.id}:title`;
          titleButton.disabled = pending || openAction.disabled === true;
          titleButton.addEventListener("click", () => void dispatch(row, "open"));
          headingTitle.append(titleButton);
          card.classList.add("navigable");
          card.addEventListener("click", (event) => {
            if (pending || openAction.disabled || window.getSelection()?.toString()) return;
            if (!(event.target instanceof Element)) return;
            if (
              event.target.closest(
                "button,a,input,textarea,select,form,details,[contenteditable=true]",
              )
            )
              return;
            void dispatch(row, "open");
          });
        } else headingTitle.textContent = row.title;
        heading.append(glyph, headingTitle);
        card.append(projectIdentity(row), heading);
        if (mode === "micro") {
          const notice = element("div", microLabel, "micro-change");
          notice.style.color = microColor;
          notice.setAttribute("role", "status");
          card.append(notice);
        }
        if (row.excerpt) card.append(element("div", row.excerpt, "card-excerpt"));
        if (attention) card.append(element("div", row.status, "attention-label"));
        if (row.watchId && row.subtitle !== row.excerpt)
          card.append(element("div", row.subtitle, "subtitle"));
        if (row.detail || row.mergeStatus || (!row.watchId && row.subtitle)) {
          const context = document.createElement("details");
          context.className = "context";
          context.open = expandedContext.has(row.id);
          context.addEventListener("toggle", () => {
            if (!context.isConnected) return;
            if (context.open) expandedContext.add(row.id);
            else expandedContext.delete(row.id);
          });
          const summary = element("summary", "", "context-summary");
          summary.dataset.focusKey = `${row.id}:context`;
          summary.append(
            element("span", "ⓘ", "context-icon"),
            element("span", "Details", "sr-only"),
          );
          summary.setAttribute("title", "Current task, agent, and handoff details");
          summary.setAttribute("aria-label", "Current task, agent, and handoff details");
          context.append(summary);
          if (!row.watchId && row.subtitle)
            context.append(element("div", row.subtitle, "subtitle"));
          if (row.detail) context.append(element("p", row.detail, "detail"));
          if (row.mergeStatus) context.append(element("p", row.mergeStatus, "merge-status"));
          card.append(context);
        }
        if (checksSummary.total) {
          const details = document.createElement("details");
          details.open = expandedChecks.has(row.id);
          details.addEventListener("toggle", () => {
            if (!details.isConnected) return;
            if (details.open) expandedChecks.add(row.id);
            else expandedChecks.delete(row.id);
          });
          const summary = element("summary", `CI · ${checksSummary.total}`, "check-summary");
          summary.dataset.focusKey = `${row.id}:checks`;
          summary.title = checksSummary.label;
          summary.setAttribute("aria-label", checksSummary.label);
          const failedCount =
            row.checks?.filter(
              (check) => check.status === "failure" || check.status === "action-required",
            ).length ?? 0;
          if (failedCount) summary.append(element("span", `× ${failedCount}`, "check-failed"));
          if (checksSummary.pending)
            summary.append(element("span", `◌ ${checksSummary.pending}`, "check-pending"));
          details.append(summary);
          const meter = element("div", "", "check-meter");
          meter.setAttribute("aria-hidden", "true");
          const list = element("ul", "", "check-list");
          for (const check of row.checks ?? []) {
            meter.append(element("span", "", check.status));
            const presentation = checkPresentation[check.status];
            const item = element("li", "", "check-row");
            const icon = element("span", presentation.icon, `check-icon ${check.status}`);
            icon.setAttribute("aria-hidden", "true");
            const copy = element("div", check.name, "check-copy");
            if (check.description) copy.append(element("div", check.description, "muted"));
            icon.title = presentation.label;
            icon.setAttribute("aria-label", presentation.label);
            icon.removeAttribute("aria-hidden");
            item.append(icon, copy);
            list.append(item);
          }
          if (checksSummary.unknown)
            list.append(
              element(
                "li",
                `${checksSummary.unknown} more jobs · Open PR for the full list`,
                "muted",
              ),
            );
          details.append(list);
          card.append(meter, details);
        }
        const actions = element("div", "", "actions");
        for (const action of row.actions) {
          if (action.id === "steer") continue;
          const button = document.createElement("button");
          const actionGlyphs = {
            open: "↗",
            watch: "◉",
            "stop-watch": "⊘",
            "revoke-merge": "↶",
            merge: "",
            steer: "",
          };
          button.dataset.focusKey = `${row.id}:${action.id}`;
          button.textContent = action.id === "merge" ? action.label : actionGlyphs[action.id];
          button.title =
            action.id === "merge"
              ? `Send ${row.mergeRecipient ?? "the managing thread"} an instruction to merge when ready${row.mergeStatus ? `. ${row.mergeStatus}` : ""}`
              : action.label;
          button.setAttribute("aria-label", action.label);
          button.className = action.id === "merge" ? "primary" : "secondary icon-button";
          button.disabled = pending || action.disabled === true;
          button.addEventListener("click", () => void dispatch(row, action.id));
          if (action.id === "open") {
            button.className = "card-open";
            card.append(button);
          } else actions.append(button);
        }
        if (actions.childElementCount) card.append(actions);
        const steer = row.actions.find((action) => action.id === "steer");
        if (steer) {
          const form = document.createElement("form");
          const input = document.createElement("input");
          input.placeholder = "Steer this agent…";
          input.maxLength = 8000;
          input.setAttribute("aria-label", `Steer agent for ${row.title}`);
          input.dataset.rowId = row.id;
          input.dataset.focusKey = `${row.id}:input`;
          input.value = drafts.get(row.id) ?? "";
          input.disabled = pending || steer.disabled === true;
          input.addEventListener("input", () => drafts.set(row.id, input.value));
          const button = document.createElement("button");
          button.className = "primary";
          button.dataset.focusKey = `${row.id}:send`;
          button.textContent = "↑";
          button.title = "Send instruction";
          button.setAttribute("aria-label", "Send instruction");
          button.disabled = input.disabled;
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (input.value.trim()) void dispatch(row, "steer", input.value.trim());
          });
          form.append(input, button);
          card.append(form);
          if (focused === row.id)
            queueMicrotask(() => {
              input.focus();
              input.setSelectionRange(selection, selectionEnd);
            });
        }
        cards.append(card);
        if (active || visualState === "attention") visibility.observe(card);
      }
    }
    cards.scrollTop = scrollTop;
    restoreFocus();
  };
  const receiveSnapshot = (next: DesktopActivitySnapshot) => {
    const change = changes.update(next);
    clearTimeout(pendingTimeout);
    snapshot = next;
    for (const [id, text] of sentDrafts) {
      const row = next.rows.find((item) => item.id === id);
      if (!row) sentDrafts.delete(id);
      else if (row.status === "Action failed") {
        if (!drafts.has(id)) drafts.set(id, text);
        sentDrafts.delete(id);
      }
    }
    pending = false;
    feedback.textContent = "";
    if (
      microRowId &&
      !next.rows.some(
        (row) => row.id === microRowId && !isViewedActivityThread(row, next.viewedThread),
      )
    )
      dismissMicro();
    if (change) {
      const count = document.getElementById("summary")!;
      clearTimeout(flashTimer);
      count.classList.remove("state-change");
      count.style.setProperty("--change-color", activityStateColorVariable(change.state));
      void count.offsetWidth;
      count.classList.add("state-change");
      count.title = change.label;
      flashTimer = setTimeout(() => count.classList.remove("state-change"), 1400);
      if (mode === "collapsed" || (mode === "micro" && !microInteracted)) {
        microRowId = change.rowId;
        const changed = next.rows.find((row) => row.id === change.rowId);
        microLabel =
          changed && change.label.startsWith(`${changed.title} · `)
            ? change.label.slice(changed.title.length + 3)
            : change.label;
        microColor = activityStateColorVariable(change.state);
        microInteracted = false;
        clearTimeout(microTimer);
        interact("micro-open");
        microTimer = setTimeout(dismissMicro, 5000);
      }
    }
    render();
  };
  let receivedPublication = false;
  ipcRenderer.on(Channels.ACTIVITY_SNAPSHOT, (_event, next: DesktopActivitySnapshot) => {
    receivedPublication = true;
    receiveSnapshot(next);
  });
  ipcRenderer.on(Channels.ACTIVITY_CAMERA_HEIGHT, (_event, height: unknown) => {
    if (typeof height !== "number" || !Number.isFinite(height) || height < 0 || height > 80) return;
    document.documentElement.style.setProperty("--camera-height", `${height}px`);
    document.documentElement.style.setProperty(
      "--camera-width",
      `${Math.min(260, Math.max(220, Math.round(height * 5.8)))}px`,
    );
    document.body.classList.toggle("attached", height > 0);
    updateSummary();
  });
  ipcRenderer.on(Channels.ACTIVITY_MODE, (_event, next: ActivityMode) => setMode(next));
  void ipcRenderer.invoke(Channels.ACTIVITY_READ).then((next: DesktopActivitySnapshot) => {
    if (!receivedPublication) receiveSnapshot(next);
  });
});
