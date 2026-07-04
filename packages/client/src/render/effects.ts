import * as THREE from "three";
import { ABILITIES, type CombatEventData } from "@mmo/shared";

/**
 * Ability particle effects, driven entirely by the server's combatEvent
 * stream — NPC casts get the same visuals as players because both emit the
 * same events. Three effect kinds (AbilityFx.kind):
 *  - impact:     radial spark burst at the victim
 *  - projectile: a glowing bolt flies attacker → victim, trailing sparks,
 *                and bursts on arrival
 *  - heal:       soft sparks rising off the target
 * Everything renders through one additive-blended Points pool (dead slots
 * are colored black, which additive blending makes invisible).
 */

const MAX_PARTICLES = 800;
const SPARK_GRAVITY = 7;
const BOLT_SPEED = 26;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  age: number;
  ttl: number;
  r: number; g: number; b: number;
  gravity: number;
  /** Per-second velocity retention (1 = none). */
  drag: number;
}

interface Bolt {
  pos: THREE.Vector3;
  target: THREE.Vector3;
  color: THREE.Color;
  power: number;
  mesh: THREE.Mesh;
}

export class Effects {
  private readonly particles: Particle[] = [];
  private readonly bolts: Bolt[] = [];
  private readonly posAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private readonly boltGeo = new THREE.SphereGeometry(0.16, 8, 8);
  /** Entities channeling a cast right now: a slow swirl at their hands. */
  private readonly channels = new Map<number, { color: THREE.Color; until: number }>();
  /** Feet position of a live entity — wired to EntityViews by main. */
  positionOf: (id: number) => THREE.Vector3 | null = () => null;

  constructor(private scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(MAX_PARTICLES * 3), 3);
    geo.setAttribute("position", this.posAttr);
    geo.setAttribute("color", this.colorAttr);
    const points = new THREE.Points(
      geo,
      new THREE.PointsMaterial({
        size: 0.22,
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    points.frustumCulled = false; // positions update per-frame; skip stale-bounds culling
    scene.add(points);
  }

  /** Route one combat event to its visual. Positions are feet; we aim at the chest. */
  onCombatEvent(
    ev: CombatEventData,
    attackerPos: THREE.Vector3 | null,
    targetPos: THREE.Vector3 | null,
  ): void {
    if (!targetPos) return;
    const chest = targetPos.clone();
    chest.y += 0.9;
    const fx = ev.ability ? ABILITIES[ev.ability]?.fx : undefined;

    if (ev.damage < 0 || fx?.kind === "heal") {
      this.healSparks(chest, new THREE.Color(fx?.color ?? 0x4ade80));
    } else if (fx?.kind === "projectile" && attackerPos && attackerPos.distanceTo(targetPos) > 1) {
      const from = attackerPos.clone();
      from.y += 1.1;
      this.launchBolt(from, chest, new THREE.Color(fx.color), fx.power ?? 1);
    } else {
      this.impact(chest, new THREE.Color(fx?.color ?? 0xffffff), fx?.power ?? 1);
    }
    if (ev.died) this.impact(chest, new THREE.Color(0x9aa3b2), 2.2);
  }

  /** Casting glow at an entity, ended by stopChannel (or a safety timeout). */
  startChannel(id: number, color: number, durationMs: number): void {
    this.channels.set(id, {
      color: new THREE.Color(color),
      until: performance.now() + durationMs + 500,
    });
  }

  stopChannel(id: number): void {
    this.channels.delete(id);
  }

  /** Advance and re-upload; call once per frame. */
  update(dtMs: number): void {
    const dt = Math.min(dtMs, 100) / 1000;

    const now = performance.now();
    for (const [id, ch] of this.channels) {
      const pos = now > ch.until ? null : this.positionOf(id);
      if (!pos) {
        this.channels.delete(id);
        continue;
      }
      // ~25 sparks/sec drifting up around the caster's hands.
      if (Math.random() < dt * 25) {
        this.spawn(pos.x, pos.y + 1.0, pos.z, 0.5, ch.color, {
          count: 1, speed: 0.3, ttl: 0.8, gravity: -1.2, drag: 0.5,
        });
      }
    }

    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const toTarget = b.target.clone().sub(b.pos);
      const step = BOLT_SPEED * dt;
      if (toTarget.length() <= step) {
        this.impact(b.target, b.color, 1.4 * b.power);
        b.mesh.removeFromParent();
        (b.mesh.material as THREE.Material).dispose();
        this.bolts.splice(i, 1);
        continue;
      }
      b.pos.add(toTarget.normalize().multiplyScalar(step));
      b.mesh.position.copy(b.pos);
      this.spawn(b.pos.x, b.pos.y, b.pos.z, 0.3, b.color, {
        count: 2, speed: 0.5, ttl: 0.35, gravity: 0, drag: 0.2,
      });
    }

    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.ttl) {
        this.particles.splice(i, 1);
        continue;
      }
      const keep = Math.pow(p.drag, dt);
      p.vx *= keep;
      p.vz *= keep;
      p.vy = p.vy * keep - p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
    }

