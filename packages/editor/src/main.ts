import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import {
  applyTerrainPatch,
  decode,
  encode,
  heightAt,
  terrainFromJSON,
  type ClientMessage,
  type ServerMessage,
  type Vec3,
  type WorldDef,
} from "@mmo/shared";
import { WS_URL } from "./config";
import { loadModel } from "./assets";
import { AssetManager } from "./assetManager";
import { Inspector } from "./inspector";
import { NpcLibrary } from "./npcLibrary";
import { QuestBuilder } from "./questBuilder";
import { TerrainMesh } from "./terrainMesh";
import { TerrainPainter } from "./terrainPainter";
import { WindowManager, initMenus } from "./windows";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

type Tool = "select" | "place" | "spawner" | "spawnpoint" | "pick" | "terrain";
/** Active gizmo; null = plain selection with no gizmo attached (Q). */
type GizmoMode = "translate" | "rotate" | "scale" | null;

let def: WorldDef | null = null;
let tool: Tool = "select";
let gizmo: GizmoMode = "translate";
let activeModel = "";
let selected: THREE.Object3D | null = null;
let modelNames: string[] = [];
/** One-shot ground-click callback for the "pick" tool (quest reach positions). */
let pickCallback: ((pos: Vec3) => void) | null = null;

// ---------------------------------------------------------------------------
// Three.js setup

const viewport = $("viewport");
const renderer = new THREE.WebGLRenderer({ antialias: true });
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x252a36);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 1000);
camera.position.set(30, 35, 30);

scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(40, 60, 25);
scene.add(sun);

const terrainMesh = new TerrainMesh(scene); // flat until editor:worldState arrives
scene.add(new THREE.GridHelper(200, 40, 0x666666, 0x444444));

const propsGroup = new THREE.Group();
const spawnersGroup = new THREE.Group();
scene.add(propsGroup, spawnersGroup);

const spawnMarker = new THREE.Mesh(
  new THREE.ConeGeometry(0.6, 1.6, 12),
  new THREE.MeshLambertMaterial({ color: 0x3b82f6 }),
);
spawnMarker.geometry.translate(0, 0.8, 0);
scene.add(spawnMarker);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 0, 0);

const tc = new TransformControls(camera, renderer.domElement);
// r169+ exposes the gizmo via getHelper(); older versions are the helper.
const tcAny = tc as unknown as { getHelper?: () => THREE.Object3D };
scene.add(tcAny.getHelper ? tcAny.getHelper() : (tc as unknown as THREE.Object3D));
tc.addEventListener("dragging-changed", (e) => {
  orbit.enabled = !(e as unknown as { value: boolean }).value;
  if (!(e as unknown as { value: boolean }).value) commitTransform();
});

