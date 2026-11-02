# Paint

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It draws lines, shapes, sprays and text out of the map's own pieces.

You pick a tool and draw on the map. What gets laid down is whatever the active layer's
palette has picked:

- flat terrain or a single tile
- a doodad
- a unit for a player
- a sprite
- fog of war for some players

You can draw a line of Photon Cannons, fill an ellipse with Zerglings, or write "GG" in
Mineral Fields. The preview under the pointer uses the map's own graphics, so you see the
result before you let go. Every stroke is one undo step.

## Install

Paint comes with the editor and is on by default. If you turned it off, tick it on again
in Plugins ▸ **Manage Plugins…**.

To add it by hand, open Plugins ▸ **Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-paint
```

and press **Add**. To pin a version, add a tag: `github:scm-js/plugin-paint@v1.1.0`.

## Use

Open the panel with Tools ▸ **Paint…**, Ctrl+Shift+P, or **Paint…** in the map's
right-click menu. The panel floats over the map and does not block it. Drag it by its
title bar.

The top of the panel says what will be painted. Choose a unit and a player on the Units
layer, a doodad on the Doodads layer, a terrain or a tile on the Terrain layer, and so on.
When you switch layers, the brush follows.

| Tool | What you do |
| --- | --- |
| Freehand | Drag. |
| Line | Drag from one end to the other. Shift snaps to 45°. |
| Rectangle, Ellipse | Drag from corner to corner. Shift makes it square or round. Alt draws from the centre. |
| Polygon | Click the corners. Click the first corner again, or double-click, to finish. |
| Star | Drag from the centre outwards. The drag sets the size and turns the star. The number of points and the inner radius are in the panel. An inner radius of 100% gives a regular polygon. |
| Spray | Drag to scatter. **Width** is the radius. |
| Text | Type in the panel, then click where the text starts. Letters use a 5 × 7 dot font, with one object (or one tile) per dot. |
| Eraser | Drag over units, sprites or doodads to remove them. It removes the active layer's kind. **Width** is the radius. |

The panel's options:

- **Fill** fills a rectangle, ellipse, polygon or star. Objects fill in a grid, a staggered
  grid, or at random.
- **Spacing** is the distance between objects along a shape, in pixels. Auto uses the
  object's own size, so buildings do not overlap and small units stand side by side.
- **Jitter** moves each object a little off its spot, so the shape looks less regular.
- **Width** is the brush width in tiles for terrain and fog. It is also the radius of the
  eraser and the spray, and the size of one text dot on those layers.
- **Players** paints units and sprites for the palette's player, cycles through players
  1 to 8 along the shape, or picks a random player for each.
- For units, the panel can skip spots the placement checks refuse, such as a spot where a
  unit already stands or ground the unit cannot stand on. It uses the same checks as the
  Units palette.

Esc drops the shape in progress. Esc again, or a right-click, leaves the tool.

Terrain is painted as flat tiles, like the Rect brush. To use the isometric brush on that
ground again afterwards, run Tools ▸ **Repair Map…** (from the Repair plugin), which
rebuilds the isometric record from the tiles.

## Files

| File | What it is |
| --- | --- |
| `plugin.json` | The manifest the editor reads. |
| `plugin.ts` | The panel, the tools, the preview and the edits to the map. |
| `shapes.ts` | The geometry: outlines, points along and inside them, tiles, and text layout. |
| `font.ts` | The 5 × 7 dot font. |
| `ko.ts` | The Korean for the words the plugin shows. |
| `dist/plugin.js` | The bundle the editor loads. `npm run build` writes it and CI commits it. |
| `tests/` | Tests of `shapes.ts`, and a check that `ko.ts` is complete. |

## Development

```sh
npm install
npm run typecheck
npm test
npm run dev
```

`npm run dev` rebuilds `dist/plugin.js` on every change. To try your changes in the editor,
serve this folder with `npx serve --cors .`, add `http://localhost:3000/` in Plugins ▸
**Manage Plugins…**, and press **Reload** on the plugin's row after each edit.

The types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api). The
[plugin guide](https://docs.scmjs.dev/plugins/writing-a-plugin/) covers the API. This
plugin is the worked example for `api.ui.mapTool`, `api.ui.panel` and `api.palette`.

A plugin runs with the editor's own privileges. There is no sandbox.

## Licence

MIT. See [LICENSE](LICENSE).
