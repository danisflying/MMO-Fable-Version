// Generates simple colored-box placeholder GLB models into assets/models.
// Hand-built GLB (glTF 2.0 binary) so no exporter dependency is needed.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "assets", "models");
mkdirSync(outDir, { recursive: true });

function buildBoxGlb({ size, color }) {
  const [sx, sy, sz] = size;
  const hx = sx / 2;
  const hz = sz / 2;
  // 24 vertices (4 per face) with per-face normals; base of the box sits at y=0.
  const faces = [
    { n: [0, 0, 1], verts: [[-hx, 0, hz], [hx, 0, hz], [hx, sy, hz], [-hx, sy, hz]] },
    { n: [0, 0, -1], verts: [[hx, 0, -hz], [-hx, 0, -hz], [-hx, sy, -hz], [hx, sy, -hz]] },
    { n: [1, 0, 0], verts: [[hx, 0, hz], [hx, 0, -hz], [hx, sy, -hz], [hx, sy, hz]] },
    { n: [-1, 0, 0], verts: [[-hx, 0, -hz], [-hx, 0, hz], [-hx, sy, hz], [-hx, sy, -hz]] },
    { n: [0, 1, 0], verts: [[-hx, sy, hz], [hx, sy, hz], [hx, sy, -hz], [-hx, sy, -hz]] },
    { n: [0, -1, 0], verts: [[-hx, 0, -hz], [hx, 0, -hz], [hx, 0, hz], [-hx, 0, hz]] },
  ];
  const positions = [];
  const normals = [];
  const indices = [];
  faces.forEach((face, fi) => {
    const base = fi * 4;
    for (const v of face.verts) positions.push(...v);
    for (let i = 0; i < 4; i++) normals.push(...face.n);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const idxBuf = Buffer.from(new Uint16Array(indices).buffer);
  const posBuf = Buffer.from(new Float32Array(positions).buffer);
  const nrmBuf = Buffer.from(new Float32Array(normals).buffer);
  const pad4 = (n) => (4 - (n % 4)) % 4;

  const idxPad = pad4(idxBuf.length);
  const posOffset = idxBuf.length + idxPad;
  const nrmOffset = posOffset + posBuf.length;
  const bin = Buffer.concat([idxBuf, Buffer.alloc(idxPad), posBuf, nrmBuf]);

  const min = [-hx, 0, -hz];
  const max = [hx, sy, hz];
  const gltf = {
    asset: { version: "2.0", generator: "mmo-gen-models" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 1, NORMAL: 2 }, indices: 0, material: 0 }] }],
    materials: [{
      pbrMetallicRoughness: { baseColorFactor: [...color, 1], metallicFactor: 0, roughnessFactor: 0.9 },
    }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: idxBuf.length, target: 34963 },
      { buffer: 0, byteOffset: posOffset, byteLength: posBuf.length, target: 34962 },
      { buffer: 0, byteOffset: nrmOffset, byteLength: nrmBuf.length, target: 34962 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5123, count: indices.length, type: "SCALAR" },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3", min, max },
      { bufferView: 2, componentType: 5126, count: 24, type: "VEC3" },
    ],
  };

  let jsonBuf = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonPad = pad4(jsonBuf.length);
  if (jsonPad) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binPad = pad4(bin.length);
  const binChunk = binPad ? Buffer.concat([bin, Buffer.alloc(binPad)]) : bin;

  const totalLength = 12 + 8 + jsonBuf.length + 8 + binChunk.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(totalLength, 8);
  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonBuf.length, 0);
  jsonHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(0x004e4942, 4); // 'BIN'

  return Buffer.concat([header, jsonHeader, jsonBuf, binHeader, binChunk]);
}

const models = {
  player: { size: [0.8, 1.7, 0.8], color: [0.23, 0.51, 0.96] },
  goblin: { size: [0.8, 1.3, 0.8], color: [0.86, 0.2, 0.2] },
  tree: { size: [1.6, 4.0, 1.6], color: [0.13, 0.55, 0.13] },
  rock: { size: [1.6, 1.0, 1.8], color: [0.5, 0.5, 0.52] },
};

for (const [name, spec] of Object.entries(models)) {
  const glb = buildBoxGlb(spec);
  writeFileSync(join(outDir, `${name}.glb`), glb);
  console.log(`wrote assets/models/${name}.glb (${glb.length} bytes)`);
}
