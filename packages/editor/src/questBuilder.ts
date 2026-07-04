import type { ClientMessage, QuestDef, QuestObjective, Vec3 } from "@mmo/shared";

export interface QuestBuilderOpts {
  /** Window body to render into. */
  body: HTMLElement;
  send: (msg: ClientMessage) => void;
  getQuests: () => QuestDef[];
  /** Ask the viewport for one ground click (used by reach objectives). */
  pickPoint: (cb: (pos: Vec3) => void) => void;
}

/**
 * Quest editor window. Edits happen on a local draft; Apply sends the
 * full quest list via editor:setQuests (the server sanitizes, applies live,
 * and broadcasts a fresh worldState).
 */
export class QuestBuilder {
  private list: HTMLDivElement;
  private form: HTMLDivElement;
  /** Deep-copied draft while editing; null = no form open. */
  private draft: QuestDef | null = null;
  /** Original id of the quest being edited ("" = new quest). */
  private editingId = "";

  constructor(private opts: QuestBuilderOpts) {
    this.list = document.createElement("div");
    this.list.style.display = "flex";
    this.list.style.flexDirection = "column";
    this.list.style.gap = "6px";
    const newBtn = document.createElement("button");
    newBtn.textContent = "+ New quest";
    this.form = document.createElement("div");
    this.form.style.display = "flex";
    this.form.style.flexDirection = "column";
    this.form.style.gap = "8px";
    opts.body.append(this.list, newBtn, this.form);

    newBtn.addEventListener("click", () => {
      this.draft = {
        id: `quest_${Date.now().toString(36)}`,
        name: "New Quest",
        description: "",
        giverKind: "villager",
        turnInKind: "villager",
        objectives: [{ type: "kill", npcKind: "goblin", count: 5, label: "Slay goblins" }],
        xpReward: 50,
      };
      this.editingId = "";
      this.renderForm();
    });
  }

  /** Re-render the quest list (called on every worldState). */
  refresh(): void {
    this.list.replaceChildren();
    const quests = this.opts.getQuests();
    if (quests.length === 0) {
      const div = document.createElement("div");
      div.className = "muted";
      div.textContent = "No quests yet.";
      this.list.appendChild(div);
    }
    for (const quest of quests) {
      const row = document.createElement("div");
      row.className = "quest-row";
      const name = document.createElement("div");
      name.className = "qname";
      name.textContent = quest.name;
      const id = document.createElement("span");
      id.className = "qid";
      id.textContent = ` ${quest.id}`;
      name.appendChild(id);
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        this.draft = structuredClone(quest);
        this.editingId = quest.id;
        this.renderForm();
      });
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "✕";
      del.title = "Delete quest";
      del.addEventListener("click", () => {
        if (!confirm(`Delete quest "${quest.name}"?`)) return;
        this.opts.send({
          t: "editor:setQuests",
          quests: this.opts.getQuests().filter((q) => q.id !== quest.id),
        });
      });
      row.append(name, edit, del);
      this.list.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Edit form

