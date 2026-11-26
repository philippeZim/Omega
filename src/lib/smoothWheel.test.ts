import { describe, expect, test } from "vitest";
import { LINES_PER_NOTCH, OMEGA, notchDelta, springStep, wheelDistance } from "./smoothWheel";

const wheel = (deltaY: number, o: Partial<WheelEvent> = {}) =>
  ({ deltaX: 0, deltaY, deltaMode: 0, ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, ...o }) as WheelEvent;

describe("springStep", () => {
  test("settles on the target without overshoot", () => {
    let d = 159, v = 0, min = d;
    for (let i = 0; i < 30; i++) {
      [d, v] = springStep(d, v, OMEGA, 1 / 60);
      min = Math.min(min, d);
    }
    expect(Math.abs(d)).toBeLessThan(0.5);
    expect(min).toBeGreaterThan(-0.01);
  });

  test("is independent of the frame rate", () => {
    let a: [number, number] = [100, 0];
    let b: [number, number] = [100, 0];
    for (let i = 0; i < 6; i++) a = springStep(a[0], a[1], OMEGA, 1 / 60);
    for (let i = 0; i < 12; i++) b = springStep(b[0], b[1], OMEGA, 1 / 120);
    expect(a[0]).toBeCloseTo(b[0], 6);
  });
});

describe("notchDelta", () => {
  test("a wheel notch is animated", () => expect(notchDelta(wheel(159), Infinity)).toBe(159));
  test("line mode counts lines", () => expect(notchDelta(wheel(3, { deltaMode: 1 }), Infinity)).toBe(159));
  test("touchpad deltas stay native", () => expect(notchDelta(wheel(6), Infinity)).toBe(0));
  test("a big delta inside a touchpad gesture stays native", () => expect(notchDelta(wheel(80), 30)).toBe(0));
  test("modifiers and sideways scrolling stay native", () => {
    expect(notchDelta(wheel(159, { ctrlKey: true }), Infinity)).toBe(0);
    expect(notchDelta(wheel(159, { shiftKey: true }), Infinity)).toBe(0);
    expect(notchDelta(wheel(159, { deltaX: 20 }), Infinity)).toBe(0);
  });
});

describe("wheelDistance", () => {
  test("a notch moves LINES_PER_NOTCH lines of the scrolled text", () => {
    expect(wheelDistance(159, 23)).toBeCloseTo(LINES_PER_NOTCH * 23);
    expect(wheelDistance(-159, 27)).toBeCloseTo(-LINES_PER_NOTCH * 27);
  });
  test("a raised system scroll factor still scales it", () => expect(wheelDistance(318, 20)).toBeCloseTo(2 * LINES_PER_NOTCH * 20));
});