function resize(): void {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

renderer.setAnimationLoop(() => {
  orbit.update();
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Networking

let ws: WebSocket | null = null;
let authed = false;

function send(msg: ClientMessage): void {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
}

function connect(token: string): void {
  ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => send({ t: "editor:auth", token }));
  ws.addEventListener("message", (ev) => handleMessage(decode<ServerMessage>(String(ev.data))));
  ws.addEventListener("close", () => {
    authed = false;
    setConn(false, "disconnected");
    setStatus("disconnected — reload to reconnect");
    $("auth-overlay").classList.remove("hidden");
    $<HTMLDivElement>("auth-error").textContent = "Connection lost.";
  });
  ws.addEventListener("error", () => {
    $<HTMLDivElement>("auth-error").textContent = "Cannot reach server on :8080.";
  });
}

function handleMessage(msg: ServerMessage | null): void {
  if (!msg) return;
  switch (msg.t) {
    case "editor:authOk":
      authed = true;
      setConn(true, "connected");
      $("auth-overlay").classList.add("hidden");
      break;
    case "editor:worldState":
      def = msg.def;
      // Terrain rides along only on auth; later broadcasts omit it and the
      // local copy (kept current by our own edits + terrainPatch) stands.
      if (def.terrain) {
        const decoded = terrainFromJSON(def.terrain);
        delete def.terrain; // drop the ~180KB blob once decoded
        if (decoded) terrainMesh.setData(decoded);
      }
      void rebuild();
      questBuilder.refresh();
      npcLibrary.refresh();
      refreshKindSelect();
      break;
    case "terrainPatch":
      // Another editor sculpted; mirror it (the server never echoes our own).
      if (applyTerrainPatch(terrainMesh.terrain, msg.patch)) {
        terrainMesh.refresh();
        resnapLocal();
      }
      break;
    case "editor:saved":
      setStatus("world saved ✓");
      break;
    case "error":
      if (!authed) $<HTMLDivElement>("auth-error").textContent = msg.message;
      else setStatus(msg.message);
      break;
  }
}

function setConn(ok: boolean, text: string): void {
  $("conn").classList.toggle("ok", ok);
  $("conn-text").textContent = text;
}

function setStatus(text: string): void {
  $("status-counts").textContent = def
    ? `${def.props.length} props · ${def.spawners.length} spawners`
    : "";
  $("status-msg").textContent = text;
}

// ---------------------------------------------------------------------------
// World rendering

async function rebuild(): Promise<void> {
  if (!def) return;
  const selectedId = selected?.userData.id as string | undefined;
  const selectedKind = selected?.userData.kind as string | undefined;
  tc.detach();
  selected = null;
  propsGroup.clear();
  spawnersGroup.clear();

  for (const prop of def.props) {
    const group = new THREE.Group();
    group.position.set(prop.pos.x, prop.pos.y, prop.pos.z);
    group.rotation.y = prop.rotY;
    group.scale.setScalar(prop.scale);
    group.userData = { kind: "prop", id: prop.id };
    propsGroup.add(group);
    void loadModel(prop.model).then((model) => {
      if (group.parent) group.add(model);
    });
  }

  for (const spawner of def.spawners) {
    const marker = new THREE.Group();
    const box = new THREE.Mesh(
      new THREE.BoxGeometry(1.4, 2, 1.4),
      new THREE.MeshLambertMaterial({ color: 0xef4444, transparent: true, opacity: 0.4 }),
    );
    box.geometry.translate(0, 1, 0);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(spawner.aggroRadius - 0.15, spawner.aggroRadius, 48),
      new THREE.MeshBasicMaterial({ color: 0xef4444, side: THREE.DoubleSide, transparent: true, opacity: 0.3 }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.05;
    marker.add(box, ring);
    marker.position.set(spawner.pos.x, spawner.pos.y, spawner.pos.z);
    marker.userData = { kind: "spawner", id: spawner.id };
    spawnersGroup.add(marker);
  }

  spawnMarker.position.set(def.spawnPoint.x, def.spawnPoint.y, def.spawnPoint.z);
  resnapLocal();
  setStatus(authed ? "connected" : "connecting…");

  // Restore selection across the rebuild triggered by our own edits.
  if (selectedId) {
    const pool = selectedKind === "prop" ? propsGroup : spawnersGroup;
    const again = pool.children.find((c) => c.userData.id === selectedId);
    select(again ?? null);
  }
}

/**
 * Seat props, spawner markers, and the spawn cone on the current terrain —
 * the same y the server derives, so local visuals never drift from it.
 */
function resnapLocal(): void {
  const t = terrainMesh.terrain;
  const seat = (obj: THREE.Object3D): void => {
    obj.position.y = heightAt(t, obj.position.x, obj.position.z);
  };
  for (const g of propsGroup.children) seat(g);
  for (const m of spawnersGroup.children) seat(m);
  seat(spawnMarker);
  if (def) {
    for (const p of def.props) p.pos.y = heightAt(t, p.pos.x, p.pos.z);
    for (const s of def.spawners) s.pos.y = heightAt(t, s.pos.x, s.pos.z);
    def.spawnPoint.y = heightAt(t, def.spawnPoint.x, def.spawnPoint.z);
  }
}

// ---------------------------------------------------------------------------
// Selection + transforms

/** Attach the transform gizmo per the current mode (spawners only translate). */
function attachGizmo(): void {
  if (!selected || !gizmo) {
    tc.detach();
    return;
  }
  tc.attach(selected);
  tc.setMode(selected.userData.kind === "spawner" ? "translate" : gizmo);
}

function select(obj: THREE.Object3D | null): void {
  selected = obj;
  attachGizmo();
  if (obj) {
    inspector.show(obj.userData.kind as "prop" | "spawner", obj.userData.id as string);
    wm.show("inspector");
  } else {
    inspector.show(null, null);
  }
}

function setGizmo(mode: GizmoMode): void {
  gizmo = mode;
  if (tool !== "select") setTool("select");
  attachGizmo();
  updateToolbar();
}

function commitTransform(): void {
  if (!selected || !def) return;
  const { kind, id } = selected.userData as { kind: string; id: string };
  // Everything sits on the terrain; the server enforces the same rule.
  const y = heightAt(terrainMesh.terrain, selected.position.x, selected.position.z);
  const pos: Vec3 = { x: selected.position.x, y, z: selected.position.z };
  selected.position.y = y;
  if (kind === "prop") {
    const scale = Math.max(0.1, selected.scale.x);
    selected.scale.setScalar(scale);
    send({ t: "editor:updateProp", propId: id, pos, rotY: selected.rotation.y, scale });
  } else if (kind === "spawner") {
    selected.rotation.set(0, 0, 0);
    selected.scale.setScalar(1);
    send({ t: "editor:updateSpawner", spawnerId: id, pos });
  }
}

function deleteSelected(): void {
  if (!selected) return;
  const { kind, id } = selected.userData as { kind: string; id: string };
  if (kind === "prop") send({ t: "editor:deleteProp", propId: id });
  else if (kind === "spawner") send({ t: "editor:deleteSpawner", spawnerId: id });
  select(null);
}

// ---------------------------------------------------------------------------
// Mouse picking

const raycaster = new THREE.Raycaster();
let downX = 0;
let downY = 0;

function setRayFromEvent(e: MouseEvent): void {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(
    new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    ),
    camera,
  );
}

renderer.domElement.addEventListener("mousedown", (e) => {
  downX = e.clientX;
  downY = e.clientY;
});
renderer.domElement.addEventListener("mouseup", (e) => {
  if (e.button !== 0 || tool === "terrain") return;
  if (Math.abs(e.clientX - downX) + Math.abs(e.clientY - downY) > 5) return;
  if ((tc as unknown as { axis: string | null }).axis) return; // clicked the gizmo
  setRayFromEvent(e);
  handleClick();
});

// ── Terrain brush strokes ────────────────────────────────────────
let stroking = false;

renderer.domElement.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || tool !== "terrain") return;
  setRayFromEvent(e);
  const p = groundPoint();
  if (!p) return;
  stroking = true;
  orbit.enabled = false; // left-drag paints instead of orbiting
  renderer.domElement.setPointerCapture(e.pointerId);
  painter.strokeStart(p);
});
renderer.domElement.addEventListener("pointermove", (e) => {
  if (tool !== "terrain") return;
  setRayFromEvent(e);
  const p = groundPoint();
  painter.setCursor(p);
  if (stroking && p) painter.apply(p, e.shiftKey);
});
renderer.domElement.addEventListener("pointerup", (e) => {
  if (!stroking || e.button !== 0) return;
  stroking = false;
  orbit.enabled = true;
  painter.strokeEnd();
});

