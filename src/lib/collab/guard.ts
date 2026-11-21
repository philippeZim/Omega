/**
 * What a collab guest may not do locally. A leaf module (no state or transport imports), so the
 * app state can ask it without loading the session; collab.svelte.ts plugs in the live status.
 */
import { ui } from "../ui.svelte";
import { t } from "../i18n/index.svelte";

/** What the host can allow per guest. Enforced on the host (rpc.svelte.ts); guests only mirror it. */
export const CAPABILITIES = ["edit", "run", "packages", "git", "git-remote", "debug", "terminal"] as const;
export type Capability = (typeof CAPABILITIES)[number];
/** `terminal` is a full shell on the host's machine, so it needs an explicit grant. */
export const DEFAULT_CAPABILITIES: Capability[] = CAPABILITIES.filter((c) => c !== "terminal");

export const guestGuard = {
  /** "pending": joining or waiting for approval. */
  status: (): "none" | "pending" | "connected" => "none",
  /** Whether this instance is hosting (or starting to host) a session. */
  hosting: (): boolean => false,
  /** Whether the host allows this (always true when not a guest). */
  can: (_cap: Capability): boolean => true,
};

export const guestCan = (cap: Capability) => guestGuard.can(cap);

/** Whether this guest may stop the host's task: `run` any, `packages` only a package task. */
export const guestCanStop = (task: { packages?: boolean } | null | undefined) => guestCan("run") || (guestCan("packages") && !!task?.packages);

/** Stops an action the host turned off for this guest. Returns true (after saying so) to stop. */
export function blockedByCapability(cap: Capability): boolean {
  if (guestGuard.can(cap)) return false;
  ui.toast(t("ai.collab.capMissing", { cap: t(`ai.collab.cap.${cap}`) }), "error");
  return true;
}

/** Hosting already: starting or joining a session would replace the running one. */
export function blockedWhileHosting(): boolean {
  if (!guestGuard.hosting()) return false;
  ui.toast(t("ai.collab.alreadyHosting"), "error");
  return true;
}

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
