import { expect, it, vi } from "vite-plus/test";
import type { RelayBillingStatus } from "@t3tools/contracts";
import { createBillingStatusLoader } from "./billingStatusLoader";

function deferred() {
  let resolve!: (value: RelayBillingStatus) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<RelayBillingStatus>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const status = (hasAccess: boolean) => ({ hasAccess }) as RelayBillingStatus;

it("keeps the newest refresh when an older request completes late", async () => {
  const old = deferred();
  const current = deferred();
  const publish = { status: vi.fn(), error: vi.fn() };
  const loader = createBillingStatusLoader(
    {
      getStatus: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise),
      reconcile: vi.fn(),
    },
    publish,
  );
  const first = loader.refresh();
  const second = loader.refresh();
  current.resolve(status(true));
  await second;
  old.resolve(status(false));
  await first;
  expect(publish.status.mock.calls).toEqual([[status(true)]]);
});

it("does not publish another account's pending status or error after disposal", async () => {
  const pending = deferred();
  const publish = { status: vi.fn(), error: vi.fn() };
  const loader = createBillingStatusLoader(
    { getStatus: () => pending.promise, reconcile: vi.fn() },
    publish,
  );
  const request = loader.refresh();
  loader.dispose();
  pending.reject(new Error("old session"));
  await request;
  expect(publish.status).not.toHaveBeenCalled();
  expect(publish.error).not.toHaveBeenCalled();
});

it("reconciles a hosted Checkout return and permits subsequent ordinary refresh", async () => {
  const publish = { status: vi.fn(), error: vi.fn() };
  const client = {
    getStatus: vi.fn().mockResolvedValue(status(true)),
    reconcile: vi.fn().mockRejectedValue(new Error("pending")),
  };
  const loader = createBillingStatusLoader(client, publish);
  await loader.refresh("cs_return");
  await loader.refresh();
  expect(client.reconcile).toHaveBeenCalledWith("cs_return");
  expect(publish.error).toHaveBeenCalledOnce();
  expect(publish.status).toHaveBeenCalledWith(status(true));
});
