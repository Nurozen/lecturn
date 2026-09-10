import { StaveLifecycleBadge } from "./StaveLifecycleBadge";
import { useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react";
import type { StaveOperation } from "@t3tools/contracts";
import type {
  SidebarProjectSnapshot,
  SidebarProjectGroupMember,
} from "../../sidebarProjectGrouping";
import { readLocalApi } from "../../localApi";
import { openStaveWizard } from "../../staveWizard";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { StaveConfirmDialog } from "./StaveConfirmDialog";
import { useSagaSidebarTree } from "./useSagaSidebarTree";
import { staveSagaMemberBadges } from "./staveSaga.logic";

export function SagaSidebarSection({
  projects,
  onOpen,
}: {
  projects: readonly SidebarProjectSnapshot[];
  onOpen: (project: SidebarProjectSnapshot) => void;
}) {
  const { tree, enabledKeys, availableKeys, nest } = useSagaSidebarTree(projects);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [confirmation, setConfirmation] = useState<{
    member: SidebarProjectGroupMember;
    operation: StaveOperation;
  } | null>(null);
  const sagas = tree.filter((node) =>
    node.group.members.some(({ project }) => enabledKeys.has(project.physicalProjectKey)),
  );
  if (!nest || sagas.length === 0) return null;
  const menu = async (member: SidebarProjectGroupMember, position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!api || !member.stave) return;
    const enabled =
      availableKeys.has(member.physicalProjectKey) &&
      !!member.stave.createdAt &&
      member.stave.state !== "archived";
    const action = await api.contextMenu.show(
      [
        { id: "add-member", label: "Add member", disabled: !enabled },
        { id: "archive-saga", label: "Archive saga", disabled: !enabled },
      ],
      position,
    );
    if (action === "add-member")
      openStaveWizard({
        environmentId: member.environmentId,
        kind: "space",
        saga: { root: member.workspaceRoot },
      });
    if (action === "archive-saga")
      setConfirmation({
        member,
        operation: {
          kind: "sagaArchive",
          sagaRoot: member.workspaceRoot,
          ...(member.stave.createdAt ? { expectedManifestCreatedAt: member.stave.createdAt } : {}),
          force: false,
          memory: "keep",
        },
      });
  };
  return (
    <section className="border-t border-border/60 px-2 py-2" aria-label="Sagas">
      <p className="px-2 pb-1 text-xs font-medium text-muted-foreground">Sagas</p>
      {sagas.map((node) => {
        const project = projects.find((candidate) => candidate.projectKey === node.group.key)!;
        const members = project.memberProjects.filter((member) =>
          enabledKeys.has(member.physicalProjectKey),
        );
        const closed = collapsed.has(project.projectKey);
        return (
          <div key={project.projectKey}>
            <div className="flex items-center gap-1">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`${closed ? "Expand" : "Collapse"} ${project.displayName}`}
                aria-expanded={!closed}
                onClick={() =>
                  setCollapsed((previous) => {
                    const next = new Set(previous);
                    if (closed) next.delete(project.projectKey);
                    else next.add(project.projectKey);
                    return next;
                  })
                }
              >
                {closed ? <ChevronRightIcon /> : <ChevronDownIcon />}
              </Button>
              <button
                data-lecturn-hover
                className="min-w-0 flex-1 truncate text-left text-xs"
                onClick={() => onOpen(project)}
                onContextMenu={(event) => {
                  if (members.length === 1) {
                    event.preventDefault();
                    void menu(members[0]!, { x: event.clientX, y: event.clientY });
                  }
                }}
              >
                {project.displayName}
              </button>
              <StaveLifecycleBadge
                notices={project.memberProjects.map((member) => member.notice)}
              />
              {members.map((member) => (
                <Button
                  key={member.physicalProjectKey}
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Saga actions for ${member.environmentLabel ?? member.workspaceRoot}`}
                  onClick={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    void menu(member, { x: rect.left, y: rect.bottom });
                  }}
                >
                  <MoreHorizontalIcon />
                </Button>
              ))}
            </div>
            {!closed ? (
              <div className="ml-5 border-l border-border/60 pl-2">
                {node.children.map((child) => {
                  const target = projects.find(
                    (candidate) => candidate.projectKey === child.group.key,
                  )!;
                  return (
                    <button
                      data-lecturn-hover
                      key={child.group.key}
                      className="flex w-full flex-wrap items-center gap-1 rounded px-1 py-1.5 text-left text-xs hover:bg-accent"
                      onClick={() => onOpen(target)}
                    >
                      <span className="mr-auto truncate">{target.displayName}</span>
                      <StaveLifecycleBadge
                        notices={target.memberProjects.map((member) => member.notice)}
                      />
                      {child.memberStatus
                        ? staveSagaMemberBadges(child.memberStatus).map((badge) => (
                            <Badge key={badge} variant={badge === "dirty" ? "warning" : "outline"}>
                              {badge}
                            </Badge>
                          ))
                        : null}
                    </button>
                  );
                })}
                {node.children.length === 0 ? (
                  <p className="py-1 text-xs text-muted-foreground">No open member projects.</p>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {confirmation ? (
        <StaveConfirmDialog
          environmentId={confirmation.member.environmentId}
          title="Archive saga"
          operation={confirmation.operation}
          onClose={() => setConfirmation(null)}
          onFinished={() => {}}
        />
      ) : null}
    </section>
  );
}
