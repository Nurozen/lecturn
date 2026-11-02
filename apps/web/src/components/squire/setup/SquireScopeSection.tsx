import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, SquireGrantInput } from "@lecturn/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useThreadShellsForProjectRefs } from "../../../state/entities";
import { environmentProjects } from "../../../state/projects";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Label } from "../../ui/label";
import {
  squireScopeCoveringContainer,
  squireScopeHas,
  squireScopeThreadChecked,
  squireScopeToggleContainer,
  squireScopeToggleThread,
  squireScopeTree,
  type SquireScopeContainer,
  type SquireScopeNode,
} from "./squireSetup.logic";
import type { SetupFieldsProps } from "./SquireSetupBasics";
import { SetupSection } from "./SquireSetupLayout";

// A bounded list; older threads are still covered by their project's grant.
const THREADS_SHOWN = 40;
// One step per level; the chevron column keeps checkboxes aligned within a level.
const INDENT_PX = 20;
const CHEVRON_PX = 28;

type Grants = ReadonlyArray<SquireGrantInput>;

interface TreeProps {
  readonly environmentId: EnvironmentId;
  readonly grants: Grants;
  readonly disabled: boolean;
  readonly onChange: (grants: Grants) => void;
}

const KIND_LABEL = { staveSaga: "Saga", staveSpace: "Space" } as const;

/** P2 scope: Stave sagas, their spaces, each space's projects, and threads under each project. */
export function SquireScopeSection(
  props: SetupFieldsProps & { readonly environmentId: EnvironmentId },
) {
  const { draft, update, disabled, environmentId } = props;
  const projects = useAtomValue(environmentProjects.environmentProjectsAtom(environmentId));
  const tree = squireScopeTree(projects);
  const watched = draft.grants.filter((grant) => grant.kind !== "exclusion").length;
  const treeProps: TreeProps = {
    environmentId,
    grants: draft.grants,
    disabled,
    onChange: (grants) => update({ grants }),
  };
  return (
    <SetupSection
      title="Watches"
      description={
        watched === 0
          ? "Nothing yet. Pick the projects, spaces, or threads it should watch."
          : "New threads in a checked project, space, or saga are watched automatically."
      }
    >
      <div className="flex flex-col">
        {tree.map((node) => (
          <ScopeNodeRow
            key={`${node.kind}:${node.targetId}`}
            {...treeProps}
            node={node}
            depth={0}
            ancestors={[]}
          />
        ))}
        {projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">This environment has no projects yet.</p>
        ) : null}
      </div>
    </SetupSection>
  );
}

const hasProjectGrant = (node: SquireScopeNode, grants: Grants): boolean =>
  node.kind === "project"
    ? squireScopeHas(grants, "project", node.targetId)
    : node.children.some((child) => hasProjectGrant(child, grants));

function ScopeNodeRow(
  props: TreeProps & {
    readonly node: SquireScopeNode;
    readonly depth: number;
    /** Enclosing containers, innermost first. */
    readonly ancestors: ReadonlyArray<SquireScopeContainer>;
  },
) {
  const { node, depth, ancestors, grants } = props;
  // A container opens on its own when something inside it is picked, so a saved choice shows.
  const [open, setOpen] = useState(() => node.kind !== "project" && hasProjectGrant(node, grants));
  const own: SquireScopeContainer = { kind: node.kind, targetId: node.targetId };
  const covering = squireScopeCoveringContainer(grants, ancestors);
  const inner = [own, ...ancestors];
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <ScopeRow
        depth={depth}
        chevron={
          <CollapsibleTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`}
              />
            }
          >
            <ChevronRightIcon className={open ? "rotate-90" : undefined} />
          </CollapsibleTrigger>
        }
      >
        <Checkbox
          checked={covering !== null || squireScopeHas(grants, node.kind, node.targetId)}
          disabled={props.disabled || covering !== null}
          onCheckedChange={() =>
            props.onChange(squireScopeToggleContainer(grants, node.kind, node.targetId))
          }
        />
        <span className="min-w-0 truncate">{node.label}</span>
        {node.kind === "project" ? null : (
          <span className="text-xs text-muted-foreground">{KIND_LABEL[node.kind]}</span>
        )}
      </ScopeRow>
      <CollapsiblePanel>
        {/* Mounted only while open, so a closed project reads no thread shells. */}
        {!open ? null : node.kind === "project" ? (
          <ProjectThreads
            {...props}
            projectId={node.targetId}
            containers={inner}
            depth={depth + 1}
          />
        ) : (
          node.children.map((child) => (
            <ScopeNodeRow
              key={`${child.kind}:${child.targetId}`}
              {...props}
              node={child}
              depth={depth + 1}
              ancestors={inner}
            />
          ))
        )}
      </CollapsiblePanel>
    </Collapsible>
  );
}

function ScopeRow(props: {
  readonly depth: number;
  readonly chevron: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="flex min-h-7 items-center gap-1"
      style={{ paddingInlineStart: props.depth * INDENT_PX }}
    >
      {props.chevron ?? <span aria-hidden="true" className="size-7 shrink-0 sm:size-6" />}
      <Label variant="checkbox" className="min-w-0">
        {props.children}
      </Label>
    </div>
  );
}

function ProjectThreads(
  props: TreeProps & {
    readonly projectId: ProjectId;
    /** The project and its enclosing containers, innermost first. */
    readonly containers: ReadonlyArray<SquireScopeContainer>;
    readonly depth: number;
  },
) {
  const { grants, containers, depth } = props;
  const shells = useThreadShellsForProjectRefs([
    { environmentId: props.environmentId, projectId: props.projectId },
  ]);
  const threads = shells
    .filter((shell) => shell.squire === undefined || shell.squire === null)
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, THREADS_SHOWN);
  if (threads.length === 0) {
    return (
      <p
        className="py-1 text-xs text-muted-foreground"
        style={{ paddingInlineStart: depth * INDENT_PX + CHEVRON_PX }}
      >
        No threads.
      </p>
    );
  }
  return threads.map((thread) => (
    <ScopeRow key={thread.id} depth={depth} chevron={null}>
      <Checkbox
        checked={squireScopeThreadChecked(grants, thread.id, containers)}
        disabled={props.disabled}
        onCheckedChange={() =>
          props.onChange(squireScopeToggleThread(grants, thread.id, containers))
        }
      />
      <span className="min-w-0 truncate">{thread.title}</span>
    </ScopeRow>
  ));
}
