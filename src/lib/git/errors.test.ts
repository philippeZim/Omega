import { describe, expect, test } from "vitest";
import { gitErrorMessage } from "./errors";

describe("gitErrorMessage", () => {
  test("shows the fatal line, not the trailing hints", () => {
    const stderr = [
      "fatal: 'feature/bad-name..x' is not a valid branch name",
      "hint: See 'git help check-ref-format'",
      "hint: Disable this message with \"git config set advice.refSyntax false\"",
    ].join("\n");
    expect(gitErrorMessage({ stdout: "", stderr })).toBe("'feature/bad-name..x' is not a valid branch name");
  });

  test("push without a remote names the missing remote", () => {
    const stderr = [
      "fatal: 'origin' does not appear to be a git repository",
      "fatal: Could not read from remote repository.",
      "",
      "Please make sure you have the correct access rights",
      "and the repository exists.",
    ].join("\n");
    expect(gitErrorMessage({ stdout: "", stderr })).toBe("'origin' does not appear to be a git repository Could not read from remote repository.");
  });

  test("error: lines win over other output", () => {
    const stderr = "error: could not apply afda55c... local c\nhint: Resolve all conflicts manually\nRecorded preimage for 'c.txt'";
    expect(gitErrorMessage({ stdout: "", stderr })).toBe("could not apply afda55c... local c");
  });

  test("without fatal/error lines: last two non-hint lines, falling back to stdout", () => {
    expect(gitErrorMessage({ stdout: "a\nb\nc\nhint: x", stderr: "" })).toBe("b c");
  });
});
