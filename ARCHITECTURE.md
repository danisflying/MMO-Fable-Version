# Architecture

This document explains how the game is put together: the entity-component-system (ECS) at its core, how the server simulates the world, how state gets to the browser, and where the rough edges are. It's meant to be readable by someone who knows TypeScript but has never touched this codebase (or ECS-style engines) before.

For controls, quest content, and "how do I run this" — see [README.md](README.md). This document is about *how the pieces fit together*, not how to play.

## The big picture

```
                       ┌────────────────────────┐
                       │   packages/shared       │
                       │  ECS core, components,  │
                       │  protocol types, math,   │
                       │  quest/ability defs      │
                       └───────────┬──────────────┘
                                   │ imported by everyone
              ┌────────────────────┼────────────────────┐
              │                    │                     │
   ┌──────────▼─────────┐ ┌────────▼─────────┐ ┌─────────▼──────────┐
   │  packages/server     │ │  packages/client  │ │  packages/editor    │
   │  authoritative sim    │ │  Three.js game     │ │  Three.js world      │
   │  @ 20 Hz, WebSocket   │◄┤  client, prediction│ │  editor, live-edits  │
   │  + HTTP asset server  │ │  + interpolation    │ │  the running server   │
   └──────────┬────────────┘ └────────────────────┘ └──────────────────────┘
              │
   assets/world/world.json (props, spawners, quests)
   data/players/<name>.json (per-player saves)
```

The server is the only source of truth. Clients never send positions — only *inputs* (movement axes, jump, ability presses). The server simulates everything and streams the results back. This is the standard pattern for anything that needs to resist a cheating client, and it's why prediction/reconciliation (below) exists: without it, every keypress would wait for a network round-trip before the character visibly moves.

## The ECS core ([packages/shared/src/ecs/](packages/shared/src/ecs))

If you haven't used an ECS before, the mental model is: **entities are just numbers**, and all the actual data lives in per-component-type tables keyed by entity id. There's no `Player` class or `Npc` class — a "player" is just an entity that happens to have a `PlayerTag`, `Transform`, `Health`, `Combat`, and `Velocity` component attached to it. This makes it cheap to mix and match: a prop is an entity with only `Transform`, `ModelRef`, and `PropTag` — no health, no velocity, because it never needs them.

**`component.ts`** — [defineComponent](packages/shared/src/ecs/component.ts) creates a `ComponentType<T>`, basically a typed, named "column" identifier. Components are plain data interfaces (see [components.ts](packages/shared/src/components.ts)): `TransformData { pos, rotY }`, `HealthData { hp, maxHp }`, `NpcAiData { state, home, target, ... }`, etc. There's no behavior on components — logic lives entirely in systems (below).

**`world.ts`** — [World](packages/shared/src/ecs/world.ts) is the actual store: one `Map<Entity, T>` per component type, plus a set of live entity ids. The methods to know:

