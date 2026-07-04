import * as THREE from "three";
import {
  TERRAIN_LAYERS,
  blendSplatColors,
  createFlatTerrain,
  terrainIndices,
  terrainPositions,
  type TerrainData,
} from "@mmo/shared";

/**
 * Editor-side ground mesh: identical construction to the client's
 * render/terrain.ts (each package wraps the shared arrays with its own
 * three.js), so what the editor sculpts is what players stand on.
 */
export class TerrainMesh {
  readonly mesh: THREE.Mesh;
  private data: TerrainData;
  private readonly palette = TERRAIN_LAYERS.map((l) => {
    const c = new THREE.Color(l.color);
    return [c.r, c.g, c.b] as const;
  });

  constructor(scene: THREE.Scene, data: TerrainData = createFlatTerrain()) {
    this.data = data;
    this.mesh = new THREE.Mesh(
      this.buildGeometry(),
      new THREE.MeshLambertMaterial({ vertexColors: true }),
    );
    this.mesh.name = "terrain";
    scene.add(this.mesh);
  }

  get terrain(): TerrainData {
    return this.data;
  }

  setData(data: TerrainData): void {
    this.data = data;
    this.mesh.geometry.dispose();
    this.mesh.geometry = this.buildGeometry();
  }

  /** Re-upload heights and colors after the underlying data changed. */
  refresh(): void {
    const geo = this.mesh.geometry;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < this.data.heights.length; i++) {
      pos.setY(i, this.data.heights[i]);
    }
    pos.needsUpdate = true;
    const color = geo.getAttribute("color") as THREE.BufferAttribute;
    blendSplatColors(this.data, this.palette, color.array as Float32Array);
    color.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
  }

  private buildGeometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(terrainPositions(this.data), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(blendSplatColors(this.data, this.palette), 3));
    geo.setIndex(new THREE.BufferAttribute(terrainIndices(this.data), 1));
    geo.computeVertexNormals();
    return geo;
  }
}
