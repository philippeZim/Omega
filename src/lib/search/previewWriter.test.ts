import { describe, expect, it, vi } from "vitest";
import { previewWriter } from "./previewWriter";

describe("preview writer", () => {
  it("flush without an edit writes nothing (a file changed on disk is not overwritten)", () => {
    const write = vi.fn();
    previewWriter(write).flush();
    expect(write).not.toHaveBeenCalled();
  });

  it("flush writes a pending edit once, right away", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const w = previewWriter(write);
    w.schedule("/a.txt", () => "edited");
    w.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith("/a.txt", "edited");
    vi.runAllTimers();
    expect(write).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("writes after the delay and not again on a later flush", () => {
    vi.useFakeTimers();
    const write = vi.fn();
    const w = previewWriter(write);
    w.schedule("/a.txt", () => "edited");
    vi.advanceTimersByTime(600);
    expect(write).toHaveBeenCalledOnce();
    w.flush();
    expect(write).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
