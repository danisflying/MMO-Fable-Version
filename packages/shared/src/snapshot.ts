import type { ComponentType } from "./ecs/component";
import type { Entity, World } from "./ecs/world";
import { NETWORKED } from "./components";
import type { EntitySnapshot } from "./protocol";

/** Serialize an entity's networked components (all of them, for spawn messages). */
export function snapshotEntity(world: World, e: Entity): EntitySnapshot {
  const c: Record<string, unknown> = {};
  for (const type of NETWORKED) {
    const data = world.get(e, type);
    if (data !== undefined) c[type.name] = data;
  }
  return { id: e, c };
}

/** Serialize only the given (dirty) components, skipping non-networked ones. */
export function snapshotComponents(
  world: World,
  e: Entity,
  types: Iterable<ComponentType<unknown>>,
): EntitySnapshot | null {
  const c: Record<string, unknown> = {};
  let any = false;
  for (const type of types) {
    if (!NETWORKED.includes(type)) continue;
    const data = world.get(e, type);
    if (data !== undefined) {
      c[type.name] = data;
      any = true;
    }
  }
  return any ? { id: e, c } : null;
}
