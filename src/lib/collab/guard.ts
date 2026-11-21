/**
 * What a collab guest may not do locally. A leaf module (no state or transport imports), so the
 * app state can ask it without loading the session; collab.svelte.ts plugs in the live status.
 */
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

export const guestGuard = {
  /** "pending": joining or waiting for approval. */
  status: (): "none" | "pending" | "connected" => "none",
};

/**
 * Opening another project or session would mix it into the guest's view of the host's project.
 * Returns true (after telling the user) when the action has to stop.
 */
export function blockedAsGuest(): boolean {
  if (guestGuard.status() === "none") return false;
  ui.toast(t("ai.collab.leaveFirst"), "error");
  return true;
}

/**
 * For flows that were already running when the user became a guest (clone, new project): their
 * result stays on disk but must not open in the session. Returns true (after saying so) to stop.
 */
export function keptOutOfSession(path: string): boolean {
  if (guestGuard.status() === "none") return false;
  ui.toast(t("ai.collab.createdNotOpened", { path }));
  return true;
}

/** Title for a shell on the guest's own machine, so nobody takes it for the host's. */
export const localTerminalTitle = () => (guestGuard.status() === "none" ? undefined : t("code.term.localTitle"));
