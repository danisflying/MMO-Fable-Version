import { listModels } from "./assets";

export interface AssetManagerOpts {
  /** Window body to render into. */
  body: HTMLElement;
  /** User clicked a tile: activate the place-prop tool with this model. */
  onPlace: (model: string) => void;
}

/**
 * Asset Manager window: filterable tile grid of the models the server serves.
 * Clicking a tile arms the place tool; the active tile mirrors the tool state
 * via setActive() so toolbar/Escape changes stay in sync.
 *
 * Thumbnails are name-hashed color swatches for now; real GLB renders (and
 * import/delete, which need server endpoints) are planned follow-ups.
 */
export class AssetManager {
  private grid: HTMLDivElement;
  private tiles = new Map<string, HTMLButtonElement>();
  private names: string[] = [];

  constructor(private opts: AssetManagerOpts) {
    const filter = document.createElement("input");
    filter.type = "search";
    filter.placeholder = "Filter models…";
    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      for (const [name, tile] of this.tiles) {
        tile.style.display = name.toLowerCase().includes(q) ? "" : "none";
      }
    });

    this.grid = document.createElement("div");
    this.grid.className = "asset-grid";

    const hint = document.createElement("div");
    hint.className = "muted";
    hint.textContent = "Click a model, then click the ground to place it.";

    opts.body.append(filter, this.grid, hint);
  }

  /** Fetch the model list and build the grid; returns the names for reuse. */
  async init(): Promise<string[]> {
    this.names = await listModels();
    this.grid.replaceChildren();
    this.tiles.clear();
    for (const name of this.names) {
      const tile = document.createElement("button");
      tile.className = "asset";
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      const hue = hashHue(name);
      thumb.style.background = `linear-gradient(160deg, hsl(${hue} 32% 34%), hsl(${hue} 40% 20%))`;
      const label = document.createElement("div");
      label.className = "name";
      label.textContent = name;
      label.title = name;
      tile.append(thumb, label);
      tile.addEventListener("click", () => this.opts.onPlace(name));
      this.grid.appendChild(tile);
      this.tiles.set(name, tile);
    }
    return this.names;
  }

  /** Highlight the model armed for placement (null clears). */
  setActive(model: string | null): void {
    for (const [name, tile] of this.tiles) {
      tile.classList.toggle("active", name === model);
    }
  }
}

/** Stable hue per model name so tiles are distinguishable without thumbnails. */
function hashHue(name: string): number {
  let h = 7;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % 360;
}
