import { GRID_CELL_SIZE, distSq, type Entity } from "@mmo/shared";

interface GridEntry {
  e: Entity;
  x: number;
  z: number;
}

/**
 * Spatial hash over the XZ plane. Rebuilt each snapshot tick; queryCircle
 * only inspects cells overlapping the radius, so interest checks stay cheap
 * as entity counts grow.
 */
export class SpatialGrid {
  private cells = new Map<string, GridEntry[]>();

  clear(): void {
    this.cells.clear();
  }

  insert(e: Entity, x: number, z: number): void {
    const key = `${Math.floor(x / GRID_CELL_SIZE)},${Math.floor(z / GRID_CELL_SIZE)}`;
    let cell = this.cells.get(key);
    if (!cell) {
      cell = [];
      this.cells.set(key, cell);
    }
    cell.push({ e, x, z });
  }

  queryCircle(x: number, z: number, radius: number): Entity[] {
    const result: Entity[] = [];
    const rSq = radius * radius;
    const minCx = Math.floor((x - radius) / GRID_CELL_SIZE);
    const maxCx = Math.floor((x + radius) / GRID_CELL_SIZE);
    const minCz = Math.floor((z - radius) / GRID_CELL_SIZE);
    const maxCz = Math.floor((z + radius) / GRID_CELL_SIZE);
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cz = minCz; cz <= maxCz; cz++) {
        const cell = this.cells.get(`${cx},${cz}`);
        if (!cell) continue;
        for (const entry of cell) {
          if (distSq(entry.x, entry.z, x, z) <= rSq) result.push(entry.e);
        }
      }
    }
    return result;
  }
}
