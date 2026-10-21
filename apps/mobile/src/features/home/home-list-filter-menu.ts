import { accountForEnvironment, type AccountSectionContext } from "./accountSections";
import type { EnvironmentId } from "@lecturn/contracts";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

type HomeListFilterMenuAction = {
  readonly type: "action";
  readonly title: string;
  readonly subtitle?: string;
  readonly state?: "on" | "off";
  readonly onPress: () => void;
};

type HomeListFilterMenuSubmenu = {
  readonly type: "submenu";
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
};

export interface HomeListFilterMenu {
  readonly title: string;
  readonly items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu>;
}

export function buildHomeListFilterMenu(props: {
  readonly accountSections?: AccountSectionContext | undefined;
  readonly accountAttention?: ReadonlyMap<string, string> | undefined;
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
}): HomeListFilterMenu {
  const items: Array<HomeListFilterMenuAction | HomeListFilterMenuSubmenu> = [];

  items.push({
    type: "submenu",
    title: "Environment",
    items: [
      {
        type: "action",
        title: "All environments",
        subtitle: "Show threads from every environment",
        state: props.selectedEnvironmentId === null ? "on" : "off",
        onPress: () => props.onEnvironmentChange(null),
      },
      ...(props.accountSections
        ? groupAccountFilterEnvironments(
            props.environments,
            props.accountSections,
            props.accountAttention,
          ).map((group) => ({
            type: "submenu" as const,
            title: group.label,
            items: group.environments.map((environment) => ({
              type: "action" as const,
              title: environment.label,
              state:
                props.selectedEnvironmentId === environment.environmentId
                  ? ("on" as const)
                  : ("off" as const),
              onPress: () => props.onEnvironmentChange(environment.environmentId),
            })),
          }))
        : props.environments.map((environment) => ({
            type: "action" as const,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onEnvironmentChange(environment.environmentId),
          }))),
    ],
  });

  if (props.projects.length > 0) {
    items.push({
      type: "submenu",
      title: "Project",
      items: [
        {
          type: "action",
          title: "All projects",
          subtitle: "Show threads from every project",
          state: props.selectedProjectKey === null ? "on" : "off",
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          type: "action" as const,
          title: project.label,
          state: props.selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return {
    title: "Thread list options",
    items,
  };
}

export function groupAccountFilterEnvironments(
  environments: ReadonlyArray<HomeListFilterMenuEnvironment>,
  context: AccountSectionContext,
  attention?: ReadonlyMap<string, string>,
) {
  return [...context.accounts, null]
    .map((account) => ({
      id: account?.accountId ?? "direct",
      label: [
        account?.label ?? "Direct connections",
        account && !account.signedIn ? "Sign in again" : "",
        account ? attention?.get(account.accountId) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      environments: environments.filter(
        (environment) =>
          accountForEnvironment(context, environment.environmentId) ===
          (account?.accountId ?? null),
      ),
    }))
    .filter((group) => group.environments.length > 0);
}