    const pos = this.posAttr.array as Float32Array;
    const col = this.colorAttr.array as Float32Array;
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const p = this.particles[i];
      if (p) {
        const fade = 1 - p.age / p.ttl;
        pos[i * 3] = p.x;
        pos[i * 3 + 1] = p.y;
        pos[i * 3 + 2] = p.z;
        col[i * 3] = p.r * fade;
        col[i * 3 + 1] = p.g * fade;
        col[i * 3 + 2] = p.b * fade;
      } else {
        // Black is invisible under additive blending.
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = 0;
      }
    }
    this.posAttr.needsUpdate = true;
    this.colorAttr.needsUpdate = true;
  }

  private impact(at: THREE.Vector3, color: THREE.Color, power: number): void {
    this.spawn(at.x, at.y, at.z, 0.15, color, {
      count: Math.round(12 * power),
      speed: 3.2 * Math.sqrt(power),
      ttl: 0.55,
      gravity: SPARK_GRAVITY,
      drag: 0.25,
      upBias: 1.2,
    });
  }

  private healSparks(at: THREE.Vector3, color: THREE.Color): void {
    this.spawn(at.x, at.y - 0.6, at.z, 0.45, color, {
      count: 16, speed: 0.4, ttl: 1.0, gravity: -1.6, drag: 0.6,
    });
  }

  private launchBolt(from: THREE.Vector3, to: THREE.Vector3, color: THREE.Color, power: number): void {
    const mesh = new THREE.Mesh(
      this.boltGeo,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
    );
    mesh.position.copy(from);
    this.scene.add(mesh);
    this.bolts.push({ pos: from.clone(), target: to.clone(), color, power, mesh });
  }

  private spawn(
    x: number, y: number, z: number,
    jitter: number,
    color: THREE.Color,
    opts: { count: number; speed: number; ttl: number; gravity: number; drag: number; upBias?: number },
  ): void {
    for (let i = 0; i < opts.count; i++) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const dir = new THREE.Vector3(
        Math.random() * 2 - 1,
        (Math.random() * 2 - 1) + (opts.upBias ?? 0),
        Math.random() * 2 - 1,
      ).normalize();
      const speed = opts.speed * (0.5 + Math.random());
      this.particles.push({
        x: x + (Math.random() * 2 - 1) * jitter,
        y: y + (Math.random() * 2 - 1) * jitter,
        z: z + (Math.random() * 2 - 1) * jitter,
        vx: dir.x * speed,
        vy: dir.y * speed,
        vz: dir.z * speed,
        age: 0,
        ttl: opts.ttl * (0.7 + Math.random() * 0.6),
        r: color.r,
        g: color.g,
        b: color.b,
        gravity: opts.gravity,
        drag: opts.drag,
      });
    }
  }
}
