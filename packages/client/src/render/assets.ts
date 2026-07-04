import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { ASSETS_URL } from "../config";

export interface LoadedModel {
  object: THREE.Object3D;
  /** Shared clips from the GLB; bind them to `object` via an AnimationMixer. */
  animations: THREE.AnimationClip[];
}

interface CacheEntry {
  scene: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

const loader = new GLTFLoader();
const cache = new Map<string, Promise<CacheEntry>>();

function placeholder(): CacheEntry {
  const geo = new THREE.CapsuleGeometry(0.4, 0.9, 4, 8);
  geo.translate(0, 0.85, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xff00ff }));
  mesh.castShadow = true;
  return { scene: mesh, animations: [] };
}

/** Load a GLB by model name (cached); returns a fresh clone per call. */
export async function loadModel(name: string): Promise<LoadedModel> {
  let promise = cache.get(name);
  if (!promise) {
    promise = loader
      .loadAsync(`${ASSETS_URL}/models/${name}.glb`)
      .then((gltf) => {
        gltf.scene.traverse((obj) => {
          if ((obj as THREE.Mesh).isMesh) obj.castShadow = true;
        });
        return { scene: gltf.scene as THREE.Object3D, animations: gltf.animations };
      })
      .catch((err) => {
        console.warn(`failed to load model "${name}", using placeholder`, err);
        return placeholder();
      });
    cache.set(name, promise);
  }
  const entry = await promise;
  return { object: skeletonClone(entry.scene), animations: entry.animations };
}
