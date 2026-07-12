"use client";
/**
 * three.js sahne yapı taşları — izleyici dialogu, thumbnail ve inşa-karesi (sprite) üretimi
 * AYNI sahneyi paylaşır. Çizgi tabanlı (LineSegments) gösterim: 900k segmenti bile akıcı çizer;
 * katman ilerletme = drawRange (yeniden geometri üretmeden anlık).
 */
import * as THREE from "three";
import type { ParsedGcode } from "./parse-gcode";
import { FEATURE_OUTER, FEATURE_INNER, FEATURE_INFILL, FEATURE_SUPPORT } from "./parse-gcode";

/** Özellik renkleri (koyu zeminde canlı, aydınlıkta okunur). */
const FEATURE_COLORS: Record<number, [number, number, number]> = {
  [FEATURE_OUTER]: [1.0, 0.52, 0.24], // dış duvar — turuncu (model silueti)
  [FEATURE_INNER]: [0.95, 0.72, 0.25], // iç duvar — amber
  [FEATURE_INFILL]: [0.34, 0.45, 0.95], // dolgu — mavi (geri planda)
  [FEATURE_SUPPORT]: [0.45, 0.48, 0.55], // destek — gri
};
const FEATURE_DEFAULT: [number, number, number] = [0.62, 0.65, 0.72];

export interface VizScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  lines: THREE.LineSegments;
  geometry: THREE.BufferGeometry;
  /** Katman i'ye kadar (dahil) çiz — -1 = hepsi. */
  setLayer: (layerIdx: number) => void;
  layerCount: number;
  dispose: () => void;
}

export function buildVizScene(g: ParsedGcode, opts?: { background?: number | null }): VizScene {
  const scene = new THREE.Scene();
  if (opts?.background != null) scene.background = new THREE.Color(opts.background);

  const segCount = g.totalSegments;
  const colors = new Float32Array(segCount * 6);
  for (let i = 0; i < segCount; i++) {
    const c = FEATURE_COLORS[g.features[i]] ?? FEATURE_DEFAULT;
    const o = i * 6;
    colors[o] = c[0]; colors[o + 1] = c[1]; colors[o + 2] = c[2];
    colors[o + 3] = c[0]; colors[o + 4] = c[1]; colors[o + 5] = c[2];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(g.positions, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const material = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.92 });
  const lines = new THREE.LineSegments(geometry, material);

  // GCode Z-yukarı → three Y-yukarı; modeli merkeze taşı.
  const { minX, maxX, minY, maxY, minZ } = g.bounds;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const group = new THREE.Group();
  lines.position.set(-cx, -cy, -minZ);
  group.add(lines);
  group.rotation.x = -Math.PI / 2;
  scene.add(group);

  // Tabla ızgarası (hafif)
  const spanX = Math.max(10, maxX - minX), spanY = Math.max(10, maxY - minY);
  const gridSize = Math.ceil(Math.max(spanX, spanY) * 1.35 / 10) * 10;
  const grid = new THREE.GridHelper(gridSize, Math.max(6, Math.round(gridSize / 10)), 0x475069, 0x2a3042);
  (grid.material as THREE.Material).transparent = true;
  (grid.material as THREE.Material).opacity = 0.35;
  scene.add(grid);

  // Kamera: izometrik açıyla sığdır
  const spanZ = Math.max(5, g.bounds.maxZ - minZ);
  const radius = Math.max(spanX, spanY, spanZ) * 0.72;
  const camera = new THREE.PerspectiveCamera(38, 1, 0.5, radius * 20);
  camera.position.set(radius * 1.5, radius * 1.25, radius * 1.5);
  camera.lookAt(0, spanZ * 0.32, 0);

  const setLayer = (layerIdx: number) => {
    if (layerIdx < 0 || layerIdx >= g.layerRanges.length) {
      geometry.setDrawRange(0, segCount * 2);
    } else {
      geometry.setDrawRange(0, g.layerRanges[layerIdx].end * 2); // segment → 2 vertex
    }
  };

  return {
    scene, camera, lines, geometry, setLayer,
    layerCount: g.layerRanges.length,
    dispose: () => { geometry.dispose(); material.dispose(); (grid.material as THREE.Material).dispose(); grid.geometry.dispose(); },
  };
}

// PAYLAŞILAN offscreen renderer — her çağrıda yeni WebGL context YARATMAK pahalıdır ve tarayıcı
// context sayısını (~16) sınırlar; çok dosyada context tükenir. Üretim zaten SERİ (tek seferde bir
// iş) olduğundan tek renderer güvenle yeniden kullanılır.
let sharedRenderer: THREE.WebGLRenderer | null = null;
let sharedCanvas: HTMLCanvasElement | null = null;
function getSharedRenderer(size: number): THREE.WebGLRenderer | null {
  try {
    if (!sharedRenderer) {
      sharedCanvas = document.createElement("canvas");
      sharedRenderer = new THREE.WebGLRenderer({ canvas: sharedCanvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
      sharedRenderer.setClearColor(0x000000, 0);
    }
    sharedCanvas!.width = size; sharedCanvas!.height = size;
    sharedRenderer.setSize(size, size, false);
    return sharedRenderer;
  } catch {
    return null; // WebGL yoksa görselsiz devam
  }
}

/** Offscreen tek kare (thumbnail) — PNG data URL. Paylaşılan renderer, sahne dispose edilir. */
export function renderThumbnail(g: ParsedGcode, size = 512): string | null {
  const renderer = getSharedRenderer(size);
  if (!renderer) return null;
  const viz = buildVizScene(g, { background: null });
  viz.camera.aspect = 1;
  viz.camera.updateProjectionMatrix();
  try {
    viz.setLayer(-1);
    renderer.render(viz.scene, viz.camera);
    return renderer.domElement.toDataURL("image/png");
  } finally {
    viz.dispose(); // renderer paylaşımlı — dispose ETME
  }
}

/** İnşa kareleri: N aşamada küçük WEBP kareleri — kartta canlı dolum için. Kareler arasında
 *  BOŞTA bekleyip (yield) arayüzü bloke etmez; paylaşılan renderer kullanır. */
export async function renderBuildFrames(
  g: ParsedGcode,
  frameCount = 24,
  size = 240,
  yieldFn?: () => Promise<void>,
): Promise<Blob[]> {
  const renderer = getSharedRenderer(size);
  if (!renderer) return [];
  const canvas = renderer.domElement as HTMLCanvasElement;
  const blobs: Blob[] = [];
  const viz = buildVizScene(g, { background: null });
  viz.camera.aspect = 1;
  viz.camera.updateProjectionMatrix();
  try {
    const layers = Math.max(1, viz.layerCount);
    for (let k = 1; k <= frameCount; k++) {
      const layerIdx = Math.min(layers - 1, Math.ceil((k / frameCount) * layers) - 1);
      viz.setLayer(layerIdx);
      renderer.render(viz.scene, viz.camera);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/webp", 0.8));
      if (!blob) return [];
      blobs.push(blob);
      if (yieldFn) await yieldFn(); // her kareden sonra arayüze nefes aldır
    }
    return blobs;
  } finally {
    viz.dispose();
  }
}
