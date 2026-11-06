import { describe, expect, it } from "vitest";
import { calculateMenuPosition } from "../../src/content/menu-position";

describe("menu positioning", () => {
  it("opens below the field when there is enough room", () => {
    expect(calculateMenuPosition({ left: 40, right: 340, top: 80, bottom: 120 },
      { width: 420, height: 300 }, { width: 1000, height: 800 }))
      .toMatchObject({ left: 40, top: 128 });
  });

  it("flips above a field near the bottom and clamps horizontal overflow", () => {
    const position = calculateMenuPosition({ left: 850, right: 980, top: 680, bottom: 720 },
      { width: 420, height: 300 }, { width: 1000, height: 800 });
    expect(position.left).toBe(568);
    expect(position.top).toBe(372);
  });

  it("reduces the available form height in a constrained viewport", () => {
    const position = calculateMenuPosition({ left: 20, right: 300, top: 300, bottom: 340 },
      { width: 420, height: 620 }, { width: 500, height: 500 });
    expect(position.maxHeight).toBe(280);
    expect(position.top).toBe(12);
  });

  it.each([null, { left: -500, right: -100, top: 50, bottom: 90 }])(
    "centers the menu without a visible anchor", (anchor) => {
      expect(calculateMenuPosition(anchor, { width: 420, height: 300 }, { width: 1000, height: 800 }))
        .toEqual({ left: 290, top: 250, maxHeight: 776 });
    },
  );

  it("keeps a menu inside a small iframe viewport", () => {
    const position = calculateMenuPosition({ left: 0, right: 100, top: 100, bottom: 150 },
      { width: 276, height: 400 }, { width: 300, height: 220 });
    expect(position.left).toBeGreaterThanOrEqual(12);
    expect(position.top).toBeGreaterThanOrEqual(12);
    expect(position.top + Math.min(position.maxHeight, 400)).toBeLessThanOrEqual(208);
  });
});
