/**
 * The pure geometry of the Paint plugin: shapes as outlines (`linePath`, `rectPath`,
 * `ellipsePath`, `starPath`), the Shift / Alt modifiers (`constrainSquare`, `constrainAngle`,
 * `boxFromCenter`), sampling along and inside them (`samplePath`, `fillPoints`, `sprayPoints`),
 * the tiles a stroke or fill covers (`strokeCells`, `fillCells`) and text laid out in the 5 × 7
 * font (`textCells`). No DOM, no imports beyond `font.ts` — `tests/shapes.test.ts` runs it in Node;
 * `plugin.ts` turns points into units / sprites and cells into terrain / fog.
 *
 * Coordinates are map pixels (a tile is `TILE` = 32 px) unless a function says tiles. Y grows
 * downward, as on the map.
 */

import { GLYPH_HEIGHT, GLYPH_WIDTH, GLYPHS } from "./font";

/** A position in map pixels. */
export interface Point {
  x: number;
  y: number;
}

/** A tile: x is the column, y the row. */
export interface Cell {
  x: number;
  y: number;
}

/** A polyline; `closed` joins the last point back to the first. */
export interface Path {
  points: Point[];
  closed: boolean;
}

/** A source of numbers in [0, 1), like `Math.random` — passed in so tests can seed it. */
export type Rng = () => number;

/** Pixels per tile. */
export const TILE = 32;

/** One column between glyphs; one row between lines. */
const GLYPH_GAP = 1;
const LINE_GAP = 1;
/** Segments of the sampled ellipse outline. */
const ELLIPSE_SEGMENTS = 96;
/** `fillPoints("random")` rejects a candidate this close (× spacing) to a placed point. */
const RANDOM_MIN_RATIO = 0.7;
/** Hex packing: rows this far apart (× spacing) with alternate rows shifted half a spacing. */
const STAGGER_ROW = 0.866;

const pt = (x: number, y: number): Point => ({ x, y });
const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);

// ── Shapes → outlines ───────────────────────────────────────────────────────────────────────

/** The open path from `a` to `b`. */
export function linePath(a: Point, b: Point): Path {
  return { points: [pt(a.x, a.y), pt(b.x, b.y)], closed: false };
}

/** The closed path around the box spanned by `a` and `b` (any two opposite corners): top-left, top-right, bottom-right, bottom-left. */
export function rectPath(a: Point, b: Point): Path {
  const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
  return { points: [pt(x0, y0), pt(x1, y0), pt(x1, y1), pt(x0, y1)], closed: true };
}

/** The closed path of the ellipse inscribed in the box spanned by `a` and `b`, as `segments` chords starting at the right (3 o'clock), clockwise on screen. */
export function ellipsePath(a: Point, b: Point, segments = ELLIPSE_SEGMENTS): Path {
  const n = Math.max(3, Math.floor(segments));
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const rx = Math.abs(b.x - a.x) / 2, ry = Math.abs(b.y - a.y) / 2;
  const points: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    points.push(pt(cx + rx * Math.cos(t), cy + ry * Math.sin(t)));
  }
  return { points, closed: true };
}

/**
 * A closed star (or, with `innerRatio` 1, a regular polygon) of `points` outer vertices at `radius`
 * from `center`; below 1, an inner vertex at `innerRatio × radius` sits between each pair of outer
 * ones. `rotation` is radians clockwise on screen from the default, which puts the first vertex
 * straight up.
 */
export function starPath(center: Point, radius: number, points: number, innerRatio: number, rotation = 0): Path {
  const n = Math.max(3, Math.floor(points));
  const inner = innerRatio < 1;
  const out: Point[] = [];
  const start = -Math.PI / 2 + rotation;
  const step = (Math.PI * 2) / n;
  for (let i = 0; i < n; i++) {
    const t = start + i * step;
    out.push(pt(center.x + radius * Math.cos(t), center.y + radius * Math.sin(t)));
    if (inner) {
      const r = radius * Math.max(0, innerRatio);
      out.push(pt(center.x + r * Math.cos(t + step / 2), center.y + r * Math.sin(t + step / 2)));
    }
  }
  return { points: out, closed: true };
}

/** Shift for boxes: `b` moved so the box from `a` is square — the shorter side grows to the longer — staying in the quadrant `b` was in (a zero side grows to the right / down). */
export function constrainSquare(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return pt(a.x + (dx < 0 ? -s : s), a.y + (dy < 0 ? -s : s));
}

