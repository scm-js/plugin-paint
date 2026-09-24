# Paint

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It draws shapes out of the map's own pieces.

Pick a tool in the Paint panel and draw on the map. Whatever the active layer's palette
has picked is what gets laid down: flat terrain or a single tile, a doodad, a unit for a
player, a sprite, or fog of war for some players. Draw a line of Photon Cannons, fill an
ellipse with Zerglings, ring a base with a staggered grid of Missile Turrets, write "GG"
in Mineral Fields, or carve a star into the high ground. Every stroke is one undo step.

The preview under the pointer is the real thing: units, sprites and doodads are drawn with
the graphics the map itself draws them with, so you see the shape you are about to lay down
before you let go.

## Install

In scmJS: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-paint
```

and press **Add**. It is normally already in that list, marked *default* and switched off:
tick it to turn it on. To pin a version, add a ref: `github:scm-js/plugin-paint@v1.0.0`.

## Use

**Tools ▸ Paint…** (also `Ctrl+Shift+P`, or *Paint…* on the map's right-click menu) opens
the panel. It floats over the map and does not block it; drag it by its title bar.

The top of the panel says what will be painted, which is what the active layer's palette
has picked: choose a unit and a player on the Units layer, a doodad on the Doodads layer,
a terrain or a tile on the Terrain layer, and so on. Switch layers and the brush follows.

| Tool | What you do |
| --- | --- |
| Freehand | Drag. |
| Line | Drag from one end to the other. Shift snaps to 45°. |
| Rectangle, Ellipse | Drag a corner to the opposite corner. Shift makes it square or round; Alt draws from the centre. |
| Polygon | Click the corners; click the first corner again (or double-click) to finish. |
| Star | Drag from the centre outwards. The drag sets the size and turns the star. *Points* and the inner radius are in the panel; an inner radius of 100% is a regular polygon. |
| Spray | Drag to scatter. *Width* is the radius. |
| Text | Type in the panel, then click where the text starts. Letters are a 5 × 7 dot font, one object (or one tile) per dot. |
| Eraser | Drag over units, sprites or doodads to remove them (the layer's kind). *Width* is the radius. |

Options:

- **Filled** fills a rectangle, ellipse, polygon or star. Objects fill in a grid, a
  staggered (hex) grid, or at random.
- **Spacing** is the distance between objects along a shape, in pixels. *Auto* uses the
  object's own size, so buildings do not overlap and small units stand shoulder to shoulder.
- **Jitter** moves each object a little way off its spot, for a natural look.
- **Width** is the brush width in tiles for terrain and fog, the eraser's and the spray's
  radius, and the size of one text dot on those layers.
- **Players** paints units and sprites for the palette's player, or cycles through
  players 1–8 along the shape, or picks a random one for each.
- **Units** can skip the spots the Units palette's placement checks refuse (a unit already
  there, ground the unit cannot stand on), with the same options the palette uses.

`Esc` drops the shape in progress; `Esc` again, or a right-click, leaves the tool. Terrain
is painted as flat tiles, like the Rect brush, so run Rebuild ISOM from Tiles afterwards
if you want the isometric brush back on that ground.

## Layout

| | |
| --- | --- |
| `plugin.json` | the manifest the editor reads (name, version, `entry`, `icon`, the API version it needs) |
| `plugin.ts` | `activate(api)`: the panel, the tools, the preview overlay, the transaction |
| `shapes.ts` | the pure geometry: outlines, sampling along and inside them, tile rasterising, text layout |
| `font.ts` | the 5 × 7 dot font |
| `dist/plugin.js` | the bundle the editor loads; `npm run build` writes it, CI commits it |
| `tests/` | vitest over `shapes.ts` |

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's own `src/plugins/api.ts`; `npm update @scm-js/plugin-api` takes the
newest contract.

## Development

```sh
npm install
npm run typecheck
npm test
```

`dist/plugin.js` is what the editor loads (`build` in the manifest): `npm run build` writes
it with esbuild, and CI commits it on every push to `main` and checks at a tag that it is
what the source builds to. Run `npm run dev` while you work so the bundle follows your
edits. To try local changes, serve this directory with CORS enabled (`npx serve --cors .`)
and add `http://localhost:3000/` in Manage Plugins, then use **Reload** after each edit.

A plugin runs with the editor's own privileges. There is no sandbox.

See [`docs/plugins.md`](https://github.com/scm-js/scm-js/blob/main/docs/plugins.md) in the editor
for the API tour; this plugin is the worked example for `api.ui.mapTool`, `api.ui.panel` and
`api.palette`.

## Licence

MIT — see [LICENSE](LICENSE).
