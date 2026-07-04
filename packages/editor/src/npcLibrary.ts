import { ABILITIES, type ClientMessage, type NpcDef } from "@mmo/shared";

export interface NpcLibraryOpts {
  /** Window body to render into. */
  body: HTMLElement;
  send: (msg: ClientMessage) => void;
  getNpcs: () => NpcDef[];
  getModels: () => string[];
  /** Kinds referenced by spawners or quests — their defs can't be deleted. */
  getUsedKinds: () => Set<string>;
}

/**
 * NPC definition editor window. Like the Quest Builder, edits happen on a
 * local draft; Apply sends the full list via editor:setNpcs (the server
 * sanitizes, respawns live NPCs with the new stats, and broadcasts a fresh
 * worldState).
 */
export class NpcLibrary {
  private list: HTMLDivElement;
  private form: HTMLDivElement;
  private draft: NpcDef | null = null;
  /** Original kind of the def being edited ("" = new NPC). */
  private editingKind = "";

  constructor(private opts: NpcLibraryOpts) {
    this.list = document.createElement("div");
    this.list.style.display = "flex";
    this.list.style.flexDirection = "column";
    this.list.style.gap = "6px";
    const newBtn = document.createElement("button");
    newBtn.textContent = "+ New NPC";
    this.form = document.createElement("div");
    this.form.style.display = "flex";
    this.form.style.flexDirection = "column";
    this.form.style.gap = "8px";
    opts.body.append(this.list, newBtn, this.form);

    newBtn.addEventListener("click", () => {
      this.draft = {
        kind: "",
        model: this.opts.getModels()[0] ?? "goblin",
        hp: 40,
        friendly: false,
        abilities: ["gnash"],
      };
      this.editingKind = "";
      this.renderForm();
    });
  }

  /** Re-render the NPC list (called on every worldState). */
  refresh(): void {
    this.list.replaceChildren();
    const used = this.opts.getUsedKinds();
    for (const npc of this.opts.getNpcs()) {
      const row = document.createElement("div");
      row.className = "quest-row";
      const name = document.createElement("div");
      name.className = "qname";
      name.textContent = `${npc.boss ? "👑" : npc.friendly ? "☮" : "⚔"} ${npc.kind}`;
      const meta = document.createElement("span");
      meta.className = "qid";
      meta.textContent = ` ${npc.hp} hp`;
      name.appendChild(meta);
      const edit = document.createElement("button");
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        this.draft = structuredClone(npc);
        this.editingKind = npc.kind;
        this.renderForm();
      });
      const del = document.createElement("button");
      del.className = "danger";
      del.textContent = "✕";
      if (used.has(npc.kind)) {
        del.disabled = true;
        del.title = "In use by a spawner or quest.";
      } else {
        del.title = "Delete NPC definition";
        del.addEventListener("click", () => {
          if (!confirm(`Delete NPC "${npc.kind}"?`)) return;
          this.opts.send({
            t: "editor:setNpcs",
            npcs: this.opts.getNpcs().filter((n) => n.kind !== npc.kind),
          });
        });
      }
      row.append(name, edit, del);
      this.list.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Edit form

