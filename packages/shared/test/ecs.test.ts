import { describe, expect, it } from "vitest";
import { defineComponent } from "../src/ecs/component";
import { World } from "../src/ecs/world";

const Pos = defineComponent<{ x: number }>("test:pos");
const Vel = defineComponent<{ v: number }>("test:vel");
const Tag = defineComponent<{ on: boolean }>("test:tag");

describe("World", () => {
  it("creates and destroys entities", () => {
    const w = new World();
    const e = w.create();
    expect(w.isAlive(e)).toBe(true);
    w.destroy(e);
    expect(w.isAlive(e)).toBe(false);
  });

  it("adds, gets and removes components", () => {
    const w = new World();
    const e = w.create();
    w.add(e, Pos, { x: 5 });
    expect(w.get(e, Pos)?.x).toBe(5);
    expect(w.has(e, Pos)).toBe(true);
    w.remove(e, Pos);
    expect(w.get(e, Pos)).toBeUndefined();
  });

  it("query returns only entities with all components", () => {
    const w = new World();
    const a = w.create();
    const b = w.create();
    const c = w.create();
    w.add(a, Pos, { x: 1 });
    w.add(a, Vel, { v: 1 });
    w.add(b, Pos, { x: 2 });
    w.add(c, Vel, { v: 3 });
    expect(w.query(Pos, Vel)).toEqual([a]);
    expect(new Set(w.query(Pos))).toEqual(new Set([a, b]));
    expect(w.query(Pos, Vel, Tag)).toEqual([]);
  });

  it("destroy removes entity from queries and stores", () => {
    const w = new World();
    const a = w.create();
    w.add(a, Pos, { x: 1 });
    w.destroy(a);
    expect(w.query(Pos)).toEqual([]);
  });

  it("tracks dirty components and clears on consume", () => {
    const w = new World();
    const e = w.create();
    w.add(e, Pos, { x: 1 });
    let dirty = w.consumeDirty();
    expect(dirty.get(e)?.has(Pos)).toBe(true);

    // nothing dirty after consume
    dirty = w.consumeDirty();
    expect(dirty.size).toBe(0);

    w.markDirty(e, Pos);
    w.markDirty(e, Pos); // idempotent
    dirty = w.consumeDirty();
    expect(dirty.get(e)?.size).toBe(1);
  });

  it("destroying an entity drops its dirty flags", () => {
    const w = new World();
    const e = w.create();
    w.add(e, Pos, { x: 1 });
    w.destroy(e);
    expect(w.consumeDirty().has(e)).toBe(false);
  });
});
