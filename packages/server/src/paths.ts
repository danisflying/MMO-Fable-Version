import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = resolve(here, "..", "..", "..");
export const ASSETS_DIR = join(REPO_ROOT, "assets");
export const MODELS_DIR = join(ASSETS_DIR, "models");
export const WORLD_FILE = join(ASSETS_DIR, "world", "world.json");
export const PLAYER_DATA_DIR = join(REPO_ROOT, "data", "players");