/** Shift for lines: `b` swung to the nearest multiple of 45° from `a`, keeping its distance. */
export function constrainAngle(a: Point, b: Point): Point {
  const dx = b.x - a.x, dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return pt(b.x, b.y);
  const snapped = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return pt(a.x + length * Math.cos(snapped), a.y + length * Math.sin(snapped));
}

/** Alt for boxes: the box centred on `center` with `corner` on one corner — returned as the corner opposite `corner`, then `corner`. */
export function boxFromCenter(center: Point, corner: Point): [Point, Point] {
  return [pt(2 * center.x - corner.x, 2 * center.y - corner.y), pt(corner.x, corner.y)];
}

// ── Sampling along and inside ───────────────────────────────────────────────────────────────

/** The segments of a path in order, the closing one included when it is closed. */
function segments(path: Path): [Point, Point][] {
  const { points } = path;
  const out: [Point, Point][] = [];
  for (let i = 1; i < points.length; i++) out.push([points[i - 1]!, points[i]!]);
  if (path.closed && points.length > 1) out.push([points[points.length - 1]!, points[0]!]);
  return out;
}

/** Total length of the polyline in pixels, the closing segment included when the path is closed. */
export function pathLength(path: Path): number {
  let total = 0;
  for (const [a, b] of segments(path)) total += distance(a, b);
  return total;
}

/**
 * Points every `spacing` px of arc length from the first point. An open path always ends on its
 * last point: the count is rounded and the spacing stretched so the last sample lands there (a
 * path shorter than `spacing` is just its two ends). A closed path never repeats its start.
 * `spacing` ≤ 0 returns the vertices; a single point returns itself.
 */
export function samplePath(path: Path, spacing: number): Point[] {
  const { points } = path;
  if (points.length === 0) return [];
  if (points.length === 1 || spacing <= 0) return points.map((p) => pt(p.x, p.y));
  const segs = segments(path);
  const total = segs.reduce((sum, [a, b]) => sum + distance(a, b), 0);
  const first = points[0]!, last = points[points.length - 1]!;
  if (total === 0) return [pt(first.x, first.y)];
  if (!path.closed && total < spacing) return [pt(first.x, first.y), pt(last.x, last.y)];
  const n = Math.max(1, Math.round(total / spacing));
  const step = total / n;
  const count = path.closed ? n : n + 1;
  const out: Point[] = [];
  let seg = 0;
  let segStart = 0;
  let segLength = distance(segs[0]![0], segs[0]![1]);
  for (let k = 0; k < count; k++) {
    if (!path.closed && k === n) {
      out.push(pt(last.x, last.y));
      break;
    }
    const d = k * step;
    while (seg < segs.length - 1 && d > segStart + segLength) {
      segStart += segLength;
      seg++;
      segLength = distance(segs[seg]![0], segs[seg]![1]);
    }
    const [a, b] = segs[seg]!;
    const t = segLength === 0 ? 0 : Math.min(1, (d - segStart) / segLength);
    out.push(pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
  }
  return out;
}

/**
 * Even-odd test: whether `p` is inside `polygon` (implicitly closed). Half-open on the outline —
 * a point on an edge counts as inside when the polygon continues to its right / below it — so
 * lattices tile adjacent polygons without double-counting.
 */
export function insidePolygon(p: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!, b = polygon[j]!;
    if (a.y > p.y !== b.y > p.y) {
      const x = a.x + ((p.y - a.y) * (b.x - a.x)) / (b.y - a.y);
      if (p.x < x) inside = !inside;
    }
  }
  return inside;
}

/** Bounding box of a point list. */
function bounds(points: readonly Point[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

/** Area of a polygon by the shoelace formula (always positive). */
function polygonArea(polygon: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j]!, b = polygon[i]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

/**
 * How `fillPoints` spreads points: `grid` is a square lattice of `spacing` aligned to the
 * polygon's bounding-box origin, `staggered` a hex packing (rows 0.866 × spacing apart, every
 * other row shifted by half), `random` a uniform scatter with a minimum distance.
 */
export type FillPattern = "grid" | "staggered" | "random";

/** A hash of points by cell of side `size`, for nearest-neighbour rejection. */
class PointHash {
  private cells = new Map<string, Point[]>();
  private size: number;
  constructor(size: number) {
    this.size = size;
  }
  private key(cx: number, cy: number) {
    return `${cx},${cy}`;
  }
  add(p: Point) {
    const k = this.key(Math.floor(p.x / this.size), Math.floor(p.y / this.size));
    const list = this.cells.get(k);
    if (list) list.push(p);
    else this.cells.set(k, [p]);
  }
  /** Whether a stored point lies within `min` of `p` (`min` must not exceed the cell size). */
  near(p: Point, min: number): boolean {
    const cx = Math.floor(p.x / this.size), cy = Math.floor(p.y / this.size);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = this.cells.get(this.key(cx + dx, cy + dy));
        if (!list) continue;
        for (const q of list) if (distance(p, q) < min) return true;
      }
    }
    return false;
  }
}

