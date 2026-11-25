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

**Biomes, Biome drawer, World.** Not built.

## Rules carried over from the first Universe Builder

- The Builder edits data only and never judges: a verdict is Unreal's `probe verdict` line.
- No route takes a path or a command from the browser. Refresh runs one fixed command.
- Every option should become a row in a field table (page, API and agent access from one definition).
