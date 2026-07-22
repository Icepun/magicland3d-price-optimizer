"use client";
/**
 * 3D Katman İzleyici — modeli döndür, katman kaydırıcısıyla inşayı izle, oynat tuşuyla
 * baskıyı simüle et. Geometri Web Worker'da hazırlanır (arayüz donmaz), IDB'den anında döner.
 */
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, Play, Pause, Layers, Box, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedGcode } from "@/lib/gcode-viz/parse-gcode";
import { loadGeometry } from "@/lib/gcode-viz/viz-pipeline";
import { buildVizScene, type VizScene } from "@/lib/gcode-viz/three-scene";
import { usePrefersReducedMotion } from "@/lib/client-state";

export function GcodeViewerDialog({
  fileId, cacheKey, name, onClose,
}: {
  fileId: string; cacheKey: string; name: string; onClose: () => void;
}) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [geom, setGeom] = useState<ParsedGcode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [layer, setLayer] = useState(-1); // -1 = tamamı
  const [playing, setPlaying] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  const vizRef = useRef<VizScene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const layerRef = useRef(-1);
  const playRef = useRef(false);

  // Geometri yükle
  useEffect(() => {
    let alive = true;
    loadGeometry(cacheKey, fileId)
      .then((g) => { if (alive) { if (g.totalSegments > 0) setGeom(g); else setError("Bu dosyadan çizim çıkarılamadı"); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Dosya işlenemedi"); });
    return () => { alive = false; };
  }, [cacheKey, fileId]);

  // three kurulumu
  useEffect(() => {
    if (!geom || !mountRef.current) return;
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    mount.appendChild(renderer.domElement);
    const viz = buildVizScene(geom, { background: null });
    const controls = new OrbitControls(viz.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, Math.max(5, (geom.bounds.maxZ - geom.bounds.minZ) * 0.32), 0);

    vizRef.current = viz;
    rendererRef.current = renderer;
    controlsRef.current = controls;

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      viz.camera.aspect = w / h;
      viz.camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    let lastStep = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // Oynatma: ~28ms'de bir katman ilerlet (uzun modellerde hız katmana ölçeklenir)
      if (playRef.current && viz.layerCount > 1 && t - lastStep > Math.max(16, 2200 / viz.layerCount)) {
        lastStep = t;
        const next = layerRef.current < 0 ? 0 : layerRef.current + 1;
        if (next >= viz.layerCount) {
          playRef.current = false;
          setPlaying(false);
          layerRef.current = -1;
          setLayer(-1);
          viz.setLayer(-1);
        } else {
          layerRef.current = next;
          setLayer(next);
          viz.setLayer(next);
        }
      }
      controls.update();
      renderer.render(viz.scene, viz.camera);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      viz.dispose();
      renderer.dispose();
      try { mount.removeChild(renderer.domElement); } catch { /* zaten kalkmış */ }
      vizRef.current = null; rendererRef.current = null; controlsRef.current = null;
    };
  }, [geom]);

  const applyLayer = (v: number) => {
    layerRef.current = v;
    setLayer(v);
    vizRef.current?.setLayer(v);
  };

  const togglePlay = () => {
    if (!vizRef.current) return;
    if (reduceMotion) { applyLayer(-1); return; } // hareket azalt: animasyon yerine tam model
    const next = !playing;
    if (next && (layer < 0 || layer >= (vizRef.current.layerCount - 1))) applyLayer(0);
    playRef.current = next;
    setPlaying(next);
  };

  const layerCount = geom?.layerRanges.length ?? 0;
  const shownLayer = layer < 0 ? layerCount : layer + 1;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 min-w-0">
            <Box className="h-4 w-4 text-primary shrink-0" />
            <span className="truncate">3D Önizleme — {name}</span>
          </DialogTitle>
        </DialogHeader>

        <div
          ref={mountRef}
          className="relative w-full h-[380px] rounded-xl border bg-[radial-gradient(ellipse_at_center,rgba(90,110,180,0.10),transparent_70%)] overflow-hidden"
        >
          {!geom && !error && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
              <p className="text-xs">Model hazırlanıyor…</p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          )}
        </div>

        {geom && layerCount > 0 && (
          <div className="flex items-center gap-3">
            <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={togglePlay} title={playing ? "Duraklat" : "İnşayı oynat"}>
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <input
              type="range"
              min={0}
              max={layerCount}
              value={layer < 0 ? layerCount : layer + 1}
              onChange={(e) => {
                const v = Number(e.target.value);
                playRef.current = false; setPlaying(false);
                applyLayer(v >= layerCount ? -1 : v - 1);
              }}
              className="flex-1 accent-[oklch(0.72_0.15_60)]"
            />
            <span className={cn("text-[11px] tabular-nums shrink-0 inline-flex items-center gap-1 text-muted-foreground")}>
              <Layers className="h-3.5 w-3.5" /> {shownLayer}/{layerCount}
            </span>
            {layer >= 0 && (
              <Button size="icon" variant="ghost" className="h-8 w-8 shrink-0" title="Tam modeli göster" onClick={() => { playRef.current = false; setPlaying(false); applyLayer(-1); }}>
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
