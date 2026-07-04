/**
 * Floating-window system: draggable, collapsible, closable panels overlaid on
 * the viewport, toggled from the Windows menu or an F-key. Positions and
 * visibility persist to localStorage so the layout survives reloads.
 */

export interface WindowOpts {
  id: string;
  title: string;
  /** e.g. "F1" — toggles the window; shown next to its Windows-menu entry. */
  hotkey?: string;
  /** Default position; negative values anchor to the right/bottom edge. */
  x: number;
  y: number;
  width: number;
  /** Start visible (default true). */
  open?: boolean;
}

interface Win {
  opts: WindowOpts;
  root: HTMLDivElement;
  body: HTMLDivElement;
  check: HTMLSpanElement;
  collapseBtn: HTMLButtonElement;
}

interface LayoutEntry {
  x: number;
  y: number;
  open: boolean;
  collapsed: boolean;
}

const LAYOUT_KEY = "mmo-editor-layout";
/** Keep at least this much of a dragged-out window reachable. */
const DRAG_MARGIN = 60;

export class WindowManager {
  private wins = new Map<string, Win>();
  private zTop = 10;
  private layout: Record<string, LayoutEntry> = {};

  constructor(
    private container: HTMLElement,
    private menu: HTMLElement,
  ) {
    try {
      this.layout = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "{}") as Record<string, LayoutEntry>;
    } catch {
      this.layout = {};
    }

    const reset = document.createElement("button");
    reset.innerHTML = `<span class="check"></span>Reset Layout`;
    reset.addEventListener("click", () => this.resetLayout());
    const hr = document.createElement("hr");
    this.menu.append(hr, reset);
    // Registered windows insert their menu items above this separator.
    this.menuTail = hr;