function groundPoint(): Vec3 | null {
  const hit = raycaster.intersectObject(terrainMesh.mesh)[0];
  return hit ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : null;
}

function handleClick(): void {
  if (tool === "select") {
    const hits = raycaster.intersectObjects([...propsGroup.children, ...spawnersGroup.children], true);
    for (const hit of hits) {
      let obj: THREE.Object3D | null = hit.object;
      while (obj && obj.userData.id === undefined) obj = obj.parent;
      if (obj) {
        select(obj);
        return;
      }
    }
    select(null);
    return;
  }

  const pos = groundPoint();
  if (!pos) return;
  if (tool === "pick") {
    const cb = pickCallback;
    pickCallback = null;
    setTool("select");
    cb?.(pos);
  } else if (tool === "place" && activeModel) {
    send({ t: "editor:placeProp", model: activeModel, pos, rotY: 0, scale: 1 });
  } else if (tool === "spawner") {
    const kind = $<HTMLSelectElement>("sp-kind").value || "goblin";
    send({
      t: "editor:placeSpawner",
      kind,
      // The NPC def owns the model; the spawner keeps a copy only as the
      // fallback for kinds whose def gets deleted later.
      model: def?.npcs.find((n) => n.kind === kind)?.model ?? "goblin",
      pos,
      count: Number($<HTMLInputElement>("sp-count").value) || 3,
      respawnMs: Number($<HTMLInputElement>("sp-respawn").value) || 10000,
      aggroRadius: Number($<HTMLInputElement>("sp-aggro").value) || 10,
    });
  } else if (tool === "spawnpoint") {
    send({ t: "editor:setSpawnPoint", pos });
    setTool("select");
  }
}

