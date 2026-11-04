import { useAtomValue } from "@effect/atom-react";
import {
  squireRoomAuthorLabel,
  squireRoomLogRows,
  squireRoomPostsInput,
  squireRoomRerouteTargets,
  squireRoutingChip,
  type SquireRoomLogRow,
  type SquireSnapshotEntry,
} from "@lecturn/client-runtime/state/squire";
import type {
  EnvironmentId,
  SquireId,
  SquireRoom,
  SquireRoomPost,
  SquireRoomPostId,
} from "@lecturn/contracts";
import { ArrowRightIcon, UserIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings } from "../../../hooks/useSettings";
import { cn, randomUUID } from "../../../lib/utils";
import { useEnvironmentQuery } from "../../../state/query";
import { squireEnvironment } from "../../../state/squires";
import { useAtomCommand } from "../../../state/use-atom-command";
import { formatShortTimestamp } from "../../../timestampFormat";
import { Button } from "../../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { toastManager } from "../../ui/toast";
import { commandFailureMessage } from "../queue/SquireEvidenceCard";
import { SquirePortrait } from "../SquireHeader";

const AUTHOR_PX = 24;

export interface SquireRoomLogContext {
  readonly environmentId: EnvironmentId;
  readonly room: SquireRoom;
  readonly squires: ReadonlyArray<SquireSnapshotEntry>;
  readonly leadId: SquireId | null;
  readonly nameOf: (squireId: SquireId) => string;
  readonly onLoadEarlier: () => void;
}

/**
 * Pages of at most 50 posts, newest page first. Each earlier page starts where the page after it
 * ends now, so a new post that pushes one off the newest page never leaves a gap.
 */
export function SquireRoomLog(props: {
  readonly context: SquireRoomLogContext;
  readonly posts: ReadonlyArray<SquireRoomPost>;
  readonly nextBefore: SquireRoomPostId | null;
  readonly earlierPages: number;
}) {
  return (
    <div className="flex flex-col gap-3 px-6 py-4" data-testid="squire-room-log">
      <EarlierPosts
        context={props.context}
        before={props.nextBefore}
        remaining={props.earlierPages}
      />
      {props.posts.length === 0 && props.nextBefore === null ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          No posts yet. Mention a Squire with @ to wake it.
        </p>
      ) : (
        <LogRows context={props.context} posts={props.posts} />
      )}
    </div>
  );
}

function EarlierPosts(props: {
  readonly context: SquireRoomLogContext;
  readonly before: SquireRoomPostId | null;
  readonly remaining: number;
}) {
  if (props.before === null) return null;
  if (props.remaining === 0) {
    return (
      <div className="flex justify-center">
        <Button size="xs" variant="ghost" onClick={props.context.onLoadEarlier}>
          Load earlier
        </Button>
      </div>
    );
  }
  return (
    <EarlierPage context={props.context} before={props.before} remaining={props.remaining - 1} />
  );
}

function EarlierPage(props: {
  readonly context: SquireRoomLogContext;
  readonly before: SquireRoomPostId;
  readonly remaining: number;
}) {
  const { context } = props;
  const page = useEnvironmentQuery(
    squireEnvironment.roomPosts({
      environmentId: context.environmentId,
      input: squireRoomPostsInput(context.room.id, props.before),
    }),
  );
  if (page.data === null) {
    return page.error === null ? null : (
      <p className="text-center text-xs text-muted-foreground">Earlier posts could not load.</p>
    );
  }
  return (
    <>
      <EarlierPosts context={context} before={page.data.nextBefore} remaining={props.remaining} />
      <LogRows context={context} posts={page.data.posts} />
    </>
  );
}

function LogRows(props: {
  readonly context: SquireRoomLogContext;
  readonly posts: ReadonlyArray<SquireRoomPost>;
}) {
  return squireRoomLogRows(props.posts).map((row) => (
    <LogRow key={row.post.id} context={props.context} row={row} />
  ));
}

