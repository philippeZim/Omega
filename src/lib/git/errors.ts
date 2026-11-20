/** Turns git's output of a failed command into the one-line reason shown in a toast. */
export function gitErrorMessage(out: { stdout: string; stderr: string }): string {
  const lines = (out.stderr || out.stdout).split("\n").map((l) => l.trim().replace(/\s+/g, " ")).filter(Boolean);
  // The cause is on the "fatal:"/"error:" lines; "hint:" lines and the generic advice after them
  // ("Please make sure you have the correct access rights …") only bury it. For pushes the server's
  // own "remote: error:" lines and the "! [rejected] …" ref lines say more than the closing
  // "error: failed to push some refs", so they come first.
  const remote = lines.filter((l) => /^remote: (fatal|error):/i.test(l)).map((l) => l.replace(/^remote: (fatal|error):\s*/i, ""));
  const refs = lines.filter((l) => /^! \[(remote )?rejected\]/.test(l)).map((l) => l.replace(/^! /, ""));
  const local = lines.filter((l) => /^(fatal|error):/i.test(l)).map((l) => l.replace(/^(fatal|error):\s*/i, ""));
  const causes = [...remote, ...refs, ...local];
  // At most three lines: a toast, not a log.
  if (causes.length) return causes.slice(0, 3).join(" ");
  return lines.filter((l) => !/^hint:/i.test(l)).slice(-2).join(" ");
}
