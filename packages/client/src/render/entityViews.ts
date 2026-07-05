import * as THREE from "three";
import { ABILITIES, INTERP_DELAY_MS } from "@mmo/shared";
import { loadModel } from "./assets";
import type { NetEntity, Replication } from "../net/replication";
import type { RenderPose } from "../net/prediction";

/** Per-model yaw correction if a GLB's "forward" isn't +Z. */
const MODEL_YAW_OFFSET: Record<string, number> = {};

/** Horizontal speed (units/sec) thresholds for locomotion clips. */
const RUN_SPEED = 4;
const WALK_SPEED = 0.3;
/** This far above the ground the falling clip plays instead of ground locomotion. */
const AIRBORNE_Y = 0.12;
/** Footstep cadence, ms between steps (faster while running). */
const WALK_STEP_MS = 430;
const RUN_STEP_MS = 260;

type Locomotion = "idle" | "walk" | "run" | "fall";

interface View {
  obj: THREE.Group;
  modelName: string | null;
  modelObj: THREE.Object3D | null;
  modelScale: number;
  mixer: THREE.AnimationMixer | null;
  actions: Partial<Record<Locomotion | "attack", THREE.AnimationAction>>;
  current: string | null;
  attacking: boolean;
  lastX: number | null;
  lastZ: number | null;
  label: THREE.Sprite | null;
  labelCanvas: HTMLCanvasElement | null;
  labelTex: THREE.CanvasTexture | null;
  pulseUntil: number;
  /** Cast bar state (server castEvent start → done/interrupted). */
  cast: { ability: string; start: number; end: number } | null;
  /** Post-cast redraw window; shows "Interrupted!" if the cast was broken. */
  castFlashUntil: number;
  castInterrupted: boolean;
  /** Footstep cadence accumulator (ms) while walking/running on the ground. */
  stepAcc: number;
  airborne: boolean;
}

/** Syncs replicated entity state into Three.js objects (model + animation + nameplate). */
export class EntityViews {
  readonly root = new THREE.Group();
  private views = new Map<number, View>();
  private lastNow: number | null = null;
  private targetRing: THREE.Mesh;
  /** NpcTag.kind -> "!" (quest available) or "?" (turn-in ready). */
  private questMarkers = new Map<string, string>();
  /** Terrain height sampler; entities above it play the falling clip. */
  groundHeight: (x: number, z: number) => number = () => 0;
  /** Movement audio hooks — fired for every entity, self included. */
  onFootstep: ((id: number, x: number, z: number, running: boolean) => void) | null = null;
  onJump: ((id: number, x: number, z: number) => void) | null = null;
  onLand: ((id: number, x: number, z: number) => void) | null = null;