| Method | What it does |
| --- | --- |
| `create()` / `destroy(e)` | allocate/free an entity id, and wipe it from every component store |
| `add(e, Type, data)` | attach a component, and mark it dirty |
| `get(e, Type)` / `require(e, Type)` | read a component (`require` throws if missing — used where absence would be a bug, not a valid state) |
| `query(...Types)` | all entities that have *every* listed component type. Implemented by iterating the smallest matching store and checking membership in the others — no indexes, just linear scans, which is fine at the entity counts this game runs (see [Improvements](#improvements)) |
| `markDirty(e, Type)` / `consumeDirty()` | the network layer's hook — see below |

**Dirty tracking is the ECS's one opinionated feature.** Every `add()` or explicit `markDirty()` call flags `(entity, componentType)` as changed. Once per snapshot tick, `consumeDirty()` drains that set and hands it to the network layer, which uses it to send only what actually changed since the last snapshot instead of re-sending full entity state 10 times a second. This is *the* mechanism that makes delta-compression possible — it's why every system that mutates a component also calls `world.markDirty(...)` right after (grep for it and you'll see the pattern everywhere: `movement.ts`, `combat.ts`, `death.ts`, the editor handlers).

## Components ([packages/shared/src/components.ts](packages/shared/src/components.ts))

| Component | Carries | Used by |
| --- | --- | --- |
| `Transform` | position + Y rotation | everything with a location |
| `Velocity` | x/y/z velocity | movement integration (players inline in `inputSystem`, NPCs in `movementSystem`) |
| `Health` | hp / maxHp | combat, death |
| `Combat` | attack range/damage/cooldown, plus a per-ability cooldown map for players | combat validation |
| `NpcAi` | AI state machine data (`wander`/`chase`/`return`, home, aggro/leash radius, current target) | `npcAiSystem` |
| `ModelRef` | which GLB to render, and its scale | client rendering + collider radius lookup |
| `PlayerTag` / `NpcTag` / `PropTag` | marks *what kind* of entity this is, plus a bit of identifying data (name / kind / propId) | queries filter on these constantly (`world.has(e, PlayerTag)`) |

`NETWORKED` is the subset of component types that ever get sent to clients (everything except `Velocity` and `NpcAi` — the client never needs an NPC's internal AI state, and velocity is implied by watching position change). `snapshotEntity`/`snapshotComponents` in [snapshot.ts](packages/shared/src/snapshot.ts) serialize against that list.

## The server tick ([packages/server/src/index.ts](packages/server/src/index.ts))

The server runs a fixed-timestep loop at `TICK_RATE = 20 Hz` (`TICK_MS = 50ms`, see [constants.ts](packages/shared/src/constants.ts)). Each tick runs the same six systems in the same order:

```
inputSystem   → consume one queued input per player, integrate their movement + jump physics
npcAiSystem   → advance each NPC's wander/chase/return state machine, queue NPC attacks
movementSystem → integrate NPC velocity into position (players were already moved by inputSystem)
combatSystem  → resolve all queued attacks (player abilities + NPC basic attacks) into damage
deathSystem   → hp<=0 → respawn players at spawn point, destroy NPCs and queue their respawn
respawnSystem → spawn NPCs whose respawn timer has elapsed
questSystem   → poll "reach" objectives (throttled to 4Hz internally, not every tick)
```

Order matters here: combat happens after movement so damage uses this tick's positions, and death happens right after combat so a killing blow is resolved the same tick it lands. Every 2nd tick (`SNAPSHOT_EVERY = 2`, so 10 Hz) `sendSnapshots()` runs and pushes network state to every connected player.

The loop itself (`loop()` at the bottom of `index.ts`) is a drift-correcting accumulator rather than a plain `setInterval(50)` — Windows' timer granularity is closer to ~15.6ms, so a naive `setInterval` free-runs at ~62ms/tick and the sim gradually falls behind. The accumulator runs extra "catch-up" ticks so the long-run average is exactly 20 Hz regardless of what the OS timer actually gives it.

**`GameCtx`** ([state.ts](packages/server/src/state.ts)) is the one god-object every system takes as a parameter: the `World`, the loaded `WorldDef`, the set of `Session`s, the spatial grid, prop colliders, per-spawner NPC tracking, and a few per-tick scratch lists (`pendingAttacks`, `combatEvents`, `npcRespawns`) that systems push into and `combatSystem`/`sendSnapshots` drain. It's a plain object, not a class with methods, deliberately — systems are just functions of `(ctx, dt)`.

## Networking ([packages/server/src/network/](packages/server/src/network))

`connections.ts` owns the WebSocket server and the per-client `Session` object ([state.ts](packages/server/src/state.ts)): entity id, queued inputs, quest state, XP. Incoming messages are a discriminated union (`ClientMessage`, see [protocol.ts](packages/shared/src/protocol.ts)) dispatched by a plain `switch (msg.t)`. Two things worth knowing:

- **Inputs are queued, not applied immediately.** `inputSystem` consumes exactly one per player per tick, so server state is a pure function of the input sequence — this is what lets client-side prediction replay the same inputs and get a bit-identical result (see below). There's a `MAX_BACKLOG` of 4 ticks before old inputs get dropped (and acked-away) to bound how far a stalled client can get the server to lag behind.
- **Attacks/abilities aren't applied inline either** — `case "attack"` just pushes onto `ctx.pendingAttacks`; `combatSystem` validates and resolves them together during the next tick, in one place, so there's a single choke point for range/cooldown/target checks instead of scattering them across message handlers.

`http.ts` is a plain `node:http` server (no framework) that serves `/assets/**` (GLBs, textures) with `Access-Control-Allow-Origin: *` so the client and editor — served from different Vite dev ports — can both load them.

## Interest management / streaming ([packages/server/src/streaming/](packages/server/src/streaming))

A naive implementation would broadcast every entity's full state to every client every tick. That doesn't scale, and most of it would be entities the player can't even see. Instead:

- **`SpatialGrid`** hashes entities into `GRID_CELL_SIZE`-sized XZ buckets, rebuilt from scratch every snapshot tick. `queryCircle(x, z, radius)` only inspects the handful of cells the radius overlaps.
- **`sendSnapshots()`** ([interest.ts](packages/server/src/streaming/interest.ts)), for each player, computes the current "area of interest" (`AOI_RADIUS = 50` units) via the grid, diffs it against what that player already knows (`Session.known`), and sends exactly three kinds of messages: `spawn` (full state, entities that just entered range), `despawn` (ids that left range or were destroyed), and `delta` (only-the-dirty-components of entities already known). Combat events get filtered to only ones involving an entity the player already knows about, so you don't get a floating damage number for a fight you can't see.

This means every player effectively has their own view of "the world," and the server is doing `O(players × nearby entities)` work per snapshot tick rather than `O(players × all entities)`.

## Client-side prediction & reconciliation ([packages/client/src/net/prediction.ts](packages/client/src/net/prediction.ts))

The core problem prediction solves: if the client waited for the server's response before moving the character, every step would feel like it has network lag baked in. Instead, `Prediction.applyInput()` integrates the *exact same* movement math locally, immediately, and queues the input. When the server's `inputAck` comes back (with the authoritative position for that input sequence), `ack()` rewinds to that authoritative state and **replays every input newer than the acked one** on top of it — so a late-arriving correction doesn't undo movement the player has already seen.

Two things make this exact rather than approximate:

1. `Prediction.step()` and the server's `inputSystem` integrate movement in the *same order* (jump trigger → airborne test → horizontal move → collision resolve → world-bounds clamp → gravity or ground-stick), using the same constants (`GRAVITY`, `JUMP_SPEED`, `PLAYER_MOVE_SPEED`) from shared `constants.ts`.
2. Both sides resolve prop collisions with the exact same function — [resolveCircleCollisions](packages/shared/src/collision.ts) — against collider lists that are guaranteed to be in the same sorted order (by entity id), because the client mirrors its collider list from the server's `colliderRadii` (sent once at `welcome`) and prop positions (streamed normally as entities).
3. Both sides sample ground height with the exact same function — [heightAt](packages/shared/src/terrain.ts) — over the exact same `Float32Array` (the heightmap is sent in `welcome` and kept in sync by `terrainPatch` messages), so slopes and landings resolve to identical floats. See the Terrain section below.

When the two do disagree (e.g., a prop moved in the editor and the client's mirror hasn't caught up yet, or float drift), `ack()` doesn't snap — small corrections (`< 2` units) are absorbed into a `corrX/corrZ` offset that decays 30%/tick, so the correction is invisible instead of a visible pop. Big corrections (like a death respawn teleport) *do* snap immediately, deliberately.

## Terrain ([packages/shared/src/terrain.ts](packages/shared/src/terrain.ts))

The ground is a square heightmap (129×129 vertices over 220 world units, centered on the origin) plus a per-vertex paint splatmap (4 weight channels over a grass base; blended into vertex colors — flat-shaded, no texture assets). Everything that matters about it lives in one shared module:

- **One surface, everywhere.** `heightAt(t, x, z)` interpolates over the *same two triangles per grid cell* that `terrainIndices()` emits for rendering — not a generic bilinear patch — so the simulated ground and the drawn ground are the identical surface. The server samples it for players (`inputSystem`), NPCs (`movementSystem`), and spawn/respawn positions; client prediction samples the same function over the same decoded `Float32Array`; both the client's and editor's meshes are built from the same shared position/index/color arrays (each package only wraps them in its own `THREE.BufferGeometry`).
- **Movement rule:** walkable everywhere. Grounded movers stick to the slope (`y = heightAt(...)` after the horizontal step); gravity only runs while jumping. A grounded player's `y` therefore always *equals* `heightAt(x, z)` exactly, which is what lets the jump trigger use a plain `<=` comparison instead of an epsilon.
- **Serialization:** heights and splat are base64 blobs (hand-rolled, little-endian codec in the same module so Node and browsers produce identical bytes) under `WorldDef.terrain` in `world.json`. Worlds without the key load flat, so old worlds and the smoke tests are untouched. The server keeps the decoded copy on `GameCtx.terrain` and only re-encodes on save and editor auth.
- **Live editing:** editor brushes (raise/lower/smooth/flatten/paint in [terrainPainter.ts](packages/editor/src/terrainPainter.ts)) mutate the editor's local copy immediately and stream *absolute region patches* (`editor:terrain`) at most every 120ms during a stroke. The server validates and applies each patch, re-seats props/NPCs/grounded players on the new ground, and rebroadcasts it as `terrainPatch` to every other session — patches carry absolute values, not deltas, so they're idempotent and ordering-tolerant. Because the sender is skipped, an echo can never revert a brush stroke that has already moved on.

## Remote entity interpolation ([packages/client/src/net/replication.ts](packages/client/src/net/replication.ts))

The local player is predicted; everyone else is interpolated. `Replication` keeps a ring buffer of the last `MAX_BUFFER = 20` position samples per entity (stamped with `performance.now()` on arrival), and `sample(id, renderTime)` linearly interpolates between the two samples straddling `renderTime`. The render loop asks for `renderTime = now - INTERP_DELAY_MS` (150ms in the past) rather than "now" — this trades 150ms of visual latency for guaranteed smoothness even under network jitter, since there are (almost) always two real samples on either side of a point 150ms in the past. A large jump between consecutive samples (>15 units) clears the buffer instead of interpolating through it, so a death-respawn teleport doesn't render as the character sliding across the map.

## Rendering ([packages/client/src/render/](packages/client/src/render))

`scene.ts` sets up the Three.js boilerplate once (lights, fog, resize handling); the ground itself is [render/terrain.ts](packages/client/src/render/terrain.ts)'s `TerrainMesh`, rebuilt from `welcome` and patched live by `terrainPatch`. `assets.ts` loads and caches GLBs by name — concurrent requests for the same model share one in-flight load, and each caller gets a skeleton-cloned copy so multiple instances of the same NPC don't share a skeleton. `entityViews.ts` is the biggest file on the client: it owns one `View` per networked entity (a Three.js `Group`, an `AnimationMixer`, a nameplate sprite) and reconciles it against `Replication`/`Prediction` state every frame — including picking a locomotion animation clip (idle/walk/run/fall) purely by *measuring how fast the rendered position is actually moving*, rather than trusting a "state" flag, which is a nice trick: it keeps animation in sync with prediction/interpolation smoothing automatically instead of needing its own state machine.

## The world editor ([packages/editor/](packages/editor))

The editor is a second client that authenticates with a token (`editor:auth`, default `"dev"`, override via `EDITOR_TOKEN`) and gets elevated message types (`editor:placeProp`, `editor:updateSpawner`, `editor:setQuests`, etc. — see the `EditorMessage` union in [protocol.ts](packages/shared/src/protocol.ts)). Crucially, edits apply to the **live running `GameCtx`** — [handlers.ts](packages/server/src/editor/handlers.ts) mutates `ctx.def` *and* spawns/destroys the corresponding ECS entities in the same handler, so online players see edits immediately through the normal snapshot/delta pipeline, not through some separate editor-preview channel. "Save" (`editor:save`) is the only step that persists `ctx.def` to `assets/world/world.json` — everything else is live-only until you save.

## Persistence

- **World layout** — `assets/world/world.json`, loaded once at boot ([worldLoader.ts](packages/server/src/persistence/worldLoader.ts)), written atomically by the editor's Save (temp file + rename, so a crash mid-write can't truncate it).
- **Players** — `data/players/<name>.json`, saved on disconnect and every 30s ([players.ts](packages/server/src/persistence/players.ts)). Position, hp, XP, quest progress. `sanitizeQuestState` repairs saves against the *current* quest definitions on load, so quest content can change after a player has already saved progress against the old version without corrupting their file.
- **Collider radii** are derived once at boot from each GLB's bounding box ([glbBounds.ts](packages/server/src/assets/glbBounds.ts)) by reading the raw glTF binary header and scanning `POSITION` accessor bounds — no GLB parsing library needed for this, just enough of the format to pull `min`/`max`. These are sent to clients once (in `welcome`) and never recomputed client-side, which is what guarantees prediction's collision math matches the server's.

## Combat & abilities ([packages/server/src/game/systems/combat.ts](packages/server/src/game/systems/combat.ts), [packages/shared/src/abilities.ts](packages/shared/src/abilities.ts))

Every attack — player or NPC — is an ability use, validated by one path (`applyAttack`): kit membership, per-ability cooldown, target liveness, range (+`RANGE_SLACK` latency forgiveness). An entity's kit is its Combat component's `abilities` list, which doubles as authorization: a player can't send an NPC's ability id any more than a goblin can Fireball, and the same `abilityFail` path that reports "Not ready yet." silently no-ops for NPCs (they have no session to notify). NPC kinds are world data ([npcs.ts](packages/shared/src/npcs.ts), `WorldDef.npcs`, edited live in the editor's NPC Library): each def carries model, max HP, friendly/hostile, and its ability kit (goblins open with `frenzy` then `gnash`; shamans cast a ranged `spark` and self-`mend` below half health). Worlds saved before NPC defs existed get theirs derived from their spawners at load, preserving whatever models they were using. The AI in [npcAi.ts](packages/server/src/game/systems/npcAi.ts) just *prefers* an ability (biggest ready hit in range) and lets `combatSystem` re-validate, so AI bugs can't bypass the rules.

Each `AbilityDef` also carries an `fx` spec (impact / projectile / heal + color), consumed by the client's particle system ([effects.ts](packages/client/src/render/effects.ts)) straight off the `combatEvent` stream — NPC casts get visuals for free because both sides emit the same events.

**Casting & interrupts.** Abilities with `castMs` don't resolve in `applyAttack` — validation parks them in `Combat.casting` and `tickCasts` lands the effect when the timer elapses, re-checking target liveness and range at completion (walking out of range makes the cast *fizzle* — that's the dodge). The cooldown is charged at cast **start**, so breaking a cast costs the caster the full cooldown; that's what makes the player's `kick` (an `interrupts: true` ability) worth pressing. Cast lifecycle goes out as `castEvent` messages (`start` → `done`/`interrupted`, with `by` set when a player broke it), which drive nameplate cast bars, a looping cast animation, and channel particles client-side — the whole "see the cast, kick it" loop. Casting NPCs stand rooted (npcAi holds velocity while `combat.casting` is set); players have no cast-time abilities yet, so movement-cancels-casting hasn't needed to exist.

**Bosses.** An `NpcDef` may carry `boss: { phase2AtFrac, phase2Abilities }` (and a model `scale`) — below the HP threshold the AI latches phase 2 once, pushes the extra abilities into the live kit, and yells via local chat. `summon`-type abilities (e.g. `summonPack`) spawn minions on cast completion via `spawnMinion`: spawner-less NPCs (`spawnerId: ""`) that never respawn, tracked in `ctx.minionsByOwner`, and despawned when their owner dies or resets. Note the two `isAlive` guards in `deathSystem`/`npcAiSystem`: `World.query()` returns a snapshot array, and a dying/resetting boss despawns pack members that may still be ahead in that same array. The `boss` flag replicates on `NpcTag`, which is all the client needs to show the top-center boss HP frame. Killing a player also clears every `NpcAi.target` pointing at them (in `deathSystem`), which feeds the same disengage path — hostiles head home instead of camping a corpse run back from spawn.

## Audio ([packages/client/src/audio/audio.ts](packages/client/src/audio/audio.ts))

There are no sound files in this repo — every effect is synthesized on the fly from `OscillatorNode`s and a shared filtered-noise buffer, the same "generate, don't ship assets" approach the placeholder GLBs use. `AudioEngine` exposes one method per moment (ability press, confirmed hit, cast-loop start/stop, footstep, jump/land, death, quest chime) and a single `gainAt(x, z)` distance falloff shared by all of them, computed against a listener position the frame loop updates from the local player's render pose every frame. It plugs into exactly the events other systems already consume: `useAbility()` calls it for the optimistic press, `combatEvent`/`castEvent` handlers call it the same way `effects.ts` does for the confirmed hit/cast/interrupt, and `EntityViews` gained generic `onFootstep`/`onJump`/`onLand` callbacks (driven by the same per-entity airborne/locomotion test that already picks the falling animation) so movement audio isn't player-special-cased. Playback is silent until `unlock()` runs inside a real user gesture (autoplay policy), wired to the first `pointerdown`/`keydown` on the page.

## Quests ([packages/server/src/game/quests.ts](packages/server/src/game/quests.ts), [packages/shared/src/quests.ts](packages/shared/src/quests.ts))

Quest *content* (objectives, rewards, prereqs) is world data — it lives in `WorldDef.quests`, is edited live in the editor's Quest Builder, and is pushed to clients via `questDefs`. Quest *progress* is per-player session state, validated entirely server-side: every accept/turn-in re-checks range, prerequisite completion, and objective completion before mutating anything (`handleAccept`/`handleTurnIn` in `quests.ts`), and `sanitizeQuestDefs`/`sanitizeQuestState` (in shared, so both server and any future tooling can reuse them) treat both the editor's input and disk saves as untrusted — malformed objectives, dangling prereqs, and out-of-range counters all get dropped or clamped rather than trusted.

Three objective types (`kill`, `talk`, `reach`) share one shape: `progress[i]` is a counter, `objectiveTarget()` says what it needs to reach, `isObjectiveDone()` compares them. `kill` progress comes from `deathSystem` → `onNpcKilled`; `talk` from `handleInteract`; `reach` from the throttled poll in `questSystem`. XP/levels are a pure derivation (`levelForXp`) from lifetime XP — there's no separate "level" field stored anywhere, which rules out an entire class of bug where level and xp could disagree.

## Improvements

Roughly ordered by how much they'd actually matter:

1. **No player authentication.** Anyone who can reach the server — which, as of today's LAN firewall change, now includes any device on your local network — can `join` as any player name that isn't currently connected, and the server will load that name's saved position/HP/XP/quest progress with no password check at all. For a solo/friends LAN game this is low-stakes, but it's worth a lightweight per-name token (or at minimum warning players not to use this over an untrusted network) before opening it up further. Related: the editor's `EDITOR_TOKEN` defaults to the literal string `"dev"` if the env var isn't set — anyone who can reach port 8080 can authenticate as the editor and rewrite `world.json` unless you've set a real token.

2. **No automated tests outside `packages/shared`.** `npm test` only runs the shared package's vitest suite (ECS, collision, quests). The server's systems — `combatSystem`, `npcAiSystem`, `movementSystem`, `respawnSystem` — and the entire network layer have zero unit coverage; correctness is currently checked only by the `scripts/smoke-test-*.mjs` scripts, which require a live server and a human (or CI job) to run them. `combatSystem`'s validation logic in particular (range/cooldown/dead-target checks) is pure enough to unit-test cheaply without spinning up a server. There's also no CI workflow (`.github/workflows`) running any of this on push — right now regressions are only caught if someone remembers to run the smoke tests by hand.

3. **No lint/format tooling.** There's no ESLint or Prettier config anywhere in the repo — consistency currently relies entirely on the existing code being a good example to copy. Cheap to add and would catch things like unused imports automatically rather than relying on `tsc --noEmit` (which only catches type errors, not style/dead-code issues).

4. **`World.query()` and `sessionByEntity()` are linear scans** — `query()` walks the smallest matching component store and checks membership in the others; `sessionByEntity()` (`state.ts`) walks every session to find the one owning an entity id, and is called from the hot combat/quest paths. Both are genuinely fine at this game's scale (a handful of players, at most a few hundred NPCs) and not worth touching now — but if NPC counts or player counts grow by an order of magnitude, `sessionByEntity` should become a `Map<Entity, Session>` on `GameCtx`, and `World` would benefit from archetype- or bitset-based storage instead of one `Map` per component type. Flagging this so it's a deliberate future decision, not a surprise profiling session.

None of these are urgent — the codebase is unusually disciplined for a hobby project (the shared-math-must-match-exactly comments throughout `prediction.ts`/`collision.ts`/`inputSystem` are a good sign someone already got bitten by prediction drift once and left a trail for the next person). The list above is "worth knowing about," not "broken."