    window.addEventListener("keydown", (e) => {
      for (const win of this.wins.values()) {
        if (win.opts.hotkey && e.code === win.opts.hotkey) {
          e.preventDefault();
          this.toggle(win.opts.id);
        }
      }
    });
    window.addEventListener("resize", () => {
      for (const id of this.wins.keys()) this.clampIntoView(id);
    });
  }

  private menuTail: HTMLElement;

  /** Create a window and its Windows-menu entry; returns the body to render into. */
  register(opts: WindowOpts): HTMLDivElement {
    const root = document.createElement("div");
    root.className = "window";
    root.dataset.windowId = opts.id;
    root.style.width = `${opts.width}px`;

    const title = document.createElement("div");
    title.className = "win-title";
    const label = document.createElement("span");
    label.textContent = opts.title;
    const spacer = document.createElement("span");
    spacer.className = "spacer";
    const collapseBtn = document.createElement("button");
    collapseBtn.className = "win-btn";
    collapseBtn.title = "Collapse";
    collapseBtn.textContent = "–";
    const closeBtn = document.createElement("button");
    closeBtn.className = "win-btn close";
    closeBtn.title = "Close";
    closeBtn.textContent = "✕";
    title.append(label, spacer, collapseBtn, closeBtn);

    const body = document.createElement("div");
    body.className = "win-body";
    root.append(title, body);
    this.container.appendChild(root);

    const item = document.createElement("button");
    const check = document.createElement("span");
    check.className = "check";
    item.append(check, document.createTextNode(opts.title));
    if (opts.hotkey) {
      const kbd = document.createElement("span");
      kbd.className = "kbd";
      kbd.textContent = opts.hotkey;
      item.appendChild(kbd);
    }
    item.addEventListener("click", () => this.toggle(opts.id));
    this.menu.insertBefore(item, this.menuTail);

    const win: Win = { opts, root, body, check, collapseBtn };
    this.wins.set(opts.id, win);

    root.addEventListener("pointerdown", () => {
      root.style.zIndex = String(++this.zTop);
    });
    closeBtn.addEventListener("click", () => this.hide(opts.id));
    collapseBtn.addEventListener("click", () => this.setCollapsed(opts.id, !root.classList.contains("collapsed")));
    this.makeDraggable(win, title);

    this.applyLayout(opts.id);
    return body;
  }

  isOpen(id: string): boolean {
    return !this.wins.get(id)?.root.classList.contains("hidden");
  }

  show(id: string): void {
    this.setOpen(id, true);
  }

  hide(id: string): void {
    this.setOpen(id, false);
  }

  toggle(id: string): void {
    this.setOpen(id, !this.isOpen(id));
  }

  resetLayout(): void {
    this.layout = {};
    localStorage.removeItem(LAYOUT_KEY);
    for (const id of this.wins.keys()) this.applyLayout(id);
  }

  private setOpen(id: string, open: boolean): void {
    const win = this.wins.get(id);
    if (!win) return;
    win.root.classList.toggle("hidden", !open);
    win.check.textContent = open ? "✓" : "";
    if (open) win.root.style.zIndex = String(++this.zTop);
    this.entry(id).open = open;
    this.persist();
  }

  private setCollapsed(id: string, collapsed: boolean): void {
    const win = this.wins.get(id);
    if (!win) return;
    win.root.classList.toggle("collapsed", collapsed);
    win.collapseBtn.textContent = collapsed ? "+" : "–";
    this.entry(id).collapsed = collapsed;
    this.persist();
  }

  /** Saved layout entry for a window, created from its defaults on first use. */
  private entry(id: string): LayoutEntry {
    let entry = this.layout[id];
    if (!entry) {
      const { opts } = this.wins.get(id)!;
      entry = {
        x: this.resolveX(opts.x, opts.width),
        y: this.resolveY(opts.y),
        open: opts.open !== false,
        collapsed: false,
      };
      this.layout[id] = entry;
    }
    return entry;
  }

  /** Negative default coords anchor to the far edge (x: -16 = 16px from the right). */
  private resolveX(x: number, width: number): number {
    return x >= 0 ? x : this.container.clientWidth + x - width;
  }

  private resolveY(y: number): number {
    // Windows size to content, which hasn't rendered at register time;
    // bottom-anchoring assumes a ~200px-tall window and clamps from there.
    return y >= 0 ? y : this.container.clientHeight + y - 200;
  }

  private applyLayout(id: string): void {
    const win = this.wins.get(id)!;
    // After a reset there's no saved entry; entry() re-derives the defaults.
    const entry = this.entry(id);
    win.root.style.left = `${entry.x}px`;
    win.root.style.top = `${entry.y}px`;
    win.root.classList.toggle("hidden", !entry.open);
    win.check.textContent = entry.open ? "✓" : "";
    win.root.classList.toggle("collapsed", entry.collapsed);
    win.collapseBtn.textContent = entry.collapsed ? "+" : "–";
    this.clampIntoView(id);
  }

  private clampIntoView(id: string): void {
    const win = this.wins.get(id)!;
    const entry = this.entry(id);
    const maxX = this.container.clientWidth - DRAG_MARGIN;
    const maxY = this.container.clientHeight - 30;
    entry.x = Math.max(DRAG_MARGIN - win.opts.width, Math.min(maxX, entry.x));
    entry.y = Math.max(0, Math.min(maxY, entry.y));
    win.root.style.left = `${entry.x}px`;
    win.root.style.top = `${entry.y}px`;
  }

  private makeDraggable(win: Win, title: HTMLDivElement): void {
    title.addEventListener("pointerdown", (e) => {
      if ((e.target as HTMLElement).closest(".win-btn")) return;
      e.preventDefault();
      const entry = this.entry(win.opts.id);
      const startX = e.clientX - entry.x;
      const startY = e.clientY - entry.y;
      title.setPointerCapture(e.pointerId);
      const move = (ev: PointerEvent): void => {
        entry.x = ev.clientX - startX;
        entry.y = ev.clientY - startY;
        this.clampIntoView(win.opts.id);
      };
      const up = (): void => {
        title.removeEventListener("pointermove", move);
        title.removeEventListener("pointerup", up);
        this.persist();
      };
      title.addEventListener("pointermove", move);
      title.addEventListener("pointerup", up);
    });
  }

  private persist(): void {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(this.layout));
  }
}

/** Menu-bar behavior: click opens a dropdown, outside click / item click closes. */
export function initMenus(): void {
  const menus = document.querySelectorAll<HTMLElement>(".menu");
  for (const menu of menus) {
    const trigger = menu.querySelector<HTMLButtonElement>(":scope > button")!;
    trigger.addEventListener("click", (e) => {
      e.stopPropagation();
      const wasOpen = menu.classList.contains("open");
      for (const m of menus) m.classList.remove("open");
      if (!wasOpen) menu.classList.add("open");
    });
  }
  window.addEventListener("click", () => {
    for (const m of menus) m.classList.remove("open");
  });
}
