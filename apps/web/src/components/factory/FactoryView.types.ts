export interface FactoryOption {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly disabled?: boolean;
}

export interface FactorySourceOption extends FactoryOption {
  readonly url: string;
}

export interface FactoryForm {
  readonly projectId: string;
  readonly sourceId: string;
  readonly executorId: string;
  readonly modelId: string;
  readonly baseBranch: string;
  readonly constraints: string;
  readonly runtimeMode: "approval-required" | "full-access";
}

export interface FactoryRunSummary {
  readonly id: string;
  readonly title: string;
  readonly sourceLabel: string;
  readonly projectLabel: string;
  readonly statusLabel: string;
  readonly statusTone: "neutral" | "working" | "attention" | "error" | "success";
}

export interface FactoryRun extends FactoryRunSummary {
  readonly statusDescription: string;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly reportedPhase: string | null;
  readonly phaseDetail?: string | undefined;
  readonly connectionLabel?: string | undefined;
  readonly pullRequest: { readonly label: string; readonly url: string } | null;
  readonly evidence: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly text: string;
  }>;
  readonly canSteer: boolean;
  readonly canInterrupt: boolean;
}

/** Pure display contract. The controller owns all execution and persistence. */
export interface FactoryViewProps {
  readonly form: FactoryForm;
  readonly projects: ReadonlyArray<FactoryOption>;
  readonly sources: ReadonlyArray<FactorySourceOption>;
  readonly executors: ReadonlyArray<FactoryOption>;
  readonly models: ReadonlyArray<FactoryOption>;
  readonly launchPending: boolean;
  readonly launchDisabledReason: string | null;
  readonly launchError: string | null;
  readonly recovery: { readonly message: string; readonly canInspect: boolean } | null;
  readonly run: FactoryRun | null;
  readonly runs: ReadonlyArray<FactoryRunSummary>;
  readonly steerPending: boolean;
  readonly interruptPending: boolean;
  readonly actionError: string | null;
  readonly actionNotice?: string | null | undefined;
  readonly onFormChange: (patch: Partial<FactoryForm>) => void;
  readonly onLaunch: () => void;
  readonly onSelectRun: (id: string) => void;
  readonly onNewRun: () => void;
  readonly onOpenConversation: () => void;
  readonly onInspectRecovery: () => void;
  readonly onReleaseRecovery: () => void;
  readonly onSteer: (text: string) => Promise<boolean>;
  readonly onInterrupt: () => void;
}
