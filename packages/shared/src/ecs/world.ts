import type { ComponentType } from "./component";

export type Entity = number;
export type System<Ctx> = (world: World, dt: number, ctx: Ctx) => void;

/**
 * Minimal ECS. Entities are numeric ids, components live in one Map per
 * component type. Writes go through add()/markDirty() so the network layer
 * can send deltas of only what changed since the last snapshot.
 */
export class World {
  private nextId = 1;
  private aliveSet = new Set<Entity>();
  private stores = new Map<number, Map<Entity, unknown>>();
  private dirty = new Map<Entity, Set<ComponentType<unknown>>>();

  create(): Entity {
    const e = this.nextId++;
    this.aliveSet.add(e);
    return e;
  }

  destroy(e: Entity): void {
    this.aliveSet.delete(e);
    for (const store of this.stores.values()) store.delete(e);
    this.dirty.delete(e);
  }

  isAlive(e: Entity): boolean {
    return this.aliveSet.has(e);
  }

  add<T>(e: Entity, type: ComponentType<T>, data: T): T {
    let store = this.stores.get(type.id);
    if (!store) {
      store = new Map();
      this.stores.set(type.id, store);
    }
    store.set(e, data);
    this.markDirty(e, type);
    return data;
  }

  get<T>(e: Entity, type: ComponentType<T>): T | undefined {
    return this.stores.get(type.id)?.get(e) as T | undefined;
  }

  /** Like get() but throws — for components the caller knows must exist. */
  require<T>(e: Entity, type: ComponentType<T>): T {
    const data = this.get(e, type);
    if (data === undefined) throw new Error(`entity ${e} missing component ${type.name}`);
    return data;
  }

  has(e: Entity, type: ComponentType<unknown>): boolean {
    return this.stores.get(type.id)?.has(e) ?? false;
  }

  remove(e: Entity, type: ComponentType<unknown>): void {
    this.stores.get(type.id)?.delete(e);
    this.dirty.get(e)?.delete(type);
  }

  /** Mark a component as changed so the next snapshot includes it in a delta. */
  markDirty(e: Entity, type: ComponentType<unknown>): void {
    let set = this.dirty.get(e);
    if (!set) {
      set = new Set();
      this.dirty.set(e, set);
    }
    set.add(type);
  }

  /** Returns accumulated dirty flags and resets them. */
  consumeDirty(): Map<Entity, Set<ComponentType<unknown>>> {
    const d = this.dirty;
    this.dirty = new Map();
    return d;
  }

  /** Entities that currently have every listed component. */
  query(...types: ComponentType<unknown>[]): Entity[] {
    if (types.length === 0) return [...this.aliveSet];
    let smallest: Map<Entity, unknown> | undefined;
    for (const t of types) {
      const store = this.stores.get(t.id);
      if (!store || store.size === 0) return [];
      if (!smallest || store.size < smallest.size) smallest = store;
    }
    const result: Entity[] = [];
    outer: for (const e of smallest!.keys()) {
      for (const t of types) {
        if (!this.stores.get(t.id)!.has(e)) continue outer;
      }
      result.push(e);
    }
    return result;
  }

  entities(): Iterable<Entity> {
    return this.aliveSet;
  }
}
