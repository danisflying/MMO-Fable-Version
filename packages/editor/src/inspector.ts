import type { ClientMessage, PropDef, SpawnerDef, WorldDef } from "@mmo/shared";

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

export interface InspectorOpts {
  /** Window body to render into. */
  body: HTMLElement;
  send: (msg: ClientMessage) => void;
  getDef: () => WorldDef | null;
  getModels: () => string[];
  /** NPC kinds from the world's NPC Library (spawners reference one). */
  getNpcKinds: () => string[];
}

/**
 * Property editor window for the selected prop/spawner. Fields commit on
 * change; the server applies the update and broadcasts a fresh worldState,
 * which re-renders the inspector with authoritative values.
 */
export class Inspector {
  private body: HTMLElement;
  private kind: "prop" | "spawner" | null = null;
  private id: string | null = null;

  constructor(private opts: InspectorOpts) {
    this.body = opts.body;
    this.empty("Nothing selected.");
  }

  show(kind: "prop" | "spawner" | null, id: string | null): void {
    this.kind = kind;
    this.id = id;
    this.render();
  }

  private render(): void {
    this.body.replaceChildren();
    const def = this.opts.getDef();
    if (!def || !this.kind || !this.id) {
      this.empty("Nothing selected.");
      return;
    }
    if (this.kind === "prop") {
      const prop = def.props.find((p) => p.id === this.id);
      if (!prop) return this.empty("Selection no longer exists.");
      this.renderProp(prop);
    } else {
      const spawner = def.spawners.find((s) => s.id === this.id);
      if (!spawner) return this.empty("Selection no longer exists.");
      this.renderSpawner(spawner);
    }
  }

  private empty(text: string): void {
    const div = document.createElement("div");
    div.className = "muted";
    div.textContent = text;
    this.body.appendChild(div);
  }

  private renderProp(prop: PropDef): void {
    this.header("Prop", prop.id);
    const commit = () => {
      this.opts.send({
        t: "editor:updateProp",
        propId: prop.id,
        pos: { x: num("i-x"), y: 0, z: num("i-z") },
        rotY: num("i-rot") * DEG2RAD,
        scale: Math.max(0.1, num("i-scale") || 1),
        model: (document.getElementById("i-model") as HTMLSelectElement).value,
      });
    };
    this.body.appendChild(modelSelect("i-model", this.opts.getModels(), prop.model, commit));
    this.body.appendChild(
      row(
        numField("i-x", "X", prop.pos.x, 0.1, commit),
        numField("i-z", "Z", prop.pos.z, 0.1, commit),
      ),
    );
    this.body.appendChild(
      row(
        numField("i-rot", "Rotation °", prop.rotY * RAD2DEG, 5, commit),
        numField("i-scale", "Scale", prop.scale, 0.1, commit),
      ),
    );
  }

  private renderSpawner(spawner: SpawnerDef): void {
    this.header("NPC Spawner", spawner.id);
    const commit = () => {
      this.opts.send({
        t: "editor:updateSpawner",
        spawnerId: spawner.id,
        pos: { x: num("i-x"), y: 0, z: num("i-z") },
        kind: (document.getElementById("i-kind") as HTMLSelectElement).value,
        count: num("i-count"),
        respawnMs: num("i-respawn"),
        aggroRadius: num("i-aggro"),
      });
    };
    // Model/hp/abilities live on the NPC def (NPC Library), not the spawner.
    this.body.appendChild(select("i-kind", "NPC", this.opts.getNpcKinds(), spawner.kind, commit));
    this.body.appendChild(
      row(
        numField("i-x", "X", spawner.pos.x, 0.1, commit),
        numField("i-z", "Z", spawner.pos.z, 0.1, commit),
      ),
    );
    this.body.appendChild(
      row(
        numField("i-count", "Count", spawner.count, 1, commit),
        numField("i-aggro", "Aggro radius", spawner.aggroRadius, 1, commit),
      ),
    );
    this.body.appendChild(numField("i-respawn", "Respawn (ms)", spawner.respawnMs, 1000, commit));
  }

  private header(title: string, id: string): void {
    const h = document.createElement("h3");
    h.textContent = title;
    const sub = document.createElement("div");
    sub.className = "muted";
    sub.textContent = id;
    this.body.append(h, sub);
  }
}

// ---------------------------------------------------------------------------
// Small DOM builders

function num(id: string): number {
  return Number((document.getElementById(id) as HTMLInputElement).value) || 0;
}

function row(...children: HTMLElement[]): HTMLDivElement {
  const div = document.createElement("div");
  div.className = "frow";
  div.append(...children);
  return div;
}

function labeled(id: string, text: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = text;
  input.id = id;
  label.appendChild(input);
  return label;
}

function numField(
  id: string,
  text: string,
  value: number,
  step: number,
  onChange: () => void,
): HTMLLabelElement {
  const input = document.createElement("input");
  input.type = "number";
  input.step = String(step);
  input.value = String(Math.round(value * 100) / 100);
  input.addEventListener("change", onChange);
  return labeled(id, text, input);
}

function select(
  id: string,
  text: string,
  options: string[],
  value: string,
  onChange: () => void,
): HTMLLabelElement {
  const el = document.createElement("select");
  for (const name of options) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    el.appendChild(opt);
  }
  // Preserve a value that's missing from the list (e.g. index not loaded yet).
  if (!options.includes(value)) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = value;
    el.appendChild(opt);
  }
  el.value = value;
  el.addEventListener("change", onChange);
  return labeled(id, text, el);
}

function modelSelect(
  id: string,
  models: string[],
  value: string,
  onChange: () => void,
): HTMLLabelElement {
  return select(id, "Model", models, value, onChange);
}
