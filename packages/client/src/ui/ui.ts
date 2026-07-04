import {
  isObjectiveDone,
  isQuestComplete,
  levelForXp,
  objectiveTarget,
  type AbilityDef,
  type ChatChannel,
  type PlayerQuestState,
  type QuestDef,
} from "@mmo/shared";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

export interface CooldownState {
  until: number;
  total: number;
}

export interface QuestDialogMsg {
  npc: number;
  npcKind: string;
  offers: string[];
  turnIns: string[];
}

export interface QuestDialogCallbacks {
  onAccept: (questId: string) => void;
  onTurnIn: (questId: string) => void;
}

interface AbilitySlot {
  cd: HTMLDivElement;
  cdText: HTMLDivElement;
}

export class UI {
  private joinOverlay = el<HTMLDivElement>("join-overlay");
  private joinError = el<HTMLDivElement>("join-error");
  private joinName = el<HTMLInputElement>("join-name");
  private joinBtn = el<HTMLButtonElement>("join-btn");
  private chatMessages = el<HTMLDivElement>("chat-messages");
  private chatInput = el<HTMLInputElement>("chat-input");
  private hpFill = el<HTMLDivElement>("hp-fill");
  private hpText = el<HTMLDivElement>("hp-text");
  private targetLabel = el<HTMLDivElement>("target-label");
  private bossBar = el<HTMLDivElement>("boss-bar");
  private bossName = el<HTMLDivElement>("boss-name");
  private bossHpFill = el<HTMLDivElement>("boss-hp-fill");
  private deathOverlay = el<HTMLDivElement>("death-overlay");
  private deathTimer = 0;
  private abilitySlots = new Map<string, AbilitySlot>();
  private xpFill = el<HTMLDivElement>("xp-fill");
  private xpText = el<HTMLDivElement>("xp-text");
  private questLog = el<HTMLDivElement>("quest-log");
  private questList = el<HTMLDivElement>("quest-list");
  private questDialog = el<HTMLDivElement>("quest-dialog");
  private qdTitle = el<HTMLHeadingElement>("qd-title");
  private qdBody = el<HTMLDivElement>("qd-body");
  private onAbandon: ((questId: string) => void) | null = null;
  /** Quest content pushed by the server (questDefs message). */
  private questsById: Record<string, QuestDef> = {};

  setupAbilityBar(defs: AbilityDef[], use: (id: string) => void): void {
    const bar = el<HTMLDivElement>("ability-bar");
    defs.forEach((def, i) => {
      const btn = document.createElement("button");
      btn.className = "ability";
      const what = def.heal ? `heals ${def.heal}` : `${def.damage} damage, ${def.range} range`;
      const extra = def.interrupts ? ", interrupts casts" : "";
      btn.title = `${def.name} — ${what}${extra}, ${def.cooldownMs / 1000}s cooldown`;
      btn.textContent = def.icon;
      const key = document.createElement("span");
      key.className = "key";
      key.textContent = String(i + 1);
      const cd = document.createElement("div");
      cd.className = "cd";
      const cdText = document.createElement("div");
      cdText.className = "cd-text";
      btn.append(key, cd, cdText);
      btn.addEventListener("click", () => use(def.id));
      bar.appendChild(btn);
      this.abilitySlots.set(def.id, { cd, cdText });
    });
  }

  renderCooldowns(now: number, cooldowns: Map<string, CooldownState>): void {
    for (const [id, slot] of this.abilitySlots) {
      const state = cooldowns.get(id);
      const remaining = state ? state.until - now : 0;
      if (!state || remaining <= 0) {
        slot.cd.style.height = "0%";
        slot.cdText.textContent = "";
      } else {
        slot.cd.style.height = `${Math.min(100, (remaining / state.total) * 100)}%`;
        slot.cdText.textContent = remaining > 950 ? String(Math.ceil(remaining / 1000)) : "";
      }
    }
  }