/**
 * Points inside the polygon (an open path is treated as closed), never on purpose on the
 * outline — the caller adds the outline separately. `random` places about area / spacing²
 * points, rejecting any closer than 0.7 × spacing to one already placed, and gives up after a
 * bounded number of attempts, so a crowded polygon comes back a little short.
 */
export function fillPoints(path: Path, spacing: number, pattern: FillPattern, rng: Rng): Point[] {
  const polygon = path.points;
  if (polygon.length < 3 || !(spacing > 0)) return [];
  const { minX, minY, maxX, maxY } = bounds(polygon);
  const out: Point[] = [];
  if (pattern === "grid") {
    for (let y = minY; y <= maxY; y += spacing) {
      for (let x = minX; x <= maxX; x += spacing) {
        const p = pt(x, y);
        if (insidePolygon(p, polygon)) out.push(p);
      }
    }
  } else if (pattern === "staggered") {
    const rowStep = spacing * STAGGER_ROW;
    for (let row = 0, y = minY; y <= maxY; row++, y = minY + row * rowStep) {
      const shift = row % 2 ? spacing / 2 : 0;
      for (let x = minX + shift; x <= maxX; x += spacing) {
        const p = pt(x, y);
        if (insidePolygon(p, polygon)) out.push(p);
      }
    }
  } else {
    const target = Math.round(polygonArea(polygon) / (spacing * spacing));
    const min = spacing * RANDOM_MIN_RATIO;
    const hash = new PointHash(min);
    const width = maxX - minX, height = maxY - minY;
    let attempts = target * 30 + 100;
    while (out.length < target && attempts-- > 0) {
      const p = pt(minX + rng() * width, minY + rng() * height);
      if (!insidePolygon(p, polygon) || hash.near(p, min)) continue;
      hash.add(p);
      out.push(p);
    }
  }
  return out;
}

/** `count` points uniformly distributed over the disc of `radius` around `center`. */
export function sprayPoints(center: Point, radius: number, count: number, rng: Rng): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < count; i++) {
    const r = radius * Math.sqrt(rng());
    const t = rng() * Math.PI * 2;
    out.push(pt(center.x + r * Math.cos(t), center.y + r * Math.sin(t)));
  }
  return out;
}

/** Each point moved by up to ± `amount` in x and in y, independently. */
export function jitterPoints(points: readonly Point[], amount: number, rng: Rng): Point[] {
  return points.map((p) => pt(p.x + (rng() * 2 - 1) * amount, p.y + (rng() * 2 - 1) * amount));
}

/** Drops every point closer than `minDistance` to one kept before it, in list order. `minDistance` ≤ 0 keeps all. */
export function dedupePoints(points: readonly Point[], minDistance: number): Point[] {
  if (!(minDistance > 0)) return points.map((p) => pt(p.x, p.y));
  const hash = new PointHash(minDistance);
  const out: Point[] = [];
  for (const p of points) {
    if (hash.near(p, minDistance)) continue;
    hash.add(p);
    out.push(pt(p.x, p.y));
  }
  return out;
}

// ── Cells, for terrain and fog ──────────────────────────────────────────────────────────────

/** The tile containing a pixel position. */
export function cellOf(p: Point): Cell {
  return { x: Math.floor(p.x / TILE), y: Math.floor(p.y / TILE) };
}

/**
 * The offsets of a round brush `width` tiles across: 1 is the cell itself, 3 the full 3 × 3, 5 a
 * 21-cell disc; an even width is anchored at the cell's top-left, so 2 is the 2 × 2 to its right
 * and below and 4 the 4 × 4 without its corners.
 */
