/**
 * 2D circle collision on the XZ plane. Used by both server integration and
 * client prediction — the math, candidate ordering (by collider id), and
 * pass count must stay identical on both sides or prediction will diverge
 * when pushing against props.
 */
export interface CircleCollider {
  /** Prop entity id — replicated, so server and client sort identically. */
  id: number;
  x: number;
  z: number;
  r: number;
}

/** Two passes lets corner cases between adjacent props settle. */
const PASSES = 2;

/**
 * Push (x, z) out of every overlapping collider. `colliders` must be sorted
 * by id ascending (callers maintain sorted lists).
 */
export function resolveCircleCollisions(
  x: number,
  z: number,
  radius: number,
  colliders: readonly CircleCollider[],
): { x: number; z: number } {
  for (let pass = 0; pass < PASSES; pass++) {
    for (const c of colliders) {
      const minDist = radius + c.r;
      const dx = x - c.x;
      const dz = z - c.z;
      const distSq = dx * dx + dz * dz;
      if (distSq >= minDist * minDist) continue;
      const dist = Math.sqrt(distSq);
      if (dist < 1e-6) {
        // Dead center: push out along +x deterministically.
        x = c.x + minDist;
      } else {
        const push = minDist / dist;
        x = c.x + dx * push;
        z = c.z + dz * push;
      }
    }
  }
  return { x, z };
}
