import * as THREE from "three";

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createScene(container: HTMLElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87b5e0);
  scene.fog = new THREE.Fog(0x87b5e0, 60, 140);

  const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 500);
  camera.position.set(0, 8, 12);

  const hemi = new THREE.HemisphereLight(0xffffff, 0x556b3f, 0.9);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff4e0, 1.6);
  sun.position.set(40, 60, 25);
  sun.castShadow = true;
  sun.shadow.camera.left = -60;
  sun.shadow.camera.right = 60;
  sun.shadow.camera.top = 60;
  sun.shadow.camera.bottom = -60;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  // The ground itself is the TerrainMesh, added by main.ts.

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  return { renderer, scene, camera };
}