function brushOffsets(width: number): Cell[] {
  const n = Math.max(1, Math.floor(width));
  const r = n / 2;
  const out: Cell[] = [];
  if (n % 2) {
    const k = (n - 1) / 2;
    for (let dy = -k; dy <= k; dy++) for (let dx = -k; dx <= k; dx++) if (dx * dx + dy * dy <= k * k + k) out.push({ x: dx, y: dy });
  } else {
    for (let dy = 1 - r; dy <= r; dy++) {
      for (let dx = 1 - r; dx <= r; dx++) {
        const ex = dx - 0.5, ey = dy - 0.5;
        if (ex * ex + ey * ey <= r * r + 0.25) out.push({ x: dx, y: dy });
      }
    }
  }
  return out;
}

/** Bresenham's walk from one cell to another, both ends included, every step 8-connected. */
function lineCells(a: Cell, b: Cell, visit: (c: Cell) => void) {
  const dx = Math.abs(b.x - a.x), dy = -Math.abs(b.y - a.y);
  const sx = a.x < b.x ? 1 : -1, sy = a.y < b.y ? 1 : -1;
  let err = dx + dy;
  let x = a.x, y = a.y;
  for (;;) {
    visit({ x, y });
    if (x === b.x && y === b.y) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Every tile touched by drawing the polyline with a round brush `width` tiles across: the cells
 * a Bresenham walk between the endpoints' cells passes through (so a diagonal never gaps),
 * each dilated by `brushOffsets`. Unique, in first-touched order.
 */
export function strokeCells(path: Path, width: number): Cell[] {
  const offsets = brushOffsets(width);
  const seen = new Set<string>();
  const out: Cell[] = [];
  const touch = (c: Cell) => {
    for (const o of offsets) {
      const x = c.x + o.x, y = c.y + o.y;
      const key = `${x},${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ x, y });
    }
  };
  const { points } = path;
  if (points.length === 0) return out;
  if (points.length === 1) {
    touch(cellOf(points[0]!));
    return out;
  }
  for (const [a, b] of segments(path)) lineCells(cellOf(a), cellOf(b), touch);
  return out;
}

/** The tiles whose centre lies inside the polygon (an open path is treated as closed), row-major. */
export function fillCells(path: Path): Cell[] {
  const polygon = path.points;
  if (polygon.length < 3) return [];
  const { minX, minY, maxX, maxY } = bounds(polygon);
  const out: Cell[] = [];
  for (let y = Math.floor(minY / TILE); y <= Math.floor(maxY / TILE); y++) {
    for (let x = Math.floor(minX / TILE); x <= Math.floor(maxX / TILE); x++) {
      if (insidePolygon(pt(x * TILE + TILE / 2, y * TILE + TILE / 2), polygon)) out.push({ x, y });
    }
  }
  return out;
}

/** The cells without repeats, keeping the first occurrence of each. */
export function uniqueCells(cells: Iterable<Cell>): Cell[] {
  const seen = new Set<string>();
  const out: Cell[] = [];
  for (const c of cells) {
    const key = `${c.x},${c.y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x: c.x, y: c.y });
  }
  return out;
}

// ── Text ────────────────────────────────────────────────────────────────────────────────────

/** The lines of a text, split on LF or CRLF. */
const lines = (text: string) => text.split(/\r?\n/);

/**
 * `text` set in the 5 × 7 font, one cell per set pixel, x and y from the top-left: glyphs one
 * blank column apart, lines eight rows apart. Lowercase is set as uppercase; a character the
 * font lacks leaves a blank glyph's width. Row-major.
 */
export function textCells(text: string): Cell[] {
  const out: Cell[] = [];
  lines(text).forEach((line, lineIndex) => {
    const y0 = lineIndex * (GLYPH_HEIGHT + LINE_GAP);
    const glyphs = [...line].map((ch) => GLYPHS[ch.toUpperCase()]);
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      glyphs.forEach((glyph, i) => {
        if (!glyph) return;
        const x0 = i * (GLYPH_WIDTH + GLYPH_GAP);
        const bits = glyph[row] ?? "";
        for (let col = 0; col < GLYPH_WIDTH; col++) if (bits[col] === "#") out.push({ x: x0 + col, y: y0 + row });
      });
    }
  });
  return out;
}

/** The box `textCells` fills, in cells: the longest line's width (5 per glyph plus the gaps) by 7 per line plus the gaps. An empty string is one blank line, 0 × 7. */
export function textSize(text: string): { width: number; height: number } {
  const all = lines(text);
  let width = 0;
  for (const line of all) {
    const n = [...line].length;
    width = Math.max(width, n === 0 ? 0 : n * GLYPH_WIDTH + (n - 1) * GLYPH_GAP);
  }
  return { width, height: all.length * GLYPH_HEIGHT + (all.length - 1) * LINE_GAP };
}
