/**
 * Paint — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * Tools ▸ Paint… opens a panel that floats over the map. Pick a tool in it (freehand,
 * line, rectangle, ellipse, polygon, star, spray, text, eraser) and draw on the map;
 * whatever the active layer's palette has picked is what gets laid down: flat terrain
 * or a tile, a doodad, a unit for a player, a sprite, or fog for some players. Closed
 * shapes can be filled (a grid, a staggered grid, or random scatter), objects are
 * spaced along the outline and can be jittered, and every stroke is one undo step.
 *
 * The map work is `api.ui.mapTool` (the pointer and an overlay for the preview),
 * `api.ui.panel` (the palette that does not block the map) and `api.document.edit`.
 * `shapes.ts` is the pure geometry: outlines, sampling, fills, tile rasterising and
 * the pixel font; it has its own tests. This file is the panel, the tools and the
 * transaction. Plain DOM only, with a small `h()` builder and a scoped stylesheet.
 * `@scm-js/plugin-api` is the editor's type declarations, a devDependency generated from
 * its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { DoodadInfo, EditTransaction, MapPointer, MapToolHandle, MapToolStopReason, MapView, PanelHandle, PluginApi, UnitSize } from "@scm-js/plugin-api";
import {
  boxFromCenter, cellOf, constrainAngle, constrainSquare, dedupePoints, ellipsePath, fillCells, fillPoints, jitterPoints, linePath, rectPath, samplePath, sprayPoints,
  starPath, strokeCells, textCells, TILE, uniqueCells,
  type Cell, type FillPattern, type Path, type Point, type Rng,
} from "./shapes";
import { KO } from "./ko";

/* ── Translation ────────────────────────────────────────── */

type Params = Record<string, string | number>;
/** `api.i18n.t`, bound when the plugin activates; until then the English. */
let t = (text: string, _params?: Params): string => text;
/** Marks a string kept in a table (or handed to the host to translate) for `tests/ko.test.ts`; `translate` shows it. */
const msg = (text: string) => text;
let translate = (text: string): string => text;

/* ── DOM helpers ────────────────────────────────────────── */

type Child = Node | string | null | undefined | false;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "className") el.className = String(v);
      else if (k === "style") el.setAttribute("style", String(v));
      else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

const STYLE = `
.pnt { display: flex; flex-direction: column; gap: 8px; font-size: 12px; }
.pnt .pnt-brush { display: flex; flex-direction: column; gap: 2px; padding: 6px 8px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-0, #0f1115); }
.pnt .pnt-brush b { color: var(--gold, #e6b95c); }
.pnt .pnt-brush .pnt-sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 6px; vertical-align: -1px; border: 1px solid rgba(0,0,0,.5); }
.pnt .pnt-dim { color: var(--text-dim, #99a2b3); }
.pnt .pnt-tools { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
.pnt .pnt-tool { display: flex; flex-direction: column; align-items: center; gap: 1px; padding: 5px 2px 4px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-2, #1b1f27); color: var(--text, #e6e9ef); cursor: pointer; font-size: 11px; }
.pnt .pnt-tool:hover { background: var(--bg-3, #232833); }
.pnt .pnt-tool.on { background: var(--teal-dim, #2c8a83); border-color: var(--teal, #4fd1c5); color: #fff; }
.pnt .pnt-tool .pnt-glyph { font-size: 15px; line-height: 17px; }
.pnt .pnt-row { display: grid; grid-template-columns: 62px 1fr; align-items: center; gap: 6px; min-height: 22px; }
.pnt .pnt-row.off { opacity: .45; pointer-events: none; }
.pnt .pnt-row > label { color: var(--text-dim, #99a2b3); }
.pnt .pnt-row .pnt-in { display: flex; align-items: center; gap: 6px; min-width: 0; }
.pnt .pnt-row input[type=number] { width: 58px; }
.pnt .pnt-row input[type=range] { flex: 1; min-width: 0; margin: 0; }
.pnt .pnt-row input[type=text] { flex: 1; min-width: 0; }
.pnt .pnt-row output { width: 34px; text-align: right; font-variant-numeric: tabular-nums; }
.pnt .pnt-row select { flex: 1; min-width: 0; }
.pnt .pnt-row .pnt-check { display: flex; align-items: center; gap: 5px; }
.pnt .pnt-keys { color: var(--text-faint, #6b7382); font-size: 11px; line-height: 1.4; }
.pnt .pnt-keys kbd { font-family: inherit; color: var(--text-dim, #99a2b3); }
`;

/* ── Tools and settings ─────────────────────────────────── */

type ToolId = "freehand" | "line" | "rect" | "ellipse" | "polygon" | "star" | "spray" | "text" | "eraser";

interface ToolDef {
  id: ToolId;
  label: string;
  glyph: string;
  hint: string;
}

const TOOLS: ToolDef[] = [
  { id: "freehand", label: msg("Freehand"), glyph: "✎", hint: msg("drag to draw") },
  { id: "line", label: msg("Line"), glyph: "╱", hint: msg("drag from one end to the other") },
  { id: "rect", label: msg("Rectangle"), glyph: "▭", hint: msg("drag a corner to the opposite corner") },
  { id: "ellipse", label: msg("Ellipse"), glyph: "◯", hint: msg("drag the box the ellipse fits in") },
  { id: "polygon", label: msg("Polygon"), glyph: "⬠", hint: msg("click the corners, click the first one again to finish") },
  { id: "star", label: msg("Star"), glyph: "★", hint: msg("drag from the centre outwards; the drag sets the size and turns it") },
  { id: "spray", label: msg("Spray"), glyph: "⁘", hint: msg("drag to scatter") },
  { id: "text", label: msg("Text"), glyph: "A", hint: msg("click where the text starts") },
  { id: "eraser", label: msg("Eraser"), glyph: "⌫", hint: msg("drag over what to remove") },
];