// ---------------------------------------------------------------------------
// Tools

function setTool(next: Tool, modelName = ""): void {
  tool = next;
  activeModel = modelName;
  if (next !== "select" && next !== "pick") select(null);
  if (next !== "pick") pickCallback = null;
  // Tool-specific windows only matter while their tool is active.
  if (next === "spawner") wm.show("spawner");
  else wm.hide("spawner");
  if (next === "terrain") wm.show("terrain");
  else {
    wm.hide("terrain");
    painter.setCursor(null);
  }
  assetManager.setActive(next === "place" ? modelName : null);
  renderer.domElement.style.cursor = next === "select" ? "default" : "crosshair";
  updateToolbar();
}

function updateToolbar(): void {
  const inSelect = tool === "select";
  $("tool-select").classList.toggle("active", inSelect && gizmo === null);
  $("tool-move").classList.toggle("active", inSelect && gizmo === "translate");
  $("tool-rotate").classList.toggle("active", inSelect && gizmo === "rotate");
  $("tool-scale").classList.toggle("active", inSelect && gizmo === "scale");
  $("tool-spawner").classList.toggle("active", tool === "spawner");
  $("tool-spawnpoint").classList.toggle("active", tool === "spawnpoint");
  $("tool-terrain").classList.toggle("active", tool === "terrain");
}

