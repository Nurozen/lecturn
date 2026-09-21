function dataFromNotificationResponse(response: unknown): Record<string, unknown> | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const content = (request as { readonly content?: unknown }).content;
  if (typeof content !== "object" || content === null) {
    return null;
  }
  const data = (content as { readonly data?: unknown }).data;
  return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : null;
}

function identifierFromNotificationResponse(response: unknown): string | null {
  if (typeof response !== "object" || response === null) {
    return null;
  }
  const notification = (response as { readonly notification?: unknown }).notification;
  if (typeof notification !== "object" || notification === null) {
    return null;
  }
  const request = (notification as { readonly request?: unknown }).request;
  if (typeof request !== "object" || request === null) {
    return null;
  }
  const identifier = (request as { readonly identifier?: unknown }).identifier;
  return typeof identifier === "string" ? identifier : null;
}

function encodeThreadDeepLink(input: {
  readonly environmentId: string;
  readonly threadId: string;
}): string | null {
  if (input.environmentId.length === 0 || input.threadId.length === 0) {
    return null;
  }
  return `/threads/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(input.threadId)}`;
}

function normalizeThreadDeepLink(value: string): string | null {
  if (
    value.trim() !== value ||
    value.startsWith("//") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  const parts = value.split("/");
  if (parts.length !== 4 || parts[0] !== "" || parts[1] !== "threads") {
    return null;
  }

  try {
    return encodeThreadDeepLink({
      environmentId: decodeURIComponent(parts[2] ?? ""),
      threadId: decodeURIComponent(parts[3] ?? ""),
    });
  } catch {
    return null;
  }
}

export function extractAgentNotificationDeepLink(response: unknown): string | null {
  const data = dataFromNotificationResponse(response);
  const deepLink = data?.deepLink;
  if (typeof deepLink === "string") {
    const normalizedDeepLink = normalizeThreadDeepLink(deepLink);
    if (normalizedDeepLink) {
      return normalizedDeepLink;
    }
  }

  const environmentId = data?.environmentId;
  const threadId = data?.threadId;
  if (typeof environmentId === "string" && typeof threadId === "string") {
    return encodeThreadDeepLink({ environmentId, threadId });
  }
  return null;
}

export function routeAgentNotificationResponseOnce(input: {
  readonly handledResponseIds: Set<string>;
  readonly response: unknown;
  readonly navigate: (deepLink: string) => void;
  readonly accountContext?: {
    readonly signedInAccountIds: ReadonlyArray<string>;
    readonly accountByEnvironmentId: ReadonlyMap<string, string>;
    readonly requestSignIn: (accountId: string) => void;
    readonly expandAccount?: (accountId: string) => void;
  };
}): "handled" | "deferred" {
  const responseId = identifierFromNotificationResponse(input.response);
  if (responseId && input.handledResponseIds.has(responseId)) {
    return "handled";
  }
  const deepLink = extractAgentNotificationDeepLink(input.response);
  if (deepLink) {
    if (input.accountContext) {
      const environmentId = decodeURIComponent(deepLink.split("/")[2]!);
      const rawAccountId = dataFromNotificationResponse(input.response)?.accountId;
      const owner = input.accountContext.accountByEnvironmentId.get(environmentId);
      const accountId =
        typeof rawAccountId === "string" && rawAccountId.length > 0 ? rawAccountId : owner;
      // Explicit ownership always wins over whichever account happens to be active.
      if (!accountId) return "deferred";
      if (!input.accountContext.signedInAccountIds.includes(accountId)) {
        input.accountContext.requestSignIn(accountId);
        return "deferred";
      }
      if (!owner) return "deferred";
      if (owner !== accountId) {
        if (responseId) input.handledResponseIds.add(responseId);
        return "handled";
      }
      input.accountContext.expandAccount?.(accountId);
      input.navigate(`${deepLink}?accountId=${encodeURIComponent(accountId)}`);
      if (responseId) input.handledResponseIds.add(responseId);
      return "handled";
    }
    input.navigate(deepLink);
  }
  if (responseId) input.handledResponseIds.add(responseId);
  return "handled";
}