  private renderForm(): void {
    this.form.replaceChildren();
    const draft = this.draft;
    if (!draft) return;

    const kindInput = document.createElement("input");
    kindInput.value = draft.kind;
    kindInput.placeholder = "e.g. wolf";
    if (this.editingKind) {
      // Spawners and quests reference the kind by name; renaming would orphan them.
      kindInput.disabled = true;
      kindInput.title = "Kind is the identity — create a new NPC to use a different name.";
    }
    kindInput.addEventListener("input", () => (draft.kind = kindInput.value));
    this.form.appendChild(labeled("Kind", kindInput));

    const modelSelect = document.createElement("select");
    for (const name of this.opts.getModels()) {
      const opt = document.createElement("option");
      opt.value = name;
      opt.textContent = name;
      modelSelect.appendChild(opt);
    }
    if (!this.opts.getModels().includes(draft.model)) {
      const opt = document.createElement("option");
      opt.value = draft.model;
      opt.textContent = draft.model;
      modelSelect.appendChild(opt);
    }
    modelSelect.value = draft.model;
    modelSelect.addEventListener("change", () => (draft.model = modelSelect.value));
    this.form.appendChild(labeled("Model", modelSelect));

    const hpInput = document.createElement("input");
    hpInput.type = "number";
    hpInput.min = "1";
    hpInput.value = String(draft.hp);
    hpInput.addEventListener("change", () => (draft.hp = Number(hpInput.value) || 40));
    this.form.appendChild(labeled("Max HP", hpInput));

    const scaleInput = document.createElement("input");
    scaleInput.type = "number";
    scaleInput.min = "0.2";
    scaleInput.max = "5";
    scaleInput.step = "0.1";
    scaleInput.value = String(draft.scale ?? 1);
    scaleInput.addEventListener("change", () => {
      const v = Number(scaleInput.value);
      if (Number.isFinite(v) && v !== 1) draft.scale = v;
      else delete draft.scale;
    });
    this.form.appendChild(labeled("Scale", scaleInput));

    const friendlyRow = document.createElement("label");
    friendlyRow.className = "check-row";
    const friendlyBox = document.createElement("input");
    friendlyBox.type = "checkbox";
    friendlyBox.checked = draft.friendly;
    friendlyRow.append(friendlyBox, document.createTextNode(" Friendly (never fights; can give quests)"));
    this.form.appendChild(friendlyRow);

    const kit = document.createElement("div");
    kit.className = "ability-checks";
    const kitLabel = document.createElement("div");
    kitLabel.className = "muted";
    kitLabel.textContent = "Ability kit";
    kit.appendChild(kitLabel);
    for (const def of Object.values(ABILITIES)) {
      const row = document.createElement("label");
      row.className = "check-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = draft.abilities.includes(def.id);
      box.addEventListener("change", () => {
        draft.abilities = box.checked
          ? [...draft.abilities, def.id]
          : draft.abilities.filter((id) => id !== def.id);
      });
      const stats = def.summon
        ? `summons ${def.summon.count}× ${def.summon.kind}`
        : def.heal
          ? `heals ${def.heal}`
          : `${def.damage} dmg · ${def.range} range`;
      const cast = def.castMs ? ` · ${def.castMs / 1000}s cast` : "";
      row.append(
        box,
        document.createTextNode(` ${def.icon} ${def.name} — ${stats}${cast}, ${def.cooldownMs / 1000}s cd`),
      );
      kit.appendChild(row);
    }
    // ── Boss settings (hostile only): HUD bar + phase-2 kit unlock ────────
    const bossSection = document.createElement("div");
    bossSection.className = "ability-checks";
    const bossRow = document.createElement("label");
    bossRow.className = "check-row";
    const bossBox = document.createElement("input");
    bossBox.type = "checkbox";
    bossBox.checked = !!draft.boss;
    bossRow.append(
      bossBox,
      document.createTextNode(" 👑 Boss — big HUD health bar, phase 2 at low HP"),
    );
    bossSection.appendChild(bossRow);

    const bossOpts = document.createElement("div");
    bossOpts.className = "ability-checks";
    const fracInput = document.createElement("input");
    fracInput.type = "number";
    fracInput.min = "5";
    fracInput.max = "95";
    fracInput.step = "5";
    fracInput.value = String(Math.round((draft.boss?.phase2AtFrac ?? 0.5) * 100));
    fracInput.addEventListener("change", () => {
      if (draft.boss) draft.boss.phase2AtFrac = (Number(fracInput.value) || 50) / 100;
    });
    bossOpts.appendChild(labeled("Phase 2 below HP %", fracInput));
    const p2Label = document.createElement("div");
    p2Label.className = "muted";
    p2Label.textContent = "Phase 2 adds these abilities";
    bossOpts.appendChild(p2Label);
    for (const def of Object.values(ABILITIES)) {
      const row = document.createElement("label");
      row.className = "check-row";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!draft.boss?.phase2Abilities.includes(def.id);
      box.addEventListener("change", () => {
        if (!draft.boss) return;
        draft.boss.phase2Abilities = box.checked
          ? [...draft.boss.phase2Abilities, def.id]
          : draft.boss.phase2Abilities.filter((id) => id !== def.id);
      });
      const what = def.summon
        ? `summons ${def.summon.count}× ${def.summon.kind}`
        : def.heal
          ? `heals ${def.heal}`
          : `${def.damage} dmg · ${def.range} range`;
      const cast = def.castMs ? `, ${def.castMs / 1000}s cast` : "";
      row.append(box, document.createTextNode(` ${def.icon} ${def.name} — ${what}${cast}`));
      bossOpts.appendChild(row);
    }
    bossOpts.style.display = draft.boss ? "flex" : "none";
    bossBox.addEventListener("change", () => {
      if (bossBox.checked) {
        draft.boss = draft.boss ?? { phase2AtFrac: 0.5, phase2Abilities: [] };
      } else {
        delete draft.boss;
      }
      bossOpts.style.display = draft.boss ? "flex" : "none";
    });
    bossSection.appendChild(bossOpts);

    const hostileOnly = () => {
      kit.style.display = draft.friendly ? "none" : "flex";
      bossSection.style.display = draft.friendly ? "none" : "flex";
    };
    hostileOnly();
    friendlyBox.addEventListener("change", () => {
      draft.friendly = friendlyBox.checked;
      hostileOnly();
    });
    this.form.appendChild(kit);
    this.form.appendChild(bossSection);

    const buttons = document.createElement("div");
    buttons.className = "frow";
    const apply = document.createElement("button");
    apply.className = "primary";
    apply.textContent = "Apply (live)";
    apply.addEventListener("click", () => this.apply());
    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => {
      this.draft = null;
      this.form.replaceChildren();
    });
    buttons.append(apply, cancel);
    this.form.appendChild(buttons);
  }

  private apply(): void {
    const draft = this.draft;
    if (!draft) return;
    draft.kind = draft.kind.trim();
    if (!draft.kind) {
      alert("Kind is required.");
      return;
    }
    const npcs = this.opts.getNpcs();
    if (!this.editingKind && npcs.some((n) => n.kind === draft.kind)) {
      alert(`An NPC named "${draft.kind}" already exists.`);
      return;
    }
    const next = this.editingKind
      ? npcs.map((n) => (n.kind === this.editingKind ? draft : n))
      : [...npcs, draft];
    this.opts.send({ t: "editor:setNpcs", npcs: next });
    this.draft = null;
    this.form.replaceChildren();
  }
}

function labeled(text: string, input: HTMLElement): HTMLLabelElement {
  const label = document.createElement("label");
  label.textContent = text;
  label.appendChild(input);
  return label;
}