window.addEventListener("keydown", (e) => {
  // Save works even while a field is focused, like any desktop app.
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyS") {
    e.preventDefault();
    send({ t: "editor:save" });
    return;
  }
  const el = document.activeElement;
  if (el && (el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA")) return;
  switch (e.code) {
    case "Escape":
      setTool("select");
      select(null);
      break;
    case "Delete":
    case "Backspace":
      deleteSelected();
      break;
    // Unity-style tool hotkeys: Q select, W move, E rotate, R scale.
    case "KeyQ":
      setGizmo(null);
      break;
    case "KeyW":
      setGizmo("translate");
      break;
    case "KeyE":
      setGizmo("rotate");
      break;
    case "KeyR":
      setGizmo("scale");
      break;
    case "KeyT":
      setTool("terrain");
      break;
  }
});

// ---------------------------------------------------------------------------
// Chrome: menus, toolbar buttons, windows

initMenus();
const wm = new WindowManager(viewport, $("windows-menu"));

const inspectorBody = wm.register({ id: "inspector", title: "Inspector", hotkey: "F1", x: -16, y: 14, width: 250 });
const assetsBody = wm.register({ id: "assets", title: "Asset Manager", hotkey: "F2", x: 16, y: -16, width: 360 });
const questsBody = wm.register({ id: "quests", title: "Quest Builder", hotkey: "F3", x: -16, y: 340, width: 290 });
const spawnerBody = wm.register({ id: "spawner", title: "Spawner Settings", x: 16, y: 60, width: 240, open: false });
spawnerBody.appendChild($<HTMLTemplateElement>("tpl-spawner").content);
const npcsBody = wm.register({ id: "npcs", title: "NPC Library", hotkey: "F5", x: 16, y: 340, width: 280, open: false });
$("sp-manage").addEventListener("click", () => wm.show("npcs"));
// Shares the spawner window's slot: the two open with mutually exclusive tools.
const terrainBody = wm.register({ id: "terrain", title: "Terrain", hotkey: "F4", x: 16, y: 60, width: 240, open: false });

const painter = new TerrainPainter({
  body: terrainBody,
  scene,
  getTerrain: () => terrainMesh.terrain,
  onEdited: () => {
    terrainMesh.refresh();
    resnapLocal();
  },
  sendPatch: (patch) => send({ t: "editor:terrain", patch }),
});
// Picking a brush in the window arms the terrain tool (and F4 alone just
// opens the window without stealing the current tool).
painter.onModeChosen = () => {
  if (tool !== "terrain") setTool("terrain");
};

const inspector = new Inspector({
  body: inspectorBody,
  send,
  getDef: () => def,
  getModels: () => modelNames,
  getNpcKinds: () => def?.npcs.map((n) => n.kind) ?? [],
});

const npcLibrary = new NpcLibrary({
  body: npcsBody,
  send,
  getNpcs: () => def?.npcs ?? [],
  getModels: () => modelNames,
  getUsedKinds: () => {
    const used = new Set<string>();
    for (const s of def?.spawners ?? []) used.add(s.kind);
    for (const q of def?.quests ?? []) {
      used.add(q.giverKind);
      used.add(q.turnInKind);
      for (const o of q.objectives) {
        if (o.type === "kill" || o.type === "talk") used.add(o.npcKind);
      }
    }
    return used;
  },
});

/** Keep the Spawner Settings NPC dropdown in sync with the library. */
function refreshKindSelect(): void {
  const sel = $<HTMLSelectElement>("sp-kind");
  const prev = sel.value;
  sel.replaceChildren();
  for (const npc of def?.npcs ?? []) {
    const opt = document.createElement("option");
    opt.value = npc.kind;
    opt.textContent = `${npc.friendly ? "☮" : "⚔"} ${npc.kind}`;
    sel.appendChild(opt);
  }
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
}

const assetManager = new AssetManager({
  body: assetsBody,
  onPlace: (model) => setTool("place", model),
});

const questBuilder = new QuestBuilder({
  body: questsBody,
  send,
  getQuests: () => def?.quests ?? [],
  pickPoint: (cb) => {
    pickCallback = cb;
    setTool("pick");
    setStatus("click the map to pick a location…");
  },
});

$("tool-select").addEventListener("click", () => setGizmo(null));
$("tool-move").addEventListener("click", () => setGizmo("translate"));
$("tool-rotate").addEventListener("click", () => setGizmo("rotate"));
$("tool-scale").addEventListener("click", () => setGizmo("scale"));
$("tool-spawner").addEventListener("click", () => setTool("spawner"));
$("tool-spawnpoint").addEventListener("click", () => setTool("spawnpoint"));
$("tool-terrain").addEventListener("click", () => setTool("terrain"));
$("delete-btn").addEventListener("click", deleteSelected);
$("save-btn").addEventListener("click", () => send({ t: "editor:save" }));
$("menu-save").addEventListener("click", () => send({ t: "editor:save" }));
updateToolbar();

// ---------------------------------------------------------------------------
// Model palette + auth

async function initPalette(): Promise<void> {
  // Retry: the dev server may be mid-restart (tsx watch) when the page loads.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      modelNames = await assetManager.init();
      return;
    } catch {
      setStatus(`failed to load model list — retrying (${attempt}/5)…`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  setStatus("failed to load model list — is the server running?");
}

$("auth-btn").addEventListener("click", () => {
  const token = $<HTMLInputElement>("auth-token").value || "dev";
  localStorage.setItem("editorToken", token);
  connect(token);
});
$<HTMLInputElement>("auth-token").value = localStorage.getItem("editorToken") ?? "dev";

void initPalette();