  private renderForm(): void {
    this.form.replaceChildren();
    const d = this.draft;
    if (!d) return;

    const h = document.createElement("h3");
    h.textContent = this.editingId ? `Editing: ${this.editingId}` : "New quest";
    this.form.appendChild(h);

    this.form.appendChild(this.text("Id", d.id, (v) => (d.id = v)));
    this.form.appendChild(this.text("Name", d.name, (v) => (d.name = v)));

    const descLabel = document.createElement("label");
    descLabel.textContent = "Description";
    const desc = document.createElement("textarea");
    desc.value = d.description;
    desc.addEventListener("input", () => (d.description = desc.value));
    descLabel.appendChild(desc);
    this.form.appendChild(descLabel);

    this.form.appendChild(
      this.row(
        this.text("Giver kind", d.giverKind, (v) => (d.giverKind = v)),
        this.text("Turn-in kind", d.turnInKind, (v) => (d.turnInKind = v)),
      ),
    );
    this.form.appendChild(
      this.row(
        this.number("XP reward", d.xpReward, (v) => (d.xpReward = Math.max(0, Math.round(v)))),
        this.prereqSelect(d),
      ),
    );

    const objHeader = document.createElement("h3");
    objHeader.textContent = "Objectives";
    this.form.appendChild(objHeader);
    d.objectives.forEach((obj, i) => this.form.appendChild(this.objectiveBox(d, obj, i)));

    const addObj = document.createElement("button");
    addObj.textContent = "+ Objective";
    addObj.addEventListener("click", () => {
      d.objectives.push({ type: "kill", npcKind: "goblin", count: 1, label: "New objective" });
      this.renderForm();
    });
    this.form.appendChild(addObj);

    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Apply";
    apply.addEventListener("click", () => this.apply());
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.draft = null;
      this.form.replaceChildren();
    });
    this.form.appendChild(this.row(apply, cancel));
  }

  private apply(): void {
    const d = this.draft;
    if (!d) return;
    d.id = d.id.trim().replace(/[^a-zA-Z0-9_-]/g, "_");
    if (!d.id || !d.giverKind.trim() || !d.turnInKind.trim() || d.objectives.length === 0) {
      alert("A quest needs an id, giver kind, turn-in kind, and at least one objective.");
      return;
    }
    const quests = this.opts.getQuests().slice();
    const idx = quests.findIndex((q) => q.id === this.editingId);
    // Renaming onto an id that already belongs to another quest would clobber it.
    if (quests.some((q, i) => q.id === d.id && i !== idx)) {
      alert(`Another quest already uses the id "${d.id}".`);
      return;
    }
    if (idx >= 0) quests[idx] = d;
    else quests.push(d);
    this.opts.send({ t: "editor:setQuests", quests });
    this.draft = null;
    this.form.replaceChildren();
  }

  private objectiveBox(d: QuestDef, obj: QuestObjective, i: number): HTMLDivElement {
    const box = document.createElement("div");
    box.className = "objective-box";

    const head = document.createElement("div");
    head.className = "obj-head";
    const type = document.createElement("select");
    for (const t of ["kill", "talk", "reach"]) {
      const opt = document.createElement("option");
      opt.value = t;
      opt.textContent = t;
      type.appendChild(opt);
    }
    type.value = obj.type;
    type.addEventListener("change", () => {
      const label = obj.label;
      if (type.value === "kill") d.objectives[i] = { type: "kill", npcKind: "goblin", count: 1, label };
      else if (type.value === "talk") d.objectives[i] = { type: "talk", npcKind: "guard", label };
      else d.objectives[i] = { type: "reach", pos: { x: 0, y: 0, z: 0 }, radius: 5, label };
      this.renderForm();
    });
    const remove = document.createElement("button");
    remove.className = "danger";
    remove.textContent = "✕";
    remove.title = "Remove objective";
    remove.addEventListener("click", () => {
      d.objectives.splice(i, 1);
      this.renderForm();
    });
    head.append(type, remove);
    box.appendChild(head);

    box.appendChild(this.text("Label", obj.label, (v) => (obj.label = v)));
    if (obj.type === "kill") {
      box.appendChild(
        this.row(
          this.text("NPC kind", obj.npcKind, (v) => (obj.npcKind = v)),
          this.number("Count", obj.count, (v) => (obj.count = Math.max(1, Math.round(v)))),
        ),
      );
    } else if (obj.type === "talk") {
      box.appendChild(this.text("NPC kind", obj.npcKind, (v) => (obj.npcKind = v)));
    } else {
      const xField = this.number("X", obj.pos.x, (v) => (obj.pos.x = v));
      const zField = this.number("Z", obj.pos.z, (v) => (obj.pos.z = v));
      box.appendChild(this.row(xField, zField));
      box.appendChild(this.number("Radius", obj.radius, (v) => (obj.radius = Math.max(0.5, v))));
      const pick = document.createElement("button");
      pick.textContent = "Pick location on map";
      pick.addEventListener("click", () => {
        this.opts.pickPoint((pos) => {
          obj.pos = { x: Math.round(pos.x * 10) / 10, y: 0, z: Math.round(pos.z * 10) / 10 };
          this.renderForm();
        });
      });
      box.appendChild(pick);
    }
    return box;
  }

  private prereqSelect(d: QuestDef): HTMLLabelElement {
    const label = document.createElement("label");
    label.textContent = "Prerequisite";
    const select = document.createElement("select");
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "(none)";
    select.appendChild(none);
    for (const q of this.opts.getQuests()) {
      if (q.id === this.editingId) continue;
      const opt = document.createElement("option");
      opt.value = q.id;
      opt.textContent = q.name;
      select.appendChild(opt);
    }
    select.value = d.prereq ?? "";
    select.addEventListener("change", () => {
      if (select.value) d.prereq = select.value;
      else delete d.prereq;
    });
    label.appendChild(select);
    return label;
  }

  // -------------------------------------------------------------------------
  // Field helpers (draft-bound: update on input, no network traffic)

  private text(text: string, value: string, set: (v: string) => void): HTMLLabelElement {
    const label = document.createElement("label");
    label.textContent = text;
    const input = document.createElement("input");
    input.value = value;
    input.addEventListener("input", () => set(input.value));
    label.appendChild(input);
    return label;
  }

  private number(text: string, value: number, set: (v: number) => void): HTMLLabelElement {
    const label = document.createElement("label");
    label.textContent = text;
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.addEventListener("input", () => set(Number(input.value) || 0));
    label.appendChild(input);
    return label;
  }

  private row(...children: HTMLElement[]): HTMLDivElement {
    const div = document.createElement("div");
    div.className = "frow";
    div.append(...children);
    return div;
  }
}
