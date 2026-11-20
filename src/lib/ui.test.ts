import { describe, expect, it } from "vitest";
import { ui } from "./ui.svelte";

describe("dialog queue", () => {
  it("a question arriving while a prompt is open waits instead of cancelling the prompt", async () => {
    const name = ui.prompt("New File");
    const conflict = ui.choose("a.txt changed on disk", "", [
      { label: "Keep mine", value: "keep" },
      { label: "Reload", value: "reload", primary: true },
    ]);
    expect(ui.dialog?.title).toBe("New File");
    ui.closeDialog("ok", "half-typed-name.txt");
    expect(await name).toBe("half-typed-name.txt");
    expect(ui.dialog?.title).toBe("a.txt changed on disk");
    ui.closeDialog("reload");
    expect(await conflict).toBe("reload");
    expect(ui.dialog).toBeNull();
  });
});
