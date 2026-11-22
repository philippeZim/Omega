import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { wheelFactor, wheelZoom } from "./wheelZoom";

beforeEach(() => void vi.useFakeTimers());
afterEach(() => void vi.useRealTimers());

/** The test DOM's WheelEvent drops the modifier keys. */
const wheelEvent = (o: { deltaY: number; deltaMode?: number; clientX?: number; clientY?: number; ctrlKey?: boolean }) =>
  Object.assign(new Event("wheel", { bubbles: true, cancelable: true }), { deltaMode: 0, clientX: 0, clientY: 0, ctrlKey: true, ...o });

const setup = (start = 1) => {
  const el = document.createElement("div");
  let scale = start;
  const apply = vi.fn((s: number) => void (scale = s));
  const stop = wheelZoom(el, { scale: () => scale, min: 0.5, max: 2, apply });
  const wheel = (deltaY: number, o: { ctrlKey?: boolean } = {}) => {
    const e = wheelEvent({ deltaY, ...o });
    el.dispatchEvent(e);
    return e;
  };
  return { apply, stop, wheel, scale: () => scale };
};

test("in and out cancel each other, and a notch is about one button step", () => {
  expect(wheelFactor(100, 0) * wheelFactor(-100, 0)).toBeCloseTo(1);
  expect(wheelFactor(-100, 0)).toBeCloseTo(1.25, 1);
  expect(wheelFactor(-3, 1)).toBeCloseTo(wheelFactor(-48, 0)); // lines
});

test("a burst of events causes one change with all deltas added up", () => {
  const { apply, wheel } = setup();
  for (let i = 0; i < 100; i++) wheel(-1);
  expect(apply).not.toHaveBeenCalled();
  vi.advanceTimersByTime(20);
  expect(apply).toHaveBeenCalledTimes(1);
  expect(apply.mock.calls[0][0]).toBeCloseTo(wheelFactor(-100, 0), 5);
});

test("stops at the limits, and at a limit does nothing", () => {
  const { apply, wheel, scale } = setup();
  for (let i = 0; i < 50; i++) wheel(-300);
  vi.advanceTimersByTime(20);
  expect(scale()).toBe(2);
  apply.mockClear();
  wheel(-300);
  vi.advanceTimersByTime(20);
  expect(apply).not.toHaveBeenCalled();
});

test("a plain wheel is left alone", () => {
  const { apply, wheel } = setup();
  expect(wheel(100, { ctrlKey: false }).defaultPrevented).toBe(false);
  vi.advanceTimersByTime(20);
  expect(apply).not.toHaveBeenCalled();
});

test("stopping drops what was pending", () => {
  const { apply, wheel, stop } = setup();
  wheel(-100);
  stop();
  vi.advanceTimersByTime(20);
  expect(apply).not.toHaveBeenCalled();
});
