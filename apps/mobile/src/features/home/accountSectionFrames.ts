/** Fragment boundaries let a virtualized list draw one continuous section frame. */
export interface AccountSectionFrame {
  readonly first: boolean;
  readonly last: boolean;
}

export function accountSectionFrames(
  items: ReadonlyArray<{ readonly key: string; readonly type: string }>,
): ReadonlyMap<string, AccountSectionFrame> {
  return new Map(
    items.map((item, index) => [
      item.key,
      {
        first: index === 0 || item.type === "account-header",
        last: index === items.length - 1 || items[index + 1]?.type === "account-header",
      },
    ]),
  );
}
