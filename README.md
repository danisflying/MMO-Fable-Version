# Basic MMO

A small but architecturally complete MMO: authoritative world server, Three.js browser client, browser-based world editor, server-side ECS simulation, interest-managed entity streaming, and GLB assets. TypeScript everywhere, shared code via an npm-workspaces monorepo.

## Quick start

```sh
npm install
npm run gen:models   # generates placeholder GLBs into assets/models (already committed)

npm run dev:server   # world server on :8080 (WebSocket + /assets)
npm run dev:client   # game client on http://localhost:5173
npm run dev:editor   # world editor on http://localhost:5174 (token: dev)
```

Open two client tabs with different names to see entity streaming, movement, chat, and combat between players. Walk toward the goblin spawner at (25, -20) to fight NPCs, or talk to the villager near spawn (press F) to pick up quests.

## Packages

| Package | Role |
| --- | --- |
| `packages/shared` | Hand-rolled ECS (entities, component stores, dirty tracking), networked component definitions, WebSocket protocol types, world-definition types, constants |
| `packages/server` | Authoritative simulation at 20 Hz: input → NPC AI → movement → combat → death → respawn, then snapshots at 10 Hz. Spatial-hash interest management streams spawn/despawn/delta per player. JSON persistence for world + players |
| `packages/client` | Three.js client: GLB loading with placeholder fallback, client-side prediction with server reconciliation for the local player, 150 ms interpolation buffer for remote entities, chat/HUD/targeting UI |
| `packages/editor` | Three.js world editor: place/move/rotate/scale GLB props (W/E/R gizmo), NPC spawners, player spawn point, terrain sculpting + painting. Edits apply to the live server (players see them immediately); Save writes `assets/world/world.json` |

## Controls

**Client (WoW-style):** W/S run forward / backpedal (slower) · Space jumps · A/D turn the character, or strafe while right mouse is held · Q/E strafe · left-drag orbits the camera without turning · right-drag steers the character · both buttons = run forward · wheel zoom; the camera drifts back behind you while moving. Tab cycles nearby NPCs (selection ring shows the target); clicking targets too (forgiving hit test — a near-miss on a moving character still lands), and clicking a quest NPC within range opens their dialog directly. Esc clears. Abilities on keys 1–4 (Strike, Heavy Blow, Fireball, Heal) with server-validated range and cooldowns — definitions live in [packages/shared/src/abilities.ts](packages/shared/src/abilities.ts), and each carries a particle effect (impact burst, traveling bolt, or heal sparkles). NPCs fight with ability kits of their own: goblins open with a Frenzy burst then Gnash away, and shamans cast a ranged Spark bolt and Mend themselves below half health. NPC kinds are **world data** — model, max HP, friendly/hostile, and ability kit are defined per kind in the editor's NPC Library and stored in `world.json` (`WorldDef.npcs`); older worlds get defs derived from their existing spawners at load. Enter to chat (`/g ` prefix for global, otherwise proximity chat). F interacts with the nearest quest NPC, L toggles the quest log.

## Quests & XP

Friendly NPCs (villager near spawn, guard on the east road) offer quests — press **F** near one to talk, **L** to toggle the quest log. A yellow `!` over an NPC means a quest is available, `?` means a turn-in is ready. Three objective types: kill N of an NPC kind, talk to an NPC, and reach a location; quests award XP (kills give a little too) and levels derive from a shared curve. Quest content is **world data**: it lives in `world.json` (`WorldDef.quests`), is edited in the editor's Quest Builder, and is pushed to clients at join (and live on edit) via `questDefs` messages — worlds without a `quests` key inherit the starter chain from [packages/shared/src/quests.ts](packages/shared/src/quests.ts). The server sanitizes all quest definitions ([sanitizeQuestDefs](packages/shared/src/quests.ts)) and validates every accept/turn-in (range, prereqs, completion) in [packages/server/src/game/quests.ts](packages/server/src/game/quests.ts); progress replicates only to the owning player via `questState` messages. Starter chain: **Goblin Cull** (kill 5 goblins), **Word to the Watch** (talk to the guard), then **Scout the Camp** (reach the goblin camp).

