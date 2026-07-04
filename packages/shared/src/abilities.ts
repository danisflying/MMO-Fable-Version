/**
 * Ability definitions, shared three ways: the server validates every use
 * against them, the client renders the action bar/cooldowns from them, and
 * the client's particle system reads each ability's `fx` to draw it.
 *
 * Players and NPCs use the same system — an entity may use exactly the
 * abilities in its Combat component's kit (combat.abilities), so "NPC
 * abilities" are just entries players don't have on their bar.
 */

export type AbilityFxKind = "impact" | "projectile" | "heal";

export interface AbilityFx {
  kind: AbilityFxKind;
  /** Particle color (sRGB hex). */
  color: number;
  /** Burst size multiplier; 1 = a basic hit. */
  power?: number;
}

export interface AbilityDef {
  id: string;
  name: string;
  icon: string;
  /** Max distance to target; ignored for targetSelf abilities. */
  range: number;
  /** Hit points removed from the target. */
  damage: number;
  /** Hit points restored (self). */
  heal?: number;
  cooldownMs: number;
  /** Always targets the caster (heals etc.). */
  targetSelf?: boolean;
  /**
   * Cast time; the effect lands when it elapses (instant if absent). Casters
   * stand still and show a cast bar; a hit from an `interrupts` ability
   * cancels the cast, and a target that leaves range makes it fizzle.
   */
  castMs?: number;
  /** Landing this ability cancels the target's cast in progress. */
  interrupts?: boolean;
  /** On cast completion, spawn hostile minions of this NPC kind at the caster. */
  summon?: { kind: string; count: number };
  fx: AbilityFx;
}

export const ABILITIES: Record<string, AbilityDef> = {
  // ── Player kit (ABILITY_BAR) ──────────────────────────────────
  strike: {
    id: "strike", name: "Strike", icon: "⚔️",
    range: 2.5, damage: 10, cooldownMs: 1500,
    fx: { kind: "impact", color: 0xf2f3f5 },
  },
  heavy: {
    id: "heavy", name: "Heavy Blow", icon: "🔨",
    range: 2.5, damage: 24, cooldownMs: 8000,
    fx: { kind: "impact", color: 0xffb347, power: 1.8 },
  },
  fireball: {
    id: "fireball", name: "Fireball", icon: "🔥",
    range: 20, damage: 16, cooldownMs: 4000,
    fx: { kind: "projectile", color: 0xff7a29 },
  },
  heal: {
    id: "heal", name: "Heal", icon: "💚",
    range: 0, damage: 0, heal: 25, cooldownMs: 10000, targetSelf: true,
    fx: { kind: "heal", color: 0x4ade80 },
  },
  kick: {
    id: "kick", name: "Kick", icon: "🦶",
    range: 2.5, damage: 3, cooldownMs: 8000, interrupts: true,
    fx: { kind: "impact", color: 0xfacc15 },
  },

  // ── NPC kits (see NPC_STATS in the server's spawn.ts) ─────────
  gnash: {
    id: "gnash", name: "Gnash", icon: "🦷",
    range: 1.8, damage: 6, cooldownMs: 1200,
    fx: { kind: "impact", color: 0xd94f4f, power: 0.7 },
  },
  frenzy: {
    id: "frenzy", name: "Frenzy", icon: "🩸",
    range: 1.8, damage: 14, cooldownMs: 9000,
    fx: { kind: "impact", color: 0xe23e3e, power: 1.6 },
  },
  spark: {
    id: "spark", name: "Spark", icon: "⚡",
    range: 12, damage: 10, cooldownMs: 2500, castMs: 1200,
    fx: { kind: "projectile", color: 0x7dd3fc },
  },
  mend: {
    id: "mend", name: "Mend", icon: "✨",
    range: 0, damage: 0, heal: 20, cooldownMs: 12000, targetSelf: true, castMs: 2000,
    fx: { kind: "heal", color: 0x86efac },
  },

  // ── Boss abilities (see the hogger def in npcs.ts) ────────────
  maul: {
    id: "maul", name: "Maul", icon: "🐾",
    range: 2.2, damage: 12, cooldownMs: 2000,
    fx: { kind: "impact", color: 0xef4444, power: 1.2 },
  },
  slam: {
    id: "slam", name: "Vicious Slam", icon: "💢",
    range: 10, damage: 30, cooldownMs: 9000, castMs: 2500,
    fx: { kind: "impact", color: 0xf97316, power: 2.5 },
  },
  summonPack: {
    id: "summonPack", name: "Call the Pack", icon: "🐺",
    range: 0, damage: 0, cooldownMs: 20000, targetSelf: true, castMs: 3000,
    summon: { kind: "gnoll", count: 3 },
    fx: { kind: "impact", color: 0xa16207, power: 2 },
  },
};

/** Slot order on the action bar; index = hotkey (1-based). */
export const ABILITY_BAR: string[] = ["strike", "heavy", "fireball", "heal", "kick"];

/**
 * AI approach distance for a kit: the shortest offensive range, so an NPC
 * closes until everything it owns can connect.
 */
export function kitRange(abilities: readonly string[]): number {
  let range = Infinity;
  for (const id of abilities) {
    const def = ABILITIES[id];
    if (def && def.damage > 0) range = Math.min(range, def.range);
  }
  return range === Infinity ? 0 : range;
}
