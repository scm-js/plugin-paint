import { describe, expect, it } from "vitest";
import {
  boxFromCenter, cellOf, constrainAngle, constrainSquare, dedupePoints, ellipsePath, fillCells, fillPoints, insidePolygon, jitterPoints, linePath,
  pathLength, rectPath, samplePath, sprayPoints, starPath, strokeCells, textCells, textSize, uniqueCells,
  type Cell, type Point, type Rng,
} from "../shapes";
import { GLYPHS } from "../font";

/** mulberry32 — a small seeded generator so the random patterns are reproducible. */
function seeded(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const P = (x: number, y: number): Point => ({ x, y });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const inBox = (p: Point, x0: number, y0: number, x1: number, y1: number) => p.x >= x0 - 1e-9 && p.x <= x1 + 1e-9 && p.y >= y0 - 1e-9 && p.y <= y1 + 1e-9;
const key = (c: Cell) => `${c.x},${c.y}`;

describe("outlines", () => {
  it("rectPath is closed with the four corners of the box, whatever order the corners come in", () => {
    const path = rectPath(P(100, 50), P(20, 90));
    expect(path.closed).toBe(true);
    expect(path.points).toEqual([P(20, 50), P(100, 50), P(100, 90), P(20, 90)]);
    expect(linePath(P(1, 2), P(3, 4)).closed).toBe(false);
  });

  it("ellipsePath is closed, has the asked segments and stays inside the box", () => {
    const path = ellipsePath(P(200, 100), P(0, 0), 48);
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(48);
    for (const p of path.points) expect(inBox(p, 0, 0, 200, 100)).toBe(true);
    expect(ellipsePath(P(0, 0), P(10, 10)).points).toHaveLength(96);
    // The extremes are touched: rightmost and bottommost points sit on the box.
    expect(Math.max(...path.points.map((p) => p.x))).toBeCloseTo(200);
    expect(Math.max(...path.points.map((p) => p.y))).toBeCloseTo(100);
  });

  it("starPath with innerRatio 1 is a regular polygon: `points` vertices at `radius`, equidistant, first one straight up", () => {
    const c = P(100, 100);
    const path = starPath(c, 50, 5, 1);
    expect(path.closed).toBe(true);
    expect(path.points).toHaveLength(5);
    for (const p of path.points) expect(dist(p, c)).toBeCloseTo(50);
    const side = dist(path.points[0]!, path.points[1]!);
    for (let i = 0; i < 5; i++) expect(dist(path.points[i]!, path.points[(i + 1) % 5]!)).toBeCloseTo(side);
    expect(path.points[0]!.x).toBeCloseTo(100);
    expect(path.points[0]!.y).toBeCloseTo(50);
  });

  it("starPath below 1 alternates outer and inner vertices", () => {
    const c = P(0, 0);
    const path = starPath(c, 100, 5, 0.5);
    expect(path.points).toHaveLength(10);
    path.points.forEach((p, i) => expect(dist(p, c)).toBeCloseTo(i % 2 ? 50 : 100));
    // Rotating by a quarter turn moves the first vertex from up to the right.
    const turned = starPath(c, 100, 4, 1, Math.PI / 2).points[0]!;
    expect(turned.x).toBeCloseTo(100);
    expect(turned.y).toBeCloseTo(0);
  });
});

describe("modifiers", () => {
  it("constrainSquare grows the shorter side and keeps the quadrant", () => {
    expect(constrainSquare(P(10, 10), P(50, 20))).toEqual(P(50, 50));
    expect(constrainSquare(P(10, 10), P(-20, 5))).toEqual(P(-20, -20));
    expect(constrainSquare(P(10, 10), P(15, -30))).toEqual(P(50, -30));
    expect(constrainSquare(P(0, 0), P(0, 8))).toEqual(P(8, 8));
  });

  it("constrainAngle snaps to 45° steps and keeps the length", () => {
    const a = P(0, 0);
    const flat = constrainAngle(a, P(100, 10));
    expect(flat.x).toBeCloseTo(Math.hypot(100, 10));
    expect(flat.y).toBeCloseTo(0);
    const diag = constrainAngle(a, P(100, 80));
    expect(diag.x).toBeCloseTo(diag.y);
    expect(dist(a, diag)).toBeCloseTo(dist(a, P(100, 80)));
    const up = constrainAngle(a, P(-3, -100));
    expect(up.x).toBeCloseTo(0);
    expect(up.y).toBeCloseTo(-Math.hypot(3, 100));
    expect(constrainAngle(a, a)).toEqual(a);
  });

  it("boxFromCenter mirrors the corner through the centre", () => {
    expect(boxFromCenter(P(100, 100), P(130, 80))).toEqual([P(70, 120), P(130, 80)]);
  });
});

describe("sampling along", () => {
  it("pathLength counts the closing segment only when closed", () => {
    expect(pathLength(rectPath(P(0, 0), P(320, 320)))).toBe(1280);
    expect(pathLength({ points: [P(0, 0), P(320, 0), P(320, 320)], closed: false })).toBe(640);
  });

  it("an open 320-px line at spacing 32 gives 11 points including both ends", () => {
    const pts = samplePath(linePath(P(0, 0), P(320, 0)), 32);
    expect(pts).toHaveLength(11);
    expect(pts[0]).toEqual(P(0, 0));
    expect(pts[10]).toEqual(P(320, 0));
    for (let i = 1; i < pts.length; i++) expect(dist(pts[i - 1]!, pts[i]!)).toBeCloseTo(32);
  });

  it("an open path that does not divide evenly stretches the spacing so the last sample is the end", () => {
    const pts = samplePath(linePath(P(0, 0), P(0, 335)), 32); // 10.47 → 10 steps of 33.5
    expect(pts).toHaveLength(11);
    expect(pts.at(-1)).toEqual(P(0, 335));
    for (let i = 1; i < pts.length; i++) expect(dist(pts[i - 1]!, pts[i]!)).toBeCloseTo(33.5);
    expect(samplePath(linePath(P(0, 0), P(10, 0)), 32)).toEqual([P(0, 0), P(10, 0)]);
  });

  it("a closed square never repeats its start and turns the corners", () => {
    const pts = samplePath(rectPath(P(0, 0), P(320, 320)), 32);
    expect(pts).toHaveLength(40);
    expect(pts[0]).toEqual(P(0, 0));
    expect(pts.filter((p) => p.x === 0 && p.y === 0)).toHaveLength(1);
    expect(pts[10]).toEqual(P(320, 0));
    expect(pts[20]).toEqual(P(320, 320));
    expect(pts[30]).toEqual(P(0, 320));
    expect(pts[39]).toEqual(P(0, 32));
  });

  it("spacing 0 gives the vertices and a single point gives itself", () => {
    const square = rectPath(P(0, 0), P(10, 10));
    expect(samplePath(square, 0)).toEqual(square.points);
    expect(samplePath({ points: [P(5, 6)], closed: false }, 32)).toEqual([P(5, 6)]);
    expect(samplePath({ points: [], closed: false }, 32)).toEqual([]);
  });
});

describe("sampling inside", () => {
  const square = rectPath(P(0, 0), P(320, 320));
  // A "C": the square with a bite taken from its right side.
  const concave: Point[] = [P(0, 0), P(320, 0), P(320, 100), P(100, 100), P(100, 220), P(320, 220), P(320, 320), P(0, 320)];
  const concavePath = { points: concave, closed: true };

  it("insidePolygon on a square and on a concave shape", () => {
    expect(insidePolygon(P(160, 160), square.points)).toBe(true);
    expect(insidePolygon(P(400, 160), square.points)).toBe(false);
    expect(insidePolygon(P(-1, 160), square.points)).toBe(false);
    expect(insidePolygon(P(50, 160), concave)).toBe(true);
    expect(insidePolygon(P(200, 160), concave)).toBe(false); // in the bite
    expect(insidePolygon(P(200, 50), concave)).toBe(true);
    expect(insidePolygon(P(200, 300), concave)).toBe(true);
  });

  it("fillPoints grid on a 320×320 square at spacing 32 is 100: the lattice sits on the box origin and the top/left edges count as inside, bottom/right as outside", () => {
    const pts = fillPoints(square, 32, "grid", seeded(1));
    expect(pts).toHaveLength(100);
    expect(pts[0]).toEqual(P(0, 0));
    expect(pts.at(-1)).toEqual(P(288, 288));
    expect(pts.every((p) => p.x % 32 === 0 && p.y % 32 === 0)).toBe(true);
    expect(fillPoints({ ...square, closed: false }, 32, "grid", seeded(1))).toHaveLength(100);
  });

  it("fillPoints staggered alternates the half-spacing offset between rows", () => {
    const pts = fillPoints(square, 32, "staggered", seeded(1));
    const rows = [...new Set(pts.map((p) => p.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[1]! - rows[0]!).toBeCloseTo(32 * 0.866);
    rows.forEach((y, i) => {
      const xs = pts.filter((p) => p.y === y).map((p) => p.x);
      const offset = i % 2 ? 16 : 0;
      for (const x of xs) expect((x - offset) % 32).toBeCloseTo(0);
    });
    expect(pts.every((p) => insidePolygon(p, square.points))).toBe(true);
  });

  it("fillPoints random keeps 0.7·spacing apart, stays inside, and is deterministic under a seeded rng", () => {
    const a = fillPoints(concavePath, 32, "random", seeded(7));
    const b = fillPoints(concavePath, 32, "random", seeded(7));
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(30);
    expect(a.length).toBeLessThanOrEqual(Math.round((320 * 320 - 220 * 120) / 1024));
    for (const p of a) expect(insidePolygon(p, concave)).toBe(true);
    for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) expect(dist(a[i]!, a[j]!)).toBeGreaterThanOrEqual(0.7 * 32);
    expect(fillPoints(concavePath, 32, "random", seeded(8))).not.toEqual(a);
  });

  it("sprayPoints stays inside the radius, jitterPoints within ±amount, dedupePoints keeps the first", () => {
    const c = P(500, 500);
    const spray = sprayPoints(c, 40, 200, seeded(3));
    expect(spray).toHaveLength(200);
    for (const p of spray) expect(dist(p, c)).toBeLessThanOrEqual(40);
    expect(spray.some((p) => dist(p, c) > 30)).toBe(true);
    const jittered = jitterPoints(spray, 5, seeded(4));
    jittered.forEach((p, i) => {
      expect(Math.abs(p.x - spray[i]!.x)).toBeLessThanOrEqual(5);
      expect(Math.abs(p.y - spray[i]!.y)).toBeLessThanOrEqual(5);
    });
    expect(dedupePoints([P(0, 0), P(3, 0), P(10, 0), P(12, 0), P(0, 0)], 5)).toEqual([P(0, 0), P(10, 0)]);
    expect(dedupePoints([P(0, 0), P(0, 0)], 0)).toHaveLength(2);
  });
});

describe("cells", () => {
  it("cellOf floors by 32", () => {
    expect(cellOf(P(31.9, 32))).toEqual({ x: 0, y: 1 });
    expect(cellOf(P(-1, 64))).toEqual({ x: -1, y: 2 });
  });

  it("strokeCells of a horizontal 10-tile line: width 1 is 10 cells, width 3 is 36 (3 rows × 12 — the 3×3 brush overhangs one cell at each end), width 2 is 22 (2×2 anchored at each cell)", () => {
    const line = linePath(P(16, 16), P(304, 16)); // centres of cells 0 … 9 on row 0
    const w1 = strokeCells(line, 1);
    expect(w1).toHaveLength(10);
    expect(w1.map(key)).toEqual(Array.from({ length: 10 }, (_, i) => `${i},0`));
    const w3 = strokeCells(line, 3);
    expect(w3).toHaveLength(36);
    expect(new Set(w3.map((c) => c.y))).toEqual(new Set([-1, 0, 1]));
    expect(Math.min(...w3.map((c) => c.x))).toBe(-1);
    expect(Math.max(...w3.map((c) => c.x))).toBe(10);
    expect(w3[0]).toEqual({ x: -1, y: -1 }); // first-touched order: cell 0's footprint first, row-major
    const w2 = strokeCells(line, 2);
    expect(w2).toHaveLength(22);
    expect(new Set(w2.map((c) => c.y))).toEqual(new Set([0, 1]));
    expect(Math.min(...w2.map((c) => c.x))).toBe(0);
    expect(Math.max(...w2.map((c) => c.x))).toBe(10);
  });

  it("strokeCells width 5 is a 21-cell disc around a single point, and a closed path walks the closing segment", () => {
    expect(strokeCells({ points: [P(160, 160)], closed: false }, 5)).toHaveLength(21);
    expect(strokeCells({ points: [P(160, 160)], closed: false }, 1)).toEqual([{ x: 5, y: 5 }]);
    const square = strokeCells(rectPath(P(16, 16), P(112, 112)), 1); // cells 0..3 square outline
    expect(square).toHaveLength(12);
  });

  it("a diagonal line has no gaps: consecutive cells are 8-connected and no cell repeats", () => {
    const cells = strokeCells(linePath(P(10, 20), P(700, 300)), 1);
    expect(cells[0]).toEqual({ x: 0, y: 0 });
    expect(cells.at(-1)).toEqual({ x: 21, y: 9 });
    for (let i = 1; i < cells.length; i++) {
      expect(Math.abs(cells[i]!.x - cells[i - 1]!.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(cells[i]!.y - cells[i - 1]!.y)).toBeLessThanOrEqual(1);
    }
    expect(new Set(cells.map(key)).size).toBe(cells.length);
    expect(cells).toHaveLength(22);
  });

  it("fillCells of a 4×4-tile square is 16, row-major, and uniqueCells drops repeats", () => {
    const cells = fillCells(rectPath(P(0, 0), P(128, 128)));
    expect(cells).toHaveLength(16);
    expect(cells[0]).toEqual({ x: 0, y: 0 });
    expect(cells[1]).toEqual({ x: 1, y: 0 });
    expect(cells[15]).toEqual({ x: 3, y: 3 });
    expect(fillCells(ellipsePath(P(0, 0), P(128, 128))).length).toBeLessThan(16);
    expect(uniqueCells([{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 1, y: 1 }])).toEqual([{ x: 1, y: 1 }, { x: 2, y: 1 }]);
  });
});

describe("text", () => {
  const glyphCells = (glyph: readonly string[], dx = 0, dy = 0): Cell[] => {
    const out: Cell[] = [];
    glyph.forEach((row, y) => [...row].forEach((ch, x) => ch === "#" && out.push({ x: x + dx, y: y + dy })));
    return out;
  };

  it("textCells('A') matches the font glyph and lowercase maps up", () => {
    expect(textCells("A")).toEqual(glyphCells(GLYPHS.A!));
    expect(textCells("a")).toEqual(textCells("A"));
  });

  it("glyphs advance 6 columns, lines 8 rows, and the output is row-major", () => {
    const ab = textCells("AB");
    const expected = [...glyphCells(GLYPHS.A!), ...glyphCells(GLYPHS.B!, 6)].sort((p, q) => p.y - q.y || p.x - q.x);
    expect(ab).toEqual(expected);
    const stacked = textCells("A\nB");
    expect(stacked).toEqual([...glyphCells(GLYPHS.A!), ...glyphCells(GLYPHS.B!, 0, 8)]);
    // An unknown character is a blank glyph that still takes its width.
    expect(textCells("~A")).toEqual(glyphCells(GLYPHS.A!, 6));
  });

  it("textSize: 'AB' is 11×7; 'A\\nB' is 5×15 (two 7-row lines, one blank row between)", () => {
    expect(textSize("AB")).toEqual({ width: 11, height: 7 });
    expect(textSize("A\nB")).toEqual({ width: 5, height: 15 });
    expect(textSize("HELLO\nHI")).toEqual({ width: 29, height: 15 });
    expect(textSize("")).toEqual({ width: 0, height: 7 });
  });

  it("every glyph is 7 rows of 5 and the required set is present", () => {
    for (const ch of `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,!?-+:'"()/<>=*#@&_`) {
      const glyph = GLYPHS[ch];
      expect(glyph, ch).toBeDefined();
      expect(glyph!.length, ch).toBe(7);
      for (const row of glyph!) expect(row, ch).toMatch(/^[.#]{5}$/);
    }
  });
});