**Editor:** login with token `dev` (override with `EDITOR_TOKEN` env var on the server). The UI is a menu bar + toolbar over a full-screen viewport, with floating windows (drag by title bar, positions persist; toggle via the **Windows** menu, **F1–F4**, or restore defaults with Reset Layout): the **Asset Manager** (F2) lists models — click one then click the ground to place · toolbar or Unity-style hotkeys: **Q** select, **W** move, **E** rotate, **R** scale (props only), **T** terrain, Delete to remove · the **Inspector** (F1, auto-opens on select) edits the selection's properties directly (prop model/position/rotation/scale; spawner kind/model/count/respawn/aggro — kind/model/count changes respawn the NPCs live) · the **Quest Builder** (F3) creates and edits quests (objectives, rewards, prereqs; reach objectives have a pick-on-map button) and applies them to the running server immediately — online players get the new content pushed live · the **NPC Library** (F5, or "Manage NPCs…" in Spawner Settings) defines NPC kinds — model, max HP, friendly/hostile, ability kit — and applies changes live (spawned NPCs repopulate with the new stats); Spawner Settings and the spawner Inspector pick from these kinds · the **Terrain** window (F4, opens with the Terrain tool) has **Raise / Lower / Smooth / Flatten / Paint** brushes with radius + strength sliders (Shift inverts Raise/Lower); drag on the ground to sculpt hills or paint grass/dirt/rock/sand/path layers, and every stroke streams to the running server so online players walk the new ground instantly · **Save World** (toolbar, File menu, or Ctrl+S) persists everything (including quests and terrain) to `world.json`.

## Terrain

The ground is a 129×129 heightmap over a 220-unit square ([packages/shared/src/terrain.ts](packages/shared/src/terrain.ts)), stored in `world.json` as base64 (`terrain` key; worlds without it are flat). Both the mesh and the simulation sample the **same triangles** — `heightAt` interpolates exactly the two triangles per grid cell that the renderer draws, and since server and client decode identical Float32 data, prediction stays bit-exact on slopes (walking, jumping, and landing all resolve to the same floats on both sides). Movement follows the ground everywhere — slopes never block. Painting writes per-vertex layer weights (grass/dirt/rock/sand/path) that blend into vertex colors; there are no texture assets involved. Editor brush strokes go out as small absolute region patches (`editor:terrain` → `terrainPatch`), applied live by the server (which re-seats props, NPCs, and grounded players on the new ground) and by every connected client.

## Data & persistence

- `assets/models/*.glb` — models, served by the server at `/assets/models/<name>.glb`; drop in new GLBs and they appear in the editor palette automatically (`/assets/models/index.json`). Players use `Character_3.glb`; its `Idle`/`Walking`/`Running` clips drive locomotion by measured speed and `Cast Spell` plays on attack. Any animated GLB with similarly named clips animates the same way.
- `assets/world/world.json` — world layout (props, spawners, spawn point, bounds, quests, NPC definitions, terrain), loaded at server boot, written by the editor's Save.
- `data/players/<name>.json` — player position/hp/xp/quest progress, saved on disconnect and every 30 s (old pos/hp-only saves still load).

## Collision

Props (trees, rocks, anything placed in the editor) block players and NPCs via 2D circle colliders on the XZ plane. Radii are auto-derived from each GLB's bounding box at server boot ([glbBounds.ts](packages/server/src/assets/glbBounds.ts), with a per-model override table) and sent to clients in `welcome`, so client prediction resolves the exact same circles in the exact same order ([shared collision.ts](packages/shared/src/collision.ts)) — sliding along a wall stays bit-exact with the server. Players and NPCs don't body-block each other (WoW-style). Editor edits rebuild colliders live.

## How the networking works

Clients send *inputs*, never positions. The server simulates and, every snapshot tick, sends each player only what's within `AOI_RADIUS` (50 units): full snapshots for entities entering range, ids for entities leaving, and per-component deltas (dirty-flag tracked in the ECS) for the rest. The client renders remote entities ~150 ms in the past, interpolating between snapshots, while predicting its own movement locally and reconciling against `inputAck` messages.

## Tests

```sh
npm test                            # ECS unit tests (vitest)
node scripts/smoke-test.mjs           # 2-client e2e: streaming, movement, chat, combat, AOI (server must be running)
node scripts/smoke-test-editor.mjs    # editor protocol e2e: auth, live edits, save round-trip
node scripts/smoke-test-movement.mjs  # prediction exactness under send jitter + jump physics
node scripts/smoke-test-quests.mjs    # quest e2e: accept/kill/talk/reach/turn-in, XP, persistence, reconnect
node scripts/smoke-test-questbuilder.mjs  # editor quest builder e2e: setQuests live push, inspector updates
npm run build                       # typecheck + production builds
```
