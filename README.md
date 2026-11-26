# Universe Builder (Unreal)

The authoring tool for Whispering Worlds on the Unreal port, rebuilt from scratch (2026-11-25). It edits data files in
the Unreal project; Unreal builds, renders and judges. Node built-ins only, no build step.

## Run

```powershell
node server.mjs
# -> http://127.0.0.1:8790
```

| variable | default | what it does |
| --- | --- | --- |
| `PORT` | `8790` | HTTP port |
| `WW_BUILDER_HOST` | `127.0.0.1` | address to listen on; anything beyond this machine is refused without a token |
| `WW_BUILDER_TOKEN` | empty | when set, every API and thumbnail request needs `Authorization: Bearer <token>` |
| `WW_UNREAL_PROJECT` | `../whispering-worlds-unreal` | the Unreal project that is read and written |
| `WW_UNREAL_EDITOR` | the 5.8 launcher install's `UnrealEditor-Cmd.exe` | what Refresh runs |

## Sections

**Assets (built).** Every static mesh in the Unreal project, from Unreal's own export
(`-run=WWExportCatalog` -> `Saved/Catalog/catalog.json`, schema `ww-unreal-catalog/1`, plus the packs' stored thumbnails).
Search, filter by pack, role and review state; select cards (shift-click for a run) and set a role or approve/reject.
Roles and review status are written to the project's `Config/Assets/roles.json` (`ww-asset-roles/1`), the only file
this section writes. A role shown dashed is Unreal's guess from the file name, not a decision.

**Biomes (built).** One palette document per biome, `Config/Biomes/<id>.json` (`ww-biome-palette/1`): which catalogue
meshes fill each role, and the ground and scatter numbers. Ranges and role names come from the project's own field table
(`Config/Biomes/fields.json`). "Build and render in Unreal" runs `Tools/meadow-look.ps1 -Pack biome:<id> -Look <look> -Run ub`
and shows the three views and Unreal's verdict lines.

**Kits (built).** A catalogue of the downloaded asset and animation packs (`kits.registry.json`) and what each is used for.

**Biome drawer (built).** Draws one biome as a plan, `Config/Plans/<id>.json` (`ww-biome-plan/1`, the contract is the
Unreal project's `Docs/BIOME-PLAN.md` and `Docs/WORLD-PIPELINE.md` section 3). The canvas is in world metres (x right,
y down), pans by drag and zooms by wheel or pinch, and draws in this order: sea and land outline, areas in paint order
shaded by height (dark edge for a cliff, dashed for a bank), slopes (hatched), zones, rivers, paths, ramps, anchors.
Every optional member may be absent.

- Select by click or from the list. Drag a point; the small dot on an edge adds a point there; tap a point and
  "Delete point" (or Delete) removes it; the square handle moves the whole feature.
- "Draw new" starts an area, slope, zone, path, river, ramp, anchor or the land outline: click the points, finish with a
  double-click, Enter or Done.
- The Selected panel edits a feature's id, kind and numbers; "Paint earlier / later" reorders areas. Plan settings hold
  the label, biome, size, ground, edges and sea. An empty number means "absent": Unreal's default applies.
- Undo and redo per edit (Ctrl+Z, Ctrl+Y). Problems are listed as you edit, each with its key path
  (`areas[2].outer[5]`), from the same check the save uses.
- Save is refused with the list of problems, or when the file changed on disk since it was loaded (a hash of the file's
  text is the revision). "New plan" saves a copy of the open drawing under a new id.
- Build runs `powershell -NoProfile -ExecutionPolicy Bypass -File <project>\Tools\meadow-look.ps1 -Pack biome:<plan.biome>
  -Look <look> -Plan <id> -Run ub` from the saved file, then shows the views that are newer than the build's start
  (overview, spawn, way-up, shelf, viewpoint, summit, from `Views\meadow-biome<biome>-<look>-ub\`), the
  `probe verdict` lines and the `probe wwWorldGuide` line.

The ranges, kinds and defaults are one table in `plans.mjs`, transcribed from Unreal's reader (`WWReadBiomePlan` in
`Source/WhisperingWorlds/World/WWBiomePlan.cpp`); the reader is the truth, and when the two disagree the table is the
one to fix. It moves to the project's `Config/Plans/fields.json` when that file exists. Not in the drawer yet: drawing a
hole in a shape or a second shape on one feature (existing ones show and their points can be dragged), and a field
table read from the project.

**World.** Not built.

One Unreal run at a time across the Builder: a catalogue refresh, a biome preview and a plan build refuse each other
while one is running.

## API

| route | does |
| --- | --- |
| `GET /api/catalog`, `PUT /api/assets/role`, `POST`/`GET /api/catalog/refresh` | Assets |
| `GET /api/biomes`, `GET`/`PUT /api/biomes/<id>`, `POST /api/biomes/<id>/check`, `POST /api/biomes/<id>/preview`, `GET /api/biomes/preview`, `GET /previews/<id>/<look>/<view>.png` | Biomes |
| `GET /api/plans` | the plans, the looks, the biome palettes and the field table |
| `GET /api/plans/<id>` | `document`, `revision`, `problems` |
| `POST /api/plans/<id>/check` | `problems` for the `document` in the body; writes nothing |
| `PUT /api/plans/<id>` | save `document` with the `revision` it was loaded at (409 `stale` if the file changed, 422 with `details` if it has problems); `create: true` makes a new plan and refuses an existing one (409 `exists`) |
| `POST /api/plans/<id>/build` | body `{ "look": "<look id>" }`; starts the one fixed command (409 `busy` while Unreal is running) |
| `GET /api/plans/build` | `running`, and `last`: `ok`, `images`, `verdicts`, `guide`, `lines` |
| `GET /plan-views/<view>.png` | a view of the last build, by its fixed name |

Plan and look ids match `^[a-z0-9][a-z0-9-]{0,47}$` and must name a file that exists.

## Rules carried over from the first Universe Builder

- The Builder edits data only and never judges: a verdict is Unreal's `probe verdict` line.
- No route takes a path or a command from the browser. Refresh runs one fixed command.
- Every option should become a row in a field table (page, API and agent access from one definition).
