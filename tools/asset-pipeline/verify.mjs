import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
for (const f of process.argv.slice(2)) {
  const d = await io.read(f);
  const tex = d.getRoot().listTextures();
  const embedded = tex.every((t) => t.getImage() && t.getImage().byteLength > 0);
  console.log(`${f.split('/').pop()}: meshes=${d.getRoot().listMeshes().length} textures=${tex.length} embedded=${embedded}`);
}
