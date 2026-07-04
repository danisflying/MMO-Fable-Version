import { describe, expect, it } from "vitest";
import { resolveCircleCollisions, type CircleCollider } from "../src/collision";

const tree: CircleCollider = { id: 1, x: 10, z: 0, r: 0.8 };

describe("resolveCircleCollisions", () => {
  it("leaves non-overlapping positions unchanged", () => {
    const out = resolveCircleCollisions(0, 0, 0.5, [tree]);
    expect(out).toEqual({ x: 0, z: 0 });
  });

  it("pushes an overlapping position to the boundary", () => {
    const out = resolveCircleCollisions(9.1, 0, 0.5, [tree]);
    expect(out.x).toBeCloseTo(10 - 1.3, 10);
    expect(out.z).toBeCloseTo(0, 10);
  });

  it("pushes out along the center-to-center normal", () => {
    const out = resolveCircleCollisions(10.5, 0.5, 0.5, [tree]);
    const dist = Math.hypot(out.x - tree.x, out.z - tree.z);
    expect(dist).toBeCloseTo(1.3, 10);
    // Direction preserved (up-right of center).
    expect(out.x).toBeGreaterThan(tree.x);
    expect(out.z).toBeGreaterThan(tree.z);
  });

  it("handles the dead-center case deterministically", () => {
    const out = resolveCircleCollisions(10, 0, 0.5, [tree]);
    expect(out).toEqual({ x: 10 + 1.3, z: 0 });
  });

  it("makes monotonic progress in a too-narrow wedge between two colliders", () => {
    // The gap (0.4) is narrower than the player (1.0): full separation is
    // impossible nearby, so the resolver must push toward the wedge exit
    // without oscillating or exploding.
    const a: CircleCollider = { id: 1, x: 0, z: 0, r: 1 };
    const b: CircleCollider = { id: 2, x: 2.4, z: 0, r: 1 };
    const startDistA = Math.hypot(1.2 - a.x, 0.4 - a.z);
    const startDistB = Math.hypot(1.2 - b.x, 0.4 - b.z);
    const out = resolveCircleCollisions(1.2, 0.4, 0.5, [a, b]);
    expect(Math.hypot(out.x - a.x, out.z - a.z)).toBeGreaterThan(startDistA);
    expect(Math.hypot(out.x - b.x, out.z - b.z)).toBeGreaterThan(startDistB);
    expect(Math.abs(out.x)).toBeLessThan(10);
    expect(Math.abs(out.z)).toBeLessThan(10);
  });

  it("is exactly reproducible (same input, same float output)", () => {
    const colliders = [tree, { id: 2, x: 11, z: 1, r: 0.6 }];
    const a = resolveCircleCollisions(9.7, 0.3, 0.5, colliders);
    const b = resolveCircleCollisions(9.7, 0.3, 0.5, colliders);
    expect(a.x).toBe(b.x);
    expect(a.z).toBe(b.z);
  });
});