const TOOL_BY_ID = Object.fromEntries(TOOLS.map((t) => [t.id, t])) as Record<ToolId, ToolDef>;

/** Whether a tool's shape can be filled. */
const CLOSED: ReadonlySet<ToolId> = new Set(["rect", "ellipse", "polygon", "star"]);

type OwnerMode = "palette" | "cycle" | "random";

/** What the panel remembers between sessions (`api.storage`). */
interface Settings {
  tool: ToolId;
  filled: boolean;
  pattern: FillPattern;
  /** Pixels between objects along a shape; 0 = the object's own size. */
  spacing: number;
  /** 0–100: how far objects may stray from their spot, as a share of the spacing. */
  jitter: number;
  /** Tiles: the brush width for terrain and fog, the eraser's and the spray's radius, and the size of a text pixel. */
  width: number;
  starPoints: number;
  /** 0.2–1: an inner radius as a share of the outer; 1 is a plain polygon. */
  starInner: number;
  text: string;
  owners: OwnerMode;
  /** Skip units that the Units palette's placement checks would refuse (overlaps, bad ground). */
  checkPlacement: boolean;
}

const DEFAULTS: Settings = {
  tool: "line", filled: false, pattern: "grid", spacing: 0, jitter: 0, width: 1, starPoints: 5, starInner: 0.5, text: "GG", owners: "palette", checkPlacement: true,
};

function loadSettings(api: PluginApi): Settings {
  const stored = api.storage.get<Partial<Settings>>("settings", {});
  const s = { ...DEFAULTS, ...stored };
  if (!TOOL_BY_ID[s.tool]) s.tool = DEFAULTS.tool;
  return s;
}

/* ── The brush: what the active layer's palette has picked ── */

type Brush =
  | { kind: "terrain"; label: string; color: string | null; terrainId: number; tile: number; useTile: boolean }
  | { kind: "fog"; label: string; color: null; players: number; mode: "fog" | "clear" }
  | { kind: "doodad"; label: string; color: null; info: DoodadInfo }
  | { kind: "unit"; label: string; color: string; unitId: number; owner: number; size: UnitSize }
  | { kind: "sprite"; label: string; color: string; spriteKind: "pure" | "unit"; id: number; owner: number; flipped: boolean; disabled: boolean }
  | { kind: "none"; label: string; color: null };

const hex = (packed: number | null) => (packed === null ? null : `#${packed.toString(16).padStart(6, "0")}`);

function brushOf(api: PluginApi): Brush {
  if (!api.document.isOpen()) return { kind: "none", label: t("no map is open"), color: null };
  const layer = api.selection.layer();
  const pick = api.palette.active();
  switch (layer) {
    case "terrain": {
      const b = api.terrain.active();
      if (b.mode === "tile") {
        const info = api.terrain.tileInfo(b.tile);
        return { kind: "terrain", label: info ? t("tile {n} ({label})", { n: b.tile, label: info.label }) : t("tile {n}", { n: b.tile }), color: hex(api.terrain.color(b.tile)), terrainId: b.terrain, tile: b.tile, useTile: true };
      }
      const type = api.terrain.types().find((t) => t.id === b.terrain);
      return { kind: "terrain", label: type?.name ?? t("terrain {n}", { n: b.terrain }), color: hex(api.terrain.terrainColor(b.terrain)), terrainId: b.terrain, tile: b.tile, useTile: false };
    }
    case "fog": {
      const players = [];
      for (let i = 0; i < 8; i++) if (pick.fogPlayers & (1 << i)) players.push(i + 1);
      const mode = pick.fogMode === "fog" ? t("fog") : t("clear fog");
      const label = players.length === 0 ? t("{mode} for nobody", { mode })
        : players.length === 8 ? t("{mode} for every player", { mode })
        : t("{mode} for {n, plural, one {player {list}} other {players {list}}}", { mode, n: players.length, list: players.join(", ") });
      return { kind: "fog", label, color: null, players: pick.fogPlayers, mode: pick.fogMode };
    }
    case "doodads": {
      const info = pick.doodad >= 0 ? api.palette.doodadInfo(pick.doodad) : null;
      if (!info) return { kind: "none", label: t("pick a doodad in the palette"), color: null };
      return { kind: "doodad", label: info.name, color: null, info };
    }
    case "units":
      return { kind: "unit", label: t("{name} · Player {n}", { name: api.palette.unitName(pick.unit), n: pick.owner + 1 }), color: api.palette.playerColor(pick.owner), unitId: pick.unit, owner: pick.owner, size: api.palette.unitSize(pick.unit) };
    case "sprites": {
      const id = pick.spriteKind === "pure" ? pick.sprite : pick.unitSprite;
      return {
        kind: "sprite", label: pick.spriteFlipped ? t("{name} · Player {n} · flipped", { name: api.palette.spriteName(pick.spriteKind, id), n: pick.owner + 1 }) : t("{name} · Player {n}", { name: api.palette.spriteName(pick.spriteKind, id), n: pick.owner + 1 }), color: api.palette.playerColor(pick.owner),
        spriteKind: pick.spriteKind, id, owner: pick.owner, flipped: pick.spriteFlipped, disabled: pick.spriteDisabled,
      };
    }
    default:
      return { kind: "none", label: t("switch to the Terrain, Doodads, Units, Sprites or Fog of War layer"), color: null };
  }
}

