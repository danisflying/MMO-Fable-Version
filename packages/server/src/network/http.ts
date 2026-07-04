import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { ASSETS_DIR, MODELS_DIR } from "../paths";

const CONTENT_TYPES: Record<string, string> = {
  ".glb": "model/gltf-binary",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
};

/**
 * Serves /assets/** to the Vite-hosted client and editor (hence CORS *),
 * plus /assets/models/index.json listing available GLB models.
 */
export function createHttpServer(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    const url = (req.url ?? "/").split("?")[0];

    if (url === "/assets/models/index.json") {
      const models = existsSync(MODELS_DIR)
        ? readdirSync(MODELS_DIR)
            .filter((f) => f.endsWith(".glb"))
            .map((f) => f.slice(0, -4))
        : [];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models }));
      return;
    }

    if (url.startsWith("/assets/")) {
      const rel = decodeURIComponent(url.slice("/assets/".length));
      const filePath = normalize(join(ASSETS_DIR, rel));
      if (!filePath.startsWith(ASSETS_DIR)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(filePath) || !statSync(filePath).isFile()) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(res);
      return;
    }

    res.writeHead(404).end("not found");
  });
}