  constructor(scene: THREE.Scene) {
    scene.add(this.root);
    this.targetRing = new THREE.Mesh(
      new THREE.RingGeometry(0.7, 0.88, 40),
      new THREE.MeshBasicMaterial({
        color: 0xffcc33,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    );
    this.targetRing.rotation.x = -Math.PI / 2;
    this.targetRing.position.y = 0.06;
  }

  /** Update quest markers and redraw nameplates of affected NPC kinds. */
  setQuestMarkers(markers: Map<string, string>, entities: Iterable<NetEntity>): void {
    this.questMarkers = markers;
    for (const e of entities) {
      if (!e.npcTag) continue;
      const view = this.views.get(e.id);
      if (view) this.ensureLabel(e, view);
    }
  }

  /** Rendered (interpolated/predicted) feet position of an entity, if streamed in. */
  positionOf(id: number): THREE.Vector3 | null {
    const view = this.views.get(id);
    return view ? view.obj.position.clone() : null;
  }

  /** Show the selection ring under an entity (null hides it). */
  setTarget(id: number | null): void {
    this.targetRing.removeFromParent();
    if (id !== null) {
      const view = this.views.get(id);
      view?.obj.add(this.targetRing);
    }
  }

  add(e: NetEntity): void {
    const obj = new THREE.Group();
    obj.userData.entityId = e.id;
    if (e.transform) {
      obj.position.set(e.transform.pos.x, 0, e.transform.pos.z);
      obj.rotation.y = e.transform.rotY;
    }
    const view: View = {
      obj,
      modelName: null,
      modelObj: null,
      modelScale: 1,
      mixer: null,
      actions: {},
      current: null,
      attacking: false,
      lastX: null,
      lastZ: null,
      label: null,
      labelCanvas: null,
      labelTex: null,
      pulseUntil: 0,
      cast: null,
      castFlashUntil: 0,
      castInterrupted: false,
      stepAcc: 0,
      airborne: false,
    };
    this.views.set(e.id, view);
    this.root.add(obj);
    void this.ensureModel(e, view);
    if (e.playerTag || e.npcTag) this.ensureLabel(e, view);
  }

  remove(id: number): void {
    const view = this.views.get(id);
    if (!view) return;
    if (this.targetRing.parent === view.obj) this.targetRing.removeFromParent();
    view.mixer?.stopAllAction();
    view.labelTex?.dispose();
    this.root.remove(view.obj);
    this.views.delete(id);
  }

  changed(e: NetEntity, names: string[]): void {
    const view = this.views.get(e.id);
    if (!view) return;
    if (names.includes("health")) this.ensureLabel(e, view);
    if (names.includes("modelRef")) void this.ensureModel(e, view);
  }

  /** Brief scale pulse as hit feedback. */
  pulse(id: number): void {
    const view = this.views.get(id);
    if (view) view.pulseUntil = performance.now() + 160;
  }

  /** Play the attack clip once (falls back to nothing for unanimated models). */
  playAttack(id: number): void {
    const view = this.views.get(id);
    if (!view || view.attacking) return;
    const attack = view.actions.attack;
    if (!attack) return;
    view.attacking = true;
    this.fadeTo(view, "attack");
  }

  /** Cast began: show the nameplate cast bar and loop the cast animation. */
  startCast(id: number, ability: string, durationMs: number): void {
    const view = this.views.get(id);
    if (!view) return;
    const now = performance.now();
    view.cast = { ability, start: now, end: now + durationMs };
    view.castInterrupted = false;
    const attack = view.actions.attack;
    if (attack) {
      attack.setLoop(THREE.LoopRepeat, Infinity);
      view.attacking = true; // hold locomotion off the mixer while casting
      this.fadeTo(view, "attack");
    }
  }

  /** Cast ended (landed or broken); interrupted casts flash red briefly. */
  endCast(id: number, interrupted: boolean): void {
    const view = this.views.get(id);
    if (!view || !view.cast) return;
    view.cast = null;
    view.castInterrupted = interrupted;
    view.castFlashUntil = performance.now() + (interrupted ? 700 : 60);
    const attack = view.actions.attack;
    if (attack) {
      attack.setLoop(THREE.LoopOnce, 1);
      view.attacking = false;
      if (view.current === "attack") {
        attack.fadeOut(0.2);
        view.current = null; // next update picks the locomotion clip
      }
    }
  }

  /** Ability id the entity is casting right now, if any (for the HUD). */
  castOf(id: number): { ability: string; start: number; end: number } | null {
    return this.views.get(id)?.cast ?? null;
  }

  update(repl: Replication, self: RenderPose, now: number): void {
    const dt = this.lastNow === null ? 0 : (now - this.lastNow) / 1000;
    this.lastNow = now;
    const renderTime = now - INTERP_DELAY_MS;

    for (const [id, view] of this.views) {
      if (id === repl.selfId) {
        view.obj.position.set(self.x, self.y, self.z);
        view.obj.rotation.y = self.rotY;
      } else {
        const s = repl.sample(id, renderTime);
        if (s) {
          view.obj.position.set(s.x, s.y, s.z);
          view.obj.rotation.y = s.rotY;
        }
      }

      // Airborne test drives both the falling clip and jump/land audio, for
      // every entity (only players jump today, but this stays entity-agnostic).
      const ground = this.groundHeight(view.obj.position.x, view.obj.position.z);
      const airborne = view.obj.position.y > ground + AIRBORNE_Y;
      if (airborne && !view.airborne) this.onJump?.(id, view.obj.position.x, view.obj.position.z);
      else if (!airborne && view.airborne) this.onLand?.(id, view.obj.position.x, view.obj.position.z);
      view.airborne = airborne;

      // Drive locomotion from how fast the rendered position actually moves.
      let desired: Locomotion = "idle";
      if (view.mixer) {
        if (dt > 0 && view.lastX !== null && view.lastZ !== null && !view.attacking) {
          const speed =
            Math.hypot(view.obj.position.x - view.lastX, view.obj.position.z - view.lastZ) / dt;
          desired = speed > RUN_SPEED ? "run" : speed > WALK_SPEED ? "walk" : "idle";
          if (airborne && view.actions.fall) desired = "fall";
          this.fadeTo(view, desired);
        }
        view.mixer.update(dt);
      }
      view.lastX = view.obj.position.x;
      view.lastZ = view.obj.position.z;

      // Footsteps: cadence while walking/running on the ground.
      if (!airborne && (desired === "walk" || desired === "run") && dt > 0) {
        view.stepAcc += dt * 1000;
        const interval = desired === "run" ? RUN_STEP_MS : WALK_STEP_MS;
        if (view.stepAcc >= interval) {
          view.stepAcc -= interval;
          this.onFootstep?.(id, view.obj.position.x, view.obj.position.z, desired === "run");
        }
      } else {
        view.stepAcc = 0;
      }

      if (view.modelObj) {
        const pulse = view.pulseUntil > now ? 1.15 : 1;
        view.modelObj.scale.setScalar(view.modelScale * pulse);
      }

      // Cast bars animate every frame while a cast (or its end flash) is live.
      if (view.cast || view.castFlashUntil > now) {
        const e = repl.entities.get(id);
        if (e && (e.playerTag || e.npcTag)) this.ensureLabel(e, view);
      }
    }
  }

  /**
   * Entity under the cursor. Precise mesh raycast first (ignoring nameplate
   * sprites and the selection ring), then a forgiving pass that accepts a
   * near-miss on any entity's body line — clicking a running, animating
   * character shouldn't demand pixel accuracy.
   */
  entityAt(raycaster: THREE.Raycaster, targetable?: (id: number) => boolean): number | null {
    const hits = raycaster.intersectObjects(this.root.children, true);
    for (const hit of hits) {
      if ((hit.object as Partial<THREE.Sprite>).isSprite || hit.object === this.targetRing) continue;
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.entityId === undefined) obj = obj.parent;
      if (!obj) continue;
      const id = obj.userData.entityId as number;
      if (!targetable || targetable(id)) return id;
    }

    const feet = new THREE.Vector3();
    const head = new THREE.Vector3();
    let best: number | null = null;
    let bestDistSq = 0.55 * 0.55; // max miss distance, world units
    for (const [id, view] of this.views) {
      if (targetable && !targetable(id)) continue;
      feet.copy(view.obj.position);
      feet.y += 0.2;
      head.copy(view.obj.position);
      head.y += 1.7 * view.modelScale; // scaled models (bosses) are taller
      const d = raycaster.ray.distanceSqToSegment(feet, head);
      if (d < bestDistSq) {
        bestDistSq = d;
        best = id;
      }
    }
    return best;
  }

  private fadeTo(view: View, name: string): void {
    if (view.current === name) return;
    const next = view.actions[name as Locomotion | "attack"];
    if (!next) return;
    const prev = view.current ? view.actions[view.current as Locomotion | "attack"] : undefined;
    next.reset().fadeIn(0.2).play();
    prev?.fadeOut(0.2);
    view.current = name;
  }

  private setupAnimations(view: View, object: THREE.Object3D, clips: THREE.AnimationClip[]): void {
    view.mixer?.stopAllAction();
    view.mixer = null;
    view.actions = {};
    view.current = null;
    view.attacking = false;
    if (clips.length === 0) return;

    const mixer = new THREE.AnimationMixer(object);
    view.mixer = mixer;
    const find = (re: RegExp, exact?: string) =>
      clips.find((c) => c.name === exact) ?? clips.find((c) => re.test(c.name));
    const found = {
      idle: find(/idle/i, "Idle"),
      walk: find(/walk/i),
      run: find(/run/i),
      fall: find(/fall|jump/i, "Falling Idle"),
      attack: find(/attack|punch|slash|spell/i),
    };
    for (const [key, clip] of Object.entries(found)) {
      if (clip) view.actions[key as Locomotion | "attack"] = mixer.clipAction(clip);
    }
    const attack = view.actions.attack;
    if (attack) {
      attack.setLoop(THREE.LoopOnce, 1);
      attack.clampWhenFinished = true;
      mixer.addEventListener("finished", (ev) => {
        if ((ev as unknown as { action: THREE.AnimationAction }).action === attack) {
          view.attacking = false;
          attack.fadeOut(0.2);
          view.current = null; // next update picks the locomotion clip
        }
      });
    }
    this.fadeTo(view, "idle");
  }

  private async ensureModel(e: NetEntity, view: View): Promise<void> {
    const name = e.modelRef?.model;
    view.modelScale = e.modelRef?.scale ?? 1;
    if (!name) return;
    if (view.modelName === name) {
      view.modelObj?.scale.setScalar(view.modelScale);
      return;
    }
    view.modelName = name;
    const { object, animations } = await loadModel(name);
    // Entity may have despawned (or swapped models again) while loading.
    if (!this.views.has(e.id) || view.modelName !== name) return;
    if (view.modelObj) view.obj.remove(view.modelObj);
    view.modelObj = object;
    object.scale.setScalar(view.modelScale);
    object.rotation.y = MODEL_YAW_OFFSET[name] ?? 0;
    view.obj.add(object);
    this.setupAnimations(view, object, animations);
    // Keep the nameplate above the model's head.
    if (view.label) {
      const height = new THREE.Box3().setFromObject(object).max.y;
      if (Number.isFinite(height) && height > 0.5) view.label.position.y = height + 0.6;
    }
  }

  private ensureLabel(e: NetEntity, view: View): void {
    if (!view.label) {
      const canvas = document.createElement("canvas");
      canvas.width = 256;
      canvas.height = 84;
      const tex = new THREE.CanvasTexture(canvas);
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }),
      );
      sprite.scale.set(2.6, 0.853, 1); // same px-per-unit as the old 256×64 plate
      sprite.position.y = 2.4;
      view.label = sprite;
      view.labelCanvas = canvas;
      view.labelTex = tex;
      view.obj.add(sprite);
    }
    const ctx = view.labelCanvas!.getContext("2d")!;
    ctx.clearRect(0, 0, 256, 84);
    const name = e.playerTag?.name ?? e.npcTag?.kind ?? "";
    ctx.font = "bold 26px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = e.playerTag ? "#ffffff" : "#fca5a5";
    ctx.shadowColor = "#000";
    ctx.shadowBlur = 4;
    ctx.fillText(name, 128, 30);
    const marker = !e.playerTag && e.npcTag ? this.questMarkers.get(e.npcTag.kind) : undefined;
    if (marker) {
      ctx.fillStyle = "#fbbf24";
      ctx.fillText(marker, 128 - ctx.measureText(name).width / 2 - 14, 30);
    }
    ctx.shadowBlur = 0;
    if (e.health) {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillRect(48, 42, 160, 12);
      ctx.fillStyle = "#22c55e";
      ctx.fillRect(50, 44, 156 * Math.max(0, e.health.hp / e.health.maxHp), 8);
    }
    // Cast bar under the health bar — the "kick now" signal.
    const now = performance.now();
    if (view.cast) {
      const frac = Math.min(1, (now - view.cast.start) / (view.cast.end - view.cast.start));
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(48, 58, 160, 20);
      ctx.fillStyle = "#fbbf24";
      ctx.fillRect(50, 60, 156 * frac, 16);
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillStyle = "#fff";
      ctx.shadowBlur = 3;
      ctx.fillText(ABILITIES[view.cast.ability]?.name ?? view.cast.ability, 128, 73);
      ctx.shadowBlur = 0;
    } else if (view.castInterrupted && view.castFlashUntil > now) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(48, 58, 160, 20);
      ctx.fillStyle = "#dc2626";
      ctx.fillRect(50, 60, 156, 16);
      ctx.font = "bold 14px system-ui, sans-serif";
      ctx.fillStyle = "#fff";
      ctx.fillText("Interrupted!", 128, 73);
    }
    view.labelTex!.needsUpdate = true;
  }
}