/** Terrain and fog are painted by the tile; everything else is placed at points. */
const paintsCells = (b: Brush) => b.kind === "terrain" || b.kind === "fog";

/** The spacing objects get when the panel says "auto": their own size. */
function autoSpacing(b: Brush): number {
  switch (b.kind) {
    case "unit": return Math.max(TILE, b.size.width, b.size.height);
    case "doodad": return Math.max(b.info.width, b.info.height) * TILE;
    default: return TILE;
  }
}

const PLAYERS = 8;

/* ── What a gesture produces ────────────────────────────── */

/** The outline a tool has drawn so far, plus what the spray and the text tool carry instead. */
interface Drawing {
  path: Path | null;
  /** Spray: the points scattered so far. */
  scattered: Point[];
  /** Text: the top-left of the block, following the pointer. */
  textAt: Point | null;
  /** Eraser: the indices to remove, by list. */
  erase: { units: number[]; sprites: number[]; doodads: number[] } | null;
}

/** What a commit would lay down: tiles, or points with a per-point owner. */
interface Rendered {
  cells: Cell[];
  points: Point[];
  owners: number[];
}

/** A small deterministic generator, so the preview and the commit scatter the same way. */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function render(tool: ToolId, drawing: Drawing, brush: Brush, s: Settings, width: number, height: number, seed: number): Rendered {
  const rng = mulberry32(seed);
  const spacing = s.spacing > 0 ? s.spacing : autoSpacing(brush);
  const inMap = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < width * TILE && p.y < height * TILE;
  const inMapCell = (c: Cell) => c.x >= 0 && c.y >= 0 && c.x < width && c.y < height;
  const out: Rendered = { cells: [], points: [], owners: [] };
  const byCells = paintsCells(brush);

  if (tool === "text") {
    if (!drawing.textAt || !s.text.trim()) return out;
    const glyphs = textCells(s.text);
    const { x, y } = drawing.textAt;
    if (byCells) {
      const scale = Math.max(1, s.width);
      const origin = cellOf({ x, y });
      const cells: Cell[] = [];
      for (const g of glyphs) for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) cells.push({ x: origin.x + g.x * scale + dx, y: origin.y + g.y * scale + dy });
      out.cells = cells.filter(inMapCell);
    } else {
      out.points = glyphs.map((g) => ({ x: x + g.x * spacing, y: y + g.y * spacing })).filter(inMap);
    }
  } else if (tool === "spray") {
    if (byCells) out.cells = uniqueCells(drawing.scattered.map(cellOf)).filter(inMapCell);
    else out.points = dedupePoints(drawing.scattered, spacing * 0.5).filter(inMap);
  } else if (tool !== "eraser" && drawing.path && drawing.path.points.length > 0) {
    const path = drawing.path;
    const filled = s.filled && CLOSED.has(tool) && path.points.length >= 3;
    if (byCells) {
      const cells = strokeCells(path, Math.max(1, s.width));
      out.cells = uniqueCells(filled ? [...cells, ...fillCells(path)] : cells).filter(inMapCell);
    } else {
      let points = samplePath(path, spacing);
      if (filled) points = [...points, ...fillPoints(path, spacing, s.pattern, rng)];
      if (s.jitter > 0) points = jitterPoints(points, (spacing * s.jitter) / 100, rng);
      out.points = dedupePoints(points, spacing * 0.5).filter(inMap);
    }
  }

  if (out.points.length > 0 && (brush.kind === "unit" || brush.kind === "sprite")) {
    const base = brush.owner;
    out.owners = out.points.map((_, i) => (s.owners === "cycle" ? (base + i) % PLAYERS : s.owners === "random" ? Math.floor(rng() * PLAYERS) : base));
  }
  return out;
}

/* ── The session: panel state, the running tool, the gesture ── */

interface Gesture {
  /** Where the button went down (the anchor of a drag). */
  from: Point;
  /** Where the pointer is now. */
  to: Point;
  seed: number;
  drawing: Drawing;
  /** The preview of what a release would lay down, recomputed on every move. */
  preview: Rendered;
}

class Session {
  settings: Settings;
  brush: Brush;
  tool: MapToolHandle | null = null;
  /** The polygon's corners so far, between clicks (the only tool with state outside a drag). */
  corners: Point[] = [];
  gesture: Gesture | null = null;
  /** The text block's preview and the eraser's cursor follow the pointer between clicks. */
  hover: Point | null = null;
  lastZoom = 1;
  lastClick = { at: 0, x: 0, y: 0 };
  panel: PanelHandle | null = null;
  /** Panel widgets to refresh when something outside the panel changes. */
  refresh: (() => void)[] = [];

  readonly api: PluginApi;

  constructor(api: PluginApi) {
    this.api = api;
    this.settings = loadSettings(api);
    this.brush = brushOf(api);
  }

  save() { this.api.storage.set("settings", this.settings); }

  rebrush() {
    this.brush = brushOf(this.api);
    for (const r of this.refresh) r();
    this.tool?.redraw();
  }

  get active(): ToolId | null { return this.tool?.isActive() ? this.settings.tool : null; }

  /* ── running a tool ── */

  start(id: ToolId) {
    this.settings.tool = id;
    this.save();
    if (!this.api.document.isOpen()) { this.api.ui.status(t("Paint: open a map first")); this.notify(); return; }
    this.corners = [];
    this.gesture = null;
    this.hover = null;
    const def = TOOL_BY_ID[id];
    this.tool = this.api.ui.mapTool({
      name: t("Paint: {tool}", { tool: translate(def.label) }),
      hint: translate(def.hint),
      onDown: (p) => this.onDown(p),
      onMove: (p) => this.onMove(p),
      onUp: (p) => this.onUp(p),
      onCancel: () => this.onCancel(),
      draw: (ctx, view) => this.draw(ctx, view),
      onStop: (reason) => this.onStop(reason),
    });
    this.notify();
  }

