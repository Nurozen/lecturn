/** The page a guest link opens. It shows one shared thread to a browser with no Lecturn session. */
export const GUEST_PAGE_PATH = "/guest";

export function isGuestPage(): boolean {
  return window.location.pathname === GUEST_PAGE_PATH;
}
