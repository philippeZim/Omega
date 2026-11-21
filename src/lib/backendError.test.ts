import { afterEach, describe, expect, test } from "vitest";
import { setLocale } from "./i18n/index.svelte";
import { backendErrorText } from "./backendError";

afterEach(() => setLocale("en"));

describe("backendErrorText (#99)", () => {
  test("codes from installs.rs / tools.rs / proc.rs become translated text with their detail", () => {
    expect(backendErrorText("installs:not_ours:Rust")).toBe("Rust was not installed by Omega");
    expect(backendErrorText("tools:download_failed:https://x/y.zip: 404")).toBe("Download failed (https://x/y.zip: 404)");
    expect(backendErrorText("proc:not_connected")).toBe("Not connected");
    expect(backendErrorText(new Error("proc:not_found:Python"))).toBe("Python not found");
    setLocale("de");
    expect(backendErrorText("proc:not_connected")).toBe("Verbindung besteht nicht");
    setLocale("fr");
    expect(backendErrorText("installs:unknown_manager")).toBe("gestionnaire de paquets inconnu");
  });

  test("unknown codes and other errors pass through unchanged", () => {
    expect(backendErrorText("proc:weird_code")).toBe("proc:weird_code");
    expect(backendErrorText("No such file or directory (os error 2)")).toBe("No such file or directory (os error 2)");
    expect(backendErrorText("XCODE_CLT")).toBe("XCODE_CLT");
  });
});