  stop() { this.tool?.stop(); }

  private onStop(reason: MapToolStopReason) {
    this.gesture = null;
    this.corners = [];
    if (reason !== "replaced") { this.tool = null; this.notify(); }
  }

  private notify() { for (const r of this.refresh) r(); }

  /* ── pointer ── */

  private onDown(p: MapPointer) {
    if (this.brush.kind === "none") { this.api.ui.status(t("Paint: {what}", { what: this.brush.label })); return; }
    const at = { x: p.px, y: p.py };
    const tool = this.settings.tool;
    const seed = (Date.now() ^ (p.px * 7919) ^ (p.py * 104729)) >>> 0;
    const drawing: Drawing = { path: null, scattered: [], textAt: null, erase: null };
    if (tool === "polygon") {
      const now = Date.now();
      const near = (q: Point) => Math.hypot(q.x - at.x, q.y - at.y) * this.lastZoom <= 10;
      const doubleClick = now - this.lastClick.at < 400 && near({ x: this.lastClick.x, y: this.lastClick.y });
      this.lastClick = { at: now, x: at.x, y: at.y };
      if (this.corners.length >= 3 && (near(this.corners[0]) || doubleClick)) {
        this.finishPolygon();
        return;
      }
      if (doubleClick) return;
      this.corners.push(at);
      this.gesture = { from: at, to: at, seed, drawing, preview: { cells: [], points: [], owners: [] } };
      this.updatePreview();
      return;
    }
    if (tool === "text") {
      drawing.textAt = at;
      this.gesture = { from: at, to: at, seed, drawing, preview: { cells: [], points: [], owners: [] } };
      this.updatePreview();
      this.commit();
      return;
    }
    if (tool === "spray") drawing.scattered = sprayPoints(at, this.sprayRadius(), this.sprayCount(), Math.random);
    else if (tool === "freehand") drawing.path = { points: [at], closed: false };
    else if (tool === "eraser") drawing.erase = { units: [], sprites: [], doodads: [] };
    this.gesture = { from: at, to: at, seed, drawing, preview: { cells: [], points: [], owners: [] } };
    this.shape(p);
    this.updatePreview();
  }

  private onMove(p: MapPointer) {
    this.hover = p.inMap || p.down ? { x: p.px, y: p.py } : null;
    const g = this.gesture;
    if (g && (p.down || this.settings.tool === "polygon")) {
      g.to = { x: p.px, y: p.py };
      this.shape(p);
      this.updatePreview();
    }
    this.tool?.redraw();
  }

  private onUp(p: MapPointer) {
    const g = this.gesture;
    if (!g) return;
    if (this.settings.tool === "polygon") return;
    g.to = { x: p.px, y: p.py };
    this.shape(p);
    this.updatePreview();
    this.commit();
  }

  /** Esc or a right-click: drop the shape in progress and keep painting; with nothing in progress, leave the tool. */
  private onCancel(): boolean {
    if (this.gesture || this.corners.length > 0) {
      this.gesture = null;
      this.corners = [];
      this.api.ui.status(t("Paint: shape dropped"));
      this.tool?.redraw();
      return true;
    }
    return false;
  }

  /* ── the shape under the pointer ── */

  private sprayRadius() { return Math.max(1, this.settings.width) * TILE / 2 + TILE / 2; }
  private sprayCount() { return paintsCells(this.brush) ? 3 : 2; }

  /** Update the gesture's drawing from its anchor and the pointer, per tool. */
  private shape(p: MapPointer) {
    const g = this.gesture!;
    const tool = this.settings.tool;
    let to = g.to;
    if (p.shift && (tool === "line")) to = constrainAngle(g.from, to);
    if (p.shift && (tool === "rect" || tool === "ellipse")) to = constrainSquare(g.from, to);
    const [a, b] = p.alt && (tool === "rect" || tool === "ellipse") ? boxFromCenter(g.from, to) : [g.from, to];
    switch (tool) {
      case "line": g.drawing.path = linePath(a, b); break;
      case "rect": g.drawing.path = rectPath(a, b); break;
      case "ellipse": g.drawing.path = ellipsePath(a, b); break;
      case "star": {
        const r = Math.hypot(to.x - g.from.x, to.y - g.from.y);
        const rotation = r < 1 ? 0 : Math.atan2(to.x - g.from.x, -(to.y - g.from.y));
        g.drawing.path = r < 1 ? { points: [g.from], closed: true } : starPath(g.from, r, this.settings.starPoints, this.settings.starInner, rotation);
        break;
      }
      case "polygon": g.drawing.path = { points: [...this.corners, to], closed: this.settings.filled }; break;
      case "freehand": {
        const pts = g.drawing.path!.points;
        const last = pts[pts.length - 1];
        if (Math.hypot(to.x - last.x, to.y - last.y) >= 4) pts.push(to);
        break;
      }
      case "spray": {
        if (p.down) g.drawing.scattered.push(...sprayPoints(to, this.sprayRadius(), this.sprayCount(), Math.random));
        break;
      }
      case "eraser": {
        g.drawing.path ??= { points: [g.from], closed: false };
        g.drawing.path.points.push(to);
        this.collectErasures(g);
        break;
      }
      default: break;
    }
  }

