import { useConnectSignIn } from "./useConnectSignIn";

/**
 * "Sign in again" on a sidebar account bar. Loaded lazily, so a client without
 * Lecturn Connect never downloads Clerk for it.
 */
export default function SidebarSignInAgainButton({ accountId }: { readonly accountId: string }) {
  const { authPrompt, signInAgainAs } = useConnectSignIn();
  return (
    <>
      <button
        type="button"
        data-lecturn-hover
        className="shrink-0 cursor-pointer rounded px-1 text-[0.6875rem] font-medium text-warning hover:bg-sidebar-row-hover"
        onClick={() => signInAgainAs(accountId)}
      >
        Sign in again
      </button>
      {authPrompt}
    </>
  );
}