function LogRow(props: { readonly context: SquireRoomLogContext; readonly row: SquireRoomLogRow }) {
  const { context, row } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const time = formatShortTimestamp(row.post.createdAt, timestampFormat);
  if (row.kind === "system") {
    return (
      <p
        data-testid="squire-room-system"
        className="px-8 text-center text-xs text-muted-foreground"
      >
        {row.post.body} · {time}
      </p>
    );
  }
  if (row.kind === "handoff") {
    return <HandoffRow context={context} row={row} time={time} />;
  }
  const author = row.post.author;
  const entry =
    author.kind === "squire" || author.kind === "lead"
      ? (context.squires.find((candidate) => candidate.squire.id === author.squireId) ?? null)
      : null;
  const name = squireRoomAuthorLabel(author, context.nameOf);
  return (
    <article data-testid="squire-room-post" className="flex gap-3">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center">
        {entry === null ? (
          <span className="flex size-6 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <UserIcon aria-hidden className="size-3.5" />
          </span>
        ) : (
          <SquirePortrait
            environmentId={context.environmentId}
            entry={entry}
            size={AUTHOR_PX}
            label={name}
          />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-2 text-sm">
          <span className="font-medium">{name}</span>
          <span className="text-xs text-muted-foreground tabular-nums">{time}</span>
        </p>
        <p className="text-sm whitespace-pre-wrap wrap-anywhere">{row.post.body}</p>
        <RoutingChip context={context} post={row.post} />
      </div>
    </article>
  );
}

function HandoffRow(props: {
  readonly context: SquireRoomLogContext;
  readonly row: Extract<SquireRoomLogRow, { kind: "handoff" }>;
  readonly time: string;
}) {
  const { context, row } = props;
  const [expanded, setExpanded] = useState(false);
  const to = row.to.map(context.nameOf).join(", ");
  return (
    <div data-testid="squire-room-handoff" className="pl-9">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full min-w-0 items-start gap-1.5 rounded-md px-1 text-left text-sm text-muted-foreground"
      >
        <span className="shrink-0 font-medium text-foreground">
          {context.nameOf(row.from)}
          <ArrowRightIcon aria-label="to" className="mx-1 inline size-3" />
          {to}:
        </span>
        <span className={cn("min-w-0 flex-1 wrap-anywhere", !expanded && "truncate")}>
          {row.post.body}
        </span>
        <span className="shrink-0 text-xs tabular-nums">{props.time}</span>
      </button>
      <div className="px-1">
        <RoutingChip context={context} post={row.post} />
      </div>
    </div>
  );
}

function RoutingChip(props: {
  readonly context: SquireRoomLogContext;
  readonly post: SquireRoomPost;
}) {
  const { context, post } = props;
  const canReroute = useAtomValue(
    squireEnvironment.roomReroute.permissionAtom(context.environmentId),
  );
  const reroute = useAtomCommand(squireEnvironment.roomReroute, { reportFailure: false });
  const targets =
    canReroute && context.room.status === "open"
      ? squireRoomRerouteTargets(context.room, context.leadId, post)
      : [];

  const send = async (to: SquireId) => {
    const result = await reroute({
      environmentId: context.environmentId,
      input: { requestId: randomUUID(), postId: post.id, to },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: commandFailureMessage(result, "The post could not be rerouted. Try again."),
      });
    }
  };

  return (
    <div className="mt-1 flex items-center gap-1">
      {/* foreground/75 holds 6.5:1 (light) and 10.2:1 (dark) on the log's background, where
          muted-foreground sits at the 4.5:1 floor. */}
      <span
        data-testid="squire-room-routing"
        className="min-w-0 truncate text-xs text-foreground/75"
      >
        {squireRoutingChip(post.routing, context.nameOf)}
      </span>
      {targets.length === 0 ? null : (
        <Menu>
          <MenuTrigger render={<Button size="micro" variant="ghost-muted" />}>Reroute</MenuTrigger>
          <MenuPopup align="start">
            <MenuGroup>
              <MenuGroupLabel>Send this post to</MenuGroupLabel>
              {targets.map((squireId) => (
                <MenuItem key={squireId} onClick={() => void send(squireId)}>
                  {context.nameOf(squireId)}
                  {squireId === context.leadId ? (
                    <span className="ml-auto text-xs text-muted-foreground">Lead</span>
                  ) : null}
                </MenuItem>
              ))}
            </MenuGroup>
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
}