  /** Everything of the layer's kind whose centre passes within the eraser's radius of the stroke. */
  private collectErasures(g: Gesture) {
    const scn = this.api.document.scenario();
    const erase = g.drawing.erase;
    const path = g.drawing.path;
    if (!scn || !erase || !path) return;
    const radius = Math.max(1, this.settings.width) * TILE / 2;
    const stroke = samplePath(path, radius / 2);
    const hit = (x: number, y: number) => stroke.some((q) => Math.hypot(q.x - x, q.y - y) <= radius);
    const add = (list: number[], i: number) => { if (!list.includes(i)) list.push(i); };
    switch (this.brush.kind) {
      case "unit": scn.units.forEach((u, i) => { if (hit(u.x, u.y)) add(erase.units, i); }); break;
      case "sprite": scn.sprites.forEach((r, i) => { if (hit(r.x, r.y)) add(erase.sprites, i); }); break;
      case "doodad":
        scn.doodads.forEach((d, i) => {
          const info = this.api.palette.doodadInfo(d.doodadId);
          const w = info?.width ?? 1, hh = info?.height ?? 1;
          if (hit((d.x + w / 2) * TILE, (d.y + hh / 2) * TILE)) add(erase.doodads, i);
        });
        break;
      default: break;
    }
  }

  /** Start the fetch for whatever the brush draws; `onImageLoaded` redraws when it lands. */
  wantArt() {
    const brush = this.brush;
    if (brush.kind === "unit") this.api.graphics.requestUnit(brush.unitId);
    else if (brush.kind === "sprite") this.api.graphics.requestSprite(brush.spriteKind, brush.id);
  }

  private updatePreview() {
    const g = this.gesture;
    const info = this.api.document.info();
    if (!g || !info) return;
    g.preview = render(this.settings.tool, g.drawing, this.brush, this.settings, info.width, info.height, g.seed);
  }

  private finishPolygon() {
    const g = this.gesture;
    if (!g) return;
    g.drawing.path = { points: [...this.corners], closed: this.settings.filled || this.corners.length >= 3 };
    this.updatePreview();
    this.commit();
    this.corners = [];
  }

  /* ── laying it down ── */

  private commit() {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    const brush = this.brush;
    const tool = this.settings.tool;
    const s = this.settings;
    const def = TOOL_BY_ID[tool];

    if (tool === "eraser") {
      const e = g.drawing.erase;
      if (!e) return;
      const n = e.units.length + e.sprites.length + e.doodads.length;
      if (n === 0) { this.api.ui.status(t("Paint: nothing under the eraser")); this.tool?.redraw(); return; }
      const what = brush.kind === "unit" ? t("Erase {n, plural, one {# unit} other {# units}}", { n })
        : brush.kind === "sprite" ? t("Erase {n, plural, one {# sprite} other {# sprites}}", { n })
        : t("Erase {n, plural, one {# doodad} other {# doodads}}", { n });
      this.api.document.edit(what, (tx) => {
        if (e.units.length) tx.removeUnits(e.units);
        if (e.sprites.length) tx.removeSprites(e.sprites);
        if (e.doodads.length) tx.removeDoodads(e.doodads);
      });
      this.api.ui.status(t("Paint: erased {n}", { n }));
      this.tool?.redraw();
      return;
    }

    const r = g.preview;
    const count = paintsCells(brush) ? r.cells.length : r.points.length;
    if (count === 0) { this.tool?.redraw(); return; }
    const width = this.api.document.info()?.width ?? 0;
    let placed = 0;
    let skipped = 0;
    const toolName = translate(def.label).toLowerCase();
    const label = t("Paint {tool}: {what}", { tool: toolName, what: brush.label });
    const result = this.api.document.edit(label, (tx) => {
      if (brush.kind === "terrain") {
        const cells = r.cells.map((c) => c.y * width + c.x);
        placed = brush.useTile ? tx.setTiles(cells, brush.tile) : tx.stampTerrain(cells, brush.terrainId);
      } else if (brush.kind === "fog") {
        placed = tx.setFog(r.cells.map((c) => c.y * width + c.x), brush.players, brush.mode);
      } else {
        r.points.forEach((p, i) => { if (place(tx, brush, p, r.owners[i] ?? 0, s)) placed++; else skipped++; });
      }
    });
    const what = paintsCells(brush) ? t("{n, plural, one {# tile} other {# tiles}}", { n: placed }) : t("{n} × {what}", { n: placed, what: brush.label });
    const why = brush.kind === "unit" ? t("placement checks refused them") : t("off the map");
    const notes = result.notes.length > 0 ? ` — ${result.notes.join(", ")}` : "";
    const skip = skipped > 0 ? t(" ({n} skipped: {why})", { n: skipped, why }) : "";
    if (!result.changed && paintsCells(brush)) this.api.ui.status(t("Paint: {tool} changed nothing — {n, plural, one {that tile already is} other {those # tiles already are}} {what}{notes}", { tool: toolName, n: count, what: brush.label, notes }));
    else this.api.ui.status(t("Paint: {tool} of {what}{skipped}{notes}", { tool: toolName, what, skipped: skip, notes }));
    this.tool?.redraw();
  }

  /* ── the overlay ── */