  askName(): Promise<string> {
    this.joinOverlay.classList.remove("hidden");
    this.joinName.focus();
    return new Promise((resolve) => {
      const submit = () => {
        const name = this.joinName.value.trim();
        if (name.length < 2) {
          this.showJoinError("Name must be at least 2 characters.");
          return;
        }
        this.joinBtn.removeEventListener("click", submit);
        this.joinName.removeEventListener("keydown", onKey);
        resolve(name);
      };
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") submit();
      };
      this.joinBtn.addEventListener("click", submit);
      this.joinName.addEventListener("keydown", onKey);
    });
  }

  showJoinError(message: string): void {
    this.joinOverlay.classList.remove("hidden");
    this.joinError.textContent = message;
  }

  hideJoin(): void {
    this.joinOverlay.classList.add("hidden");
    this.joinName.blur();
  }

  setupChat(send: (channel: ChatChannel, text: string) => void): void {
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && document.activeElement !== this.chatInput) {
        if (this.joinOverlay.classList.contains("hidden")) {
          this.chatInput.style.display = "block";
          this.chatInput.focus();
          e.preventDefault();
        }
      }
    });
    this.chatInput.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape") {
        this.closeChatInput();
      } else if (e.key === "Enter") {
        let text = this.chatInput.value.trim();
        let channel: ChatChannel = "local";
        if (text.startsWith("/g ")) {
          channel = "global";
          text = text.slice(3).trim();
        }
        if (text) send(channel, text);
        this.chatInput.value = "";
        this.closeChatInput();
      }
    });
  }

  private closeChatInput(): void {
    this.chatInput.blur();
    this.chatInput.style.display = "none";
  }

  addChat(channel: ChatChannel, from: string, text: string): void {
    const div = document.createElement("div");
    div.className = channel;
    const ch = document.createElement("span");
    ch.className = "ch";
    ch.textContent = channel === "global" ? "[G] " : "[L] ";
    const body = document.createElement("span");
    body.textContent = `${from}: ${text}`;
    div.append(ch, body);
    this.pushChatLine(div);
  }

  addSystem(text: string): void {
    const div = document.createElement("div");
    div.className = "sys";
    div.textContent = text;
    this.pushChatLine(div);
  }

  private pushChatLine(div: HTMLDivElement): void {
    this.chatMessages.appendChild(div);
    while (this.chatMessages.children.length > 80) {
      this.chatMessages.firstChild?.remove();
    }
    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
  }

  setHp(hp: number, maxHp: number): void {
    this.hpFill.style.width = `${Math.max(0, (hp / maxHp) * 100)}%`;
    this.hpFill.style.background = hp / maxHp > 0.3 ? "#22c55e" : "#ef4444";
    this.hpText.textContent = `${hp} / ${maxHp}`;
  }

  setTarget(name: string | null): void {
    this.targetLabel.textContent = name ? `Target: ${name}` : "";
  }

  /** Big top-center boss frame; null hides it. */
  setBossBar(name: string | null, hp = 0, maxHp = 1): void {
    if (name === null) {
      this.bossBar.classList.add("hidden");
      return;
    }
    this.bossBar.classList.remove("hidden");
    this.bossName.textContent = name;
    this.bossHpFill.style.width = `${Math.max(0, (hp / maxHp) * 100)}%`;
  }

  showDeath(): void {
    this.deathOverlay.style.display = "flex";
    clearTimeout(this.deathTimer);
    this.deathTimer = window.setTimeout(() => {
      this.deathOverlay.style.display = "none";
    }, 1800);
  }

  // -------------------------------------------------------------------------
  // Quests / XP

  setupQuestLog(onAbandon: (questId: string) => void): void {
    this.onAbandon = onAbandon;
    el<HTMLButtonElement>("qd-close").addEventListener("click", () => this.hideQuestDialog());
  }

  setQuestDefs(questsById: Record<string, QuestDef>): void {
    this.questsById = questsById;
  }

  setXp(xp: number): void {
    const { level, into, toNext } = levelForXp(xp);
    this.xpFill.style.width = `${Math.min(100, (into / toNext) * 100)}%`;
    this.xpText.textContent = `Lv ${level} — ${into}/${toNext} XP`;
  }

  get isQuestLogOpen(): boolean {
    return !this.questLog.classList.contains("hidden");
  }

  toggleQuestLog(): void {
    this.questLog.classList.toggle("hidden");
  }

  hideQuestLog(): void {
    this.questLog.classList.add("hidden");
  }

  renderQuestLog(state: PlayerQuestState): void {
    this.questList.replaceChildren();
    if (state.active.length === 0) {
      const empty = document.createElement("div");
      empty.className = "qempty";
      empty.textContent = "No active quests.";
      this.questList.appendChild(empty);
      return;
    }
    for (const qp of state.active) {
      const def = this.questsById[qp.questId];
      if (!def) continue;
      const box = document.createElement("div");
      box.className = "quest";
      const name = document.createElement("div");
      name.className = "qname";
      name.textContent = def.name;
      box.appendChild(name);
      def.objectives.forEach((obj, i) => {
        const line = document.createElement("div");
        const n = qp.progress[i] ?? 0;
        line.className = isObjectiveDone(obj, n) ? "qobj done" : "qobj";
        line.textContent = `${obj.label} (${Math.min(n, objectiveTarget(obj))}/${objectiveTarget(obj)})`;
        box.appendChild(line);
      });
      if (isQuestComplete(def, qp)) {
        const ready = document.createElement("div");
        ready.className = "qready";
        ready.textContent = "Ready to turn in";
        box.appendChild(ready);
      }
      const abandon = document.createElement("button");
      abandon.className = "qabandon";
      abandon.textContent = "Abandon";
      abandon.addEventListener("click", () => this.onAbandon?.(qp.questId));
      box.appendChild(abandon);
      this.questList.appendChild(box);
    }
  }

  get isQuestDialogOpen(): boolean {
    return !this.questDialog.classList.contains("hidden");
  }

  hideQuestDialog(): void {
    this.questDialog.classList.add("hidden");
  }

  showQuestDialog(msg: QuestDialogMsg, cb: QuestDialogCallbacks): void {
    const kind = msg.npcKind.charAt(0).toUpperCase() + msg.npcKind.slice(1);
    this.qdTitle.textContent = kind;
    this.qdBody.replaceChildren();

    for (const id of msg.turnIns) {
      const def = this.questsById[id];
      if (!def) continue;
      const box = document.createElement("div");
      box.className = "qd-quest";
      const name = document.createElement("div");
      name.className = "qname";
      name.textContent = def.name;
      const reward = document.createElement("div");
      reward.className = "qreward";
      reward.textContent = `Reward: ${def.xpReward} XP`;
      const btn = document.createElement("button");
      btn.className = "qbtn turnin";
      btn.textContent = "Complete";
      btn.addEventListener("click", () => {
        cb.onTurnIn(id);
        this.hideQuestDialog();
      });
      box.append(name, reward, btn);
      this.qdBody.appendChild(box);
    }

    for (const id of msg.offers) {
      const def = this.questsById[id];
      if (!def) continue;
      const box = document.createElement("div");
      box.className = "qd-quest";
      const name = document.createElement("div");
      name.className = "qname";
      name.textContent = def.name;
      const desc = document.createElement("div");
      desc.className = "qdesc";
      desc.textContent = def.description;
      const reward = document.createElement("div");
      reward.className = "qreward";
      reward.textContent = `Reward: ${def.xpReward} XP`;
      const btn = document.createElement("button");
      btn.className = "qbtn";
      btn.textContent = "Accept";
      btn.addEventListener("click", () => {
        cb.onAccept(id);
        this.hideQuestDialog();
      });
      box.append(name, desc, reward, btn);
      this.qdBody.appendChild(box);
    }

    if (msg.turnIns.length === 0 && msg.offers.length === 0) {
      const flavor = document.createElement("div");
      flavor.className = "qd-flavor";
      flavor.textContent = "Nothing for you right now. Safe travels.";
      this.qdBody.appendChild(flavor);
    }

    this.questDialog.classList.remove("hidden");
  }
}
