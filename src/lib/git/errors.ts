/** Turns git's output of a failed command into the one-line reason shown in a toast. */
export function gitErrorMessage(out: { stdout: string; stderr: string }): string {
  const lines = (out.stderr || out.stdout).split("\n").map((l) => l.trim()).filter(Boolean);
  // The cause is on the "fatal:"/"error:" lines; "hint:" lines and the generic advice after them
  // ("Please make sure you have the correct access rights …") only bury it.
  const errors = lines.filter((l) => /^(fatal|error):/i.test(l)).map((l) => l.replace(/^(fatal|error):\s*/i, ""));
  if (errors.length) return errors.join(" ");
  return lines.filter((l) => !/^hint:/i.test(l)).slice(-2).join(" ");
}