  draw(ctx: CanvasRenderingContext2D, view: MapView) {
    this.lastZoom = view.zoom;
    const g = this.gesture;
    const tool = this.settings.tool;
    const brush = this.brush;
    const teal = "#4fd1c5";
    const color = brush.color ?? teal;
    ctx.lineWidth = 1;

    // The eraser and the spray show their reach; the text block previews under the pointer before the click.
    if ((tool === "eraser" || tool === "spray") && this.hover) {
      const r = (tool === "eraser" ? Math.max(1, this.settings.width) * TILE / 2 : this.sprayRadius()) * view.zoom;
      ctx.strokeStyle = tool === "eraser" ? "#ff7b72" : teal;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.arc(view.x(this.hover.x), view.y(this.hover.y), r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (tool === "text" && this.hover && !g) {
      const info = this.api.document.info();
      if (info) {
        const drawing: Drawing = { path: null, scattered: [], textAt: this.hover, erase: null };
        const preview = render(tool, drawing, brush, this.settings, info.width, info.height, 1);
        this.drawRendered(ctx, view, preview, color);
      }
      return;
    }
    if (!g) return;

    // The outline, then what a release would lay down.
    const path = g.drawing.path;
    if (path && path.points.length > 1 && tool !== "eraser") {
      ctx.strokeStyle = teal;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      path.points.forEach((p, i) => (i === 0 ? ctx.moveTo(view.x(p.x), view.y(p.y)) : ctx.lineTo(view.x(p.x), view.y(p.y))));
      if (path.closed) ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (tool === "polygon" && this.corners.length > 0) {
      const first = this.corners[0];
      ctx.strokeStyle = teal;
      ctx.beginPath();
      ctx.arc(view.x(first.x), view.y(first.y), 5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (tool === "eraser" && g.drawing.erase) {
      const e = g.drawing.erase;
      const scn = this.api.document.scenario();
      if (scn) {
        ctx.strokeStyle = "#ff7b72";
        const mark = (x: number, y: number) => {
          const sx = view.x(x), sy = view.y(y);
          ctx.beginPath();
          ctx.moveTo(sx - 5, sy - 5); ctx.lineTo(sx + 5, sy + 5);
          ctx.moveTo(sx + 5, sy - 5); ctx.lineTo(sx - 5, sy + 5);
          ctx.stroke();
        };
        for (const i of e.units) mark(scn.units[i].x, scn.units[i].y);
        for (const i of e.sprites) mark(scn.sprites[i].x, scn.sprites[i].y);
        for (const i of e.doodads) {
          const d = scn.doodads[i];
          const info = this.api.palette.doodadInfo(d.doodadId);
          mark((d.x + (info?.width ?? 1) / 2) * TILE, (d.y + (info?.height ?? 1) / 2) * TILE);
        }
      }
      return;
    }
    this.drawRendered(ctx, view, g.preview, color);

    // The count, by the pointer.
    const n = paintsCells(brush) ? g.preview.cells.length : g.preview.points.length;
    const label = paintsCells(brush) ? t("{n, plural, one {# tile} other {# tiles}}", { n }) : t("{n} × {what}", { n, what: brush.label });
    ctx.font = `10px ${getComputedStyle(document.body).getPropertyValue("--font-mono") || "monospace"}`;
    const tw = ctx.measureText(label).width;
    const lx = view.x(g.to.x) + 12, ly = view.y(g.to.y) + 12;
    ctx.fillStyle = "rgba(10,12,16,0.8)";
    ctx.fillRect(lx - 4, ly - 11, tw + 8, 15);
    ctx.fillStyle = teal;
    ctx.fillText(label, lx, ly);
  }

  private drawRendered(ctx: CanvasRenderingContext2D, view: MapView, r: Rendered, color: string) {
    const brush = this.brush;
    if (paintsCells(brush)) {
      ctx.fillStyle = brush.kind === "fog" ? (brush.mode === "fog" ? "rgba(0,0,0,0.55)" : "rgba(255,255,255,0.25)") : `${color}99`;
      for (const c of r.cells) ctx.fillRect(view.x(c.x * TILE), view.y(c.y * TILE), view.tilePx, view.tilePx);
      return;
    }
    if (brush.kind === "unit") {
      const w = brush.size.width * view.zoom, hh = brush.size.height * view.zoom;
      r.points.forEach((p, i) => {
        const owner = r.owners[i] ?? brush.owner;
        const c = owner === brush.owner ? color : this.api.palette.playerColor(owner);
        if (this.art(ctx, view, this.api.graphics.unitImage(brush.unitId, { owner }), p)) return;
        ctx.fillStyle = `${c}55`;
        ctx.strokeStyle = c;
        ctx.fillRect(view.x(p.x) - w / 2, view.y(p.y) - hh / 2, w, hh);
        ctx.strokeRect(Math.round(view.x(p.x) - w / 2) + 0.5, Math.round(view.y(p.y) - hh / 2) + 0.5, Math.round(w) - 1, Math.round(hh) - 1);
      });
      return;
    }
    if (brush.kind === "doodad") {
      const w = brush.info.width * view.tilePx, hh = brush.info.height * view.tilePx;
      const picture = this.api.graphics.doodadImage(brush.info.id);
      for (const p of r.points) {
        const x = view.x((Math.round(p.x / TILE - brush.info.width / 2)) * TILE), y = view.y((Math.round(p.y / TILE - brush.info.height / 2)) * TILE);
        if (picture) {
          ctx.globalAlpha = GHOST_ALPHA;
          ctx.drawImage(picture.image, x, y, w, hh);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = `${color}44`;
          ctx.fillRect(x, y, w, hh);
        }
        ctx.strokeStyle = color;
        ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w) - 1, Math.round(hh) - 1);
      }
      return;
    }
    const radius = Math.max(3, Math.min(8, 8 * view.zoom));
    const sprite = brush.kind === "sprite" ? brush : null;
    r.points.forEach((p, i) => {
      const owner = r.owners[i] ?? sprite?.owner ?? 0;
      const c = sprite && owner !== sprite.owner ? this.api.palette.playerColor(owner) : color;
      if (sprite && this.art(ctx, view, this.api.graphics.spriteImage(sprite.spriteKind, sprite.id, { owner, flipped: sprite.flipped }), p)) return;
      ctx.fillStyle = `${c}88`;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(view.x(p.x), view.y(p.y), radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    });
  }

  /**
   * The thing's real picture, centred on a point and faded, when the graphics are in
   * memory. `api.graphics` hands back the canvas the viewport itself blits, so a preview
   * of two hundred marines costs two hundred `drawImage` calls and no rendering.
   */
  private art(ctx: CanvasRenderingContext2D, view: MapView, picture: { image: CanvasImageSource; width: number; height: number } | null, p: Point): boolean {
    if (!picture) return false;
    const w = picture.width * view.zoom, h = picture.height * view.zoom;
    ctx.globalAlpha = GHOST_ALPHA;
    ctx.drawImage(picture.image, view.x(p.x) - w / 2, view.y(p.y) - h / 2, w, h);
    ctx.globalAlpha = 1;
    return true;
  }
}

/** One object at a point, the way its palette would place it; false when it could not go there. */
function place(tx: EditTransaction, brush: Brush, p: Point, owner: number, s: Settings): boolean {
  switch (brush.kind) {
    case "unit":
      if (s.checkPlacement && !tx.canPlaceUnit(brush.unitId, p.x, p.y)) return false;
      tx.placeUnit(brush.unitId, owner, p.x, p.y);
      return true;
    case "sprite":
      tx.placeSprite(brush.spriteKind, brush.id, owner, p.x, p.y, { flipped: brush.flipped, disabled: brush.disabled });
      return true;
    case "doodad":
      return tx.placeDoodad(brush.info.id, Math.round(p.x / TILE - brush.info.width / 2), Math.round(p.y / TILE - brush.info.height / 2)) >= 0;
    default:
      return false;
  }
}

/* ── The panel ──────────────────────────────────────────── */

/** How far the preview art is faded, so the map stays readable under it. */
const GHOST_ALPHA = 0.7;

const LAYER_NAMES: Record<string, string> = { terrain: msg("Terrain"), fog: msg("Fog of War"), doodads: msg("Doodads"), units: msg("Units"), sprites: msg("Sprites") };

function mountPanel(session: Session, body: HTMLElement): () => void {
  const s = session.settings;
  const api = session.api;
  body.append(h("style", null, STYLE));

  /* brush */
  const swatch = h("span", { className: "pnt-sw" });
  const brushName = h("b");
  const brushHint = h("span", { className: "pnt-dim" });
  const brushBox = h("div", { className: "pnt-brush" }, h("div", null, swatch, brushName), brushHint);

  /* tools */
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  const tools = h("div", { className: "pnt-tools" }, ...TOOLS.map((tool) => {
    const b = h("button", { className: "pnt-tool", type: "button", title: translate(tool.hint), onClick: () => (session.active === tool.id ? session.stop() : session.start(tool.id)) },
      h("span", { className: "pnt-glyph" }, tool.glyph), translate(tool.label));
    toolButtons.set(tool.id, b);
    return b;
  }));

  /* options */
  const row = (label: string, ...inputs: Child[]) => h("div", { className: "pnt-row" }, h("label", null, label), h("div", { className: "pnt-in" }, ...inputs));
  const change = (fn: () => void) => () => { fn(); session.save(); update(); session.tool?.redraw(); };

  const filled = h("input", { type: "checkbox", checked: s.filled, onChange: change(() => { s.filled = filled.checked; }) });
  const pattern = h("select", { onChange: change(() => { s.pattern = pattern.value as FillPattern; }) },
    h("option", { value: "grid" }, t("grid")), h("option", { value: "staggered" }, t("staggered")), h("option", { value: "random" }, t("random")));
  pattern.value = s.pattern;
  const filledRow = row(t("Fill"), h("label", { className: "pnt-check" }, filled, t("filled")), pattern);

  const spacing = h("input", { type: "number", min: 0, max: 512, step: 1, value: s.spacing, onChange: change(() => { s.spacing = Math.max(0, Number(spacing.value) || 0); spacing.value = String(s.spacing); }) });
  const spacingAuto = h("span", { className: "pnt-dim" });
  const spacingRow = row(t("Spacing"), spacing, h("span", { className: "pnt-dim" }, "px"), spacingAuto);

  const jitter = h("input", { type: "range", min: 0, max: 100, step: 5, value: s.jitter, onInput: change(() => { s.jitter = Number(jitter.value); }) });
  const jitterOut = h("output");
  const jitterRow = row(t("Jitter"), jitter, jitterOut);

  const width = h("input", { type: "range", min: 1, max: 9, step: 1, value: s.width, onInput: change(() => { s.width = Number(width.value); }) });
  const widthOut = h("output");
  const widthRow = row(t("Width"), width, widthOut);

  const starPoints = h("input", { type: "number", min: 3, max: 24, step: 1, value: s.starPoints, onChange: change(() => { s.starPoints = Math.min(24, Math.max(3, Math.round(Number(starPoints.value) || 5))); starPoints.value = String(s.starPoints); }) });
  const starInner = h("input", { type: "range", min: 20, max: 100, step: 5, value: Math.round(s.starInner * 100), onInput: change(() => { s.starInner = Number(starInner.value) / 100; }) });
  const starOut = h("output");
  const starRow = row(t("Star"), starPoints, h("span", { className: "pnt-dim" }, t("points")), starInner, starOut);

  const text = h("input", { type: "text", value: s.text, placeholder: t("type here, then click the map"), spellcheck: false, onInput: change(() => { s.text = text.value; }) });
  const textRow = row(t("Text"), text);

  const owners = h("select", { onChange: change(() => { s.owners = owners.value as OwnerMode; }) },
    h("option", { value: "palette" }, t("the palette's player")), h("option", { value: "cycle" }, t("cycle players 1–8")), h("option", { value: "random" }, t("a random player")));
  owners.value = s.owners;
  const ownersRow = row(t("Players"), owners);

  const check = h("input", { type: "checkbox", checked: s.checkPlacement, onChange: change(() => { s.checkPlacement = check.checked; }) });
  const checkRow = row(t("Units"), h("label", { className: "pnt-check" }, check, t("skip ones the placement checks refuse")));

  const keys = h("div", { className: "pnt-keys" },
    h("kbd", null, "Shift"), " ", t("squares a box, rounds an ellipse, snaps a line to 45°."), " ", h("kbd", null, "Alt"), " ", t("draws a box from its centre."), " ",
    h("kbd", null, "Esc"), " ", t("drops the shape in progress; again, or a right-click, leaves the tool. Every stroke is one undo step."));

  body.append(h("div", { className: "pnt" }, brushBox, tools, filledRow, spacingRow, jitterRow, widthRow, starRow, textRow, ownersRow, checkRow, keys));

  const update = () => {
    const brush = session.brush;
    const tool = s.tool;
    const active = session.active;
    const cells = paintsCells(brush);
    const layer = api.selection.layer();
    swatch.style.background = brush.color ?? "transparent";
    swatch.style.visibility = brush.color ? "visible" : "hidden";
    brushName.textContent = brush.kind === "none" ? t("Nothing to paint") : brush.label;
    brushHint.textContent = brush.kind === "none"
      ? brush.label
      : `${t("what the {layer} palette has picked", { layer: LAYER_NAMES[layer] ? translate(LAYER_NAMES[layer]) : layer })} · ${active ? translate(TOOL_BY_ID[active].hint) : t("pick a tool")}`;
    for (const [id, b] of toolButtons) b.classList.toggle("on", active === id);
    const objects = !cells && brush.kind !== "none";
    const on = (el: HTMLElement, yes: boolean) => el.classList.toggle("off", !yes);
    on(filledRow, CLOSED.has(tool));
    pattern.disabled = !s.filled || cells;
    on(spacingRow, objects && tool !== "eraser");
    on(jitterRow, objects && tool !== "eraser" && tool !== "spray");
    on(widthRow, cells || tool === "eraser" || tool === "spray");
    on(starRow, tool === "star");
    on(textRow, tool === "text");
    on(ownersRow, brush.kind === "unit" || brush.kind === "sprite");
    on(checkRow, brush.kind === "unit");
    spacingAuto.textContent = s.spacing > 0 ? "" : t("auto: {n}", { n: autoSpacing(brush) });
    jitterOut.textContent = `${s.jitter}%`;
    widthOut.textContent = cells && tool === "text" ? t("{n, plural, one {# tile} other {# tiles}} / pixel", { n: s.width }) : t("{n, plural, one {# tile} other {# tiles}}", { n: s.width });
    starOut.textContent = s.starInner >= 1 ? t("polygon") : `${Math.round(s.starInner * 100)}%`;
  };
  session.refresh.push(update);
  update();
  return () => { session.refresh = session.refresh.filter((r) => r !== update); };
}

/* ── activate ───────────────────────────────────────────── */

export default function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  t = (text, params) => api.i18n.t(text, params);
  translate = (text) => api.i18n.t(text);
  const session = new Session(api);

  // The panel's body, so a language change can build it again in place (closing it would stop the tool).
  let mounted: { body: HTMLElement; cleanup: () => void } | null = null;
  const mount = (body: HTMLElement) => {
    body.replaceChildren();
    mounted = { body, cleanup: mountPanel(session, body) };
    return () => { mounted?.cleanup(); mounted = null; };
  };
  const openPanel = () => {
    if (session.panel?.isOpen()) return;
    session.panel = api.ui.panel({
      title: t("Paint"),
      width: 292,
      mount,
      onClose: () => { session.panel = null; session.stop(); },
    });
    if (!session.active) session.start(session.settings.tool);
  };

  // Named actions, so the menu, the context menu, the hotkey — and another plugin —
  // all reach the same ones. `paint.tool` takes a tool id: `api.commands.run("paint.tool", "line")`.
  api.commands.register({ id: "open", title: msg("Paint…"), enabled: () => api.document.isOpen(), run: openPanel });
  api.commands.register({
    id: "tool",
    title: msg("Paint with a tool"),
    enabled: () => api.document.isOpen(),
    run: (id) => {
      const tool = TOOLS.find((t) => t.id === id);
      if (!tool) { api.ui.status(t("Paint: no tool called \"{id}\"", { id: String(id) })); return; }
      openPanel();
      session.start(tool.id);
    },
  });

  api.menu.add("Tools", { label: msg("Paint…"), enabled: () => api.document.isOpen(), command: "open" });
  api.contextMenu.add("viewport", { label: msg("Paint…"), command: "open" });
  api.hotkeys.add("Ctrl+Shift+P", { command: "open" });
  for (const event of ["palette", "layer", "document", "settings"] as const) {
    api.events.on(event, () => { session.rebrush(); session.wantArt(); });
  }
  api.events.on("language", () => {
    session.rebrush();
    session.panel?.setTitle(t("Paint"));
    if (mounted) { mounted.cleanup(); mount(mounted.body); }
    if (session.tool?.isActive()) session.start(session.settings.tool);
  });
  // A GRP arriving mid-stroke changes what the preview can draw.
  api.graphics.onImageLoaded(() => session.tool?.redraw());
}
