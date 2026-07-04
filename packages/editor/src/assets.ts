import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "three/examples/jsm/utils/SkeletonUtils.js";
import { ASSETS_URL } from "./config";

const loader = new GLTFLoader();
const cache = new Map<string, Promise<THREE.Object3D>>();

function placeholder(): THREE.Object3D {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  return new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0xff00ff }));
}

export async function loadModel(name: string): Promise<THREE.Object3D> {
  let promise = cache.get(name);
  if (!promise) {
    promise = loader
      .loadAsync(`${ASSETS_URL}/models/${name}.glb`)
      .then((gltf) => gltf.scene as THREE.Object3D)
      .catch(() => placeholder());
    cache.set(name, promise);
  }
  return skeletonClone(await promise);
}

export async function listModels(): Promise<string[]> {
  const res = await fetch(`${ASSETS_URL}/models/index.json`);
  const data = (await res.json()) as { models: string[] };
  return data.models;
}
