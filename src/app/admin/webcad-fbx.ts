/**
 * WebCAD — FBX import. `parseFbxDataUrl` is the only export: turns a base64 data URL
 * (the embedded save format — see `SceneInstance.fbxData`'s own doc comment) back into
 * a THREE.Group, synchronously.
 */
import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';

const loader = new FBXLoader();

/** Decode a `data:...;base64,xxxx` URL into raw bytes. */
function decodeDataUrl(dataUrl: string): ArrayBuffer {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

/**
 * Parse an imported FBX file (as the base64 data URL it's embedded as, so a saved
 * scene stays a single self-contained JSON file — the same convention this app
 * already uses for a MaterialDef's JPG texture) back into a THREE.Group.
 * `FBXLoader.parse()` is synchronous once the full buffer is already in memory — no
 * network I/O needed, unlike `.load()`. External texture references (a relative path
 * to a separate .jpg/.png beside the original .fbx) can't resolve from an in-memory
 * buffer with no real file path and are silently skipped by FBXLoader itself; only
 * textures embedded IN the FBX (binary FBX with "embed media") carry over.
 */
export function parseFbxDataUrl(dataUrl: string): THREE.Group {
  return loader.parse(decodeDataUrl(dataUrl), '');
}
