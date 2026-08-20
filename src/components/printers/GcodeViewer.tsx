"use client";
/**
 * 3D Katman İzleyici — modeli döndür, katman kaydırıcısıyla inşayı izle, oynat tuşuyla
 * baskıyı simüle et. Geometri Web Worker'da hazırlanır (arayüz donmaz).
 *
 * İKİ YENİ YETENEK:
 *  • CANLI KİLİT: `liveLayer` verilirse görünüm yazıcının bastığı katmana kilitlenir ve her
 *    güncellemede onu takip eder. Kullanıcı kaydırıcıya dokununca takip bırakılır; "Canlıya dön"
 *    geri alır.
 *  • BELİRLİ İLERLEME: açılış artık dönen çarkla belirsiz beklemiyor; getirme/çıkarma/hazırlama
 *    aşamaları yüzdeyle gösterilir.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Play, Pause, Layers, Box, RotateCcw, Radio, Eye, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ParsedGcode } from "@/lib/gcode-viz/parse-gcode";
import { loadGeometry, type VizProgress } from "@/lib/gcode-viz/viz-pipeline";
import { buildVizScene, type VizScene } from "@/lib/gcode-viz/three-scene";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { MeshViewerDialog } from "./MeshViewer";

export interface GcodeViewerProps {
  fileId: string;
  cacheKey: string;
  name: string;
  onClose: () => void;
  /**
   * Yazıcının şu an bastığı katman (1'den başlar — Moonraker `current_layer` ile aynı).
   * Verilirse izleyici bu katmana kilitli açılır ve güncellendikçe takip eder.
   */
  liveLayer?: number | null;
  /** Kafa başına gerçek filament rengi ("#RRGGBB"). Verilmezse dosyadaki renkler kullanılır. */
  toolColors?: (string | null | undefined)[];
}

const STAGE_LABEL: Record<VizProgress["stage"], string> = {
  fetch: "Model getiriliyor",
  scan: "Model çıkarılıyor",
  decode: "Model hazırlanıyor",
};

/** Aşamaları tek bir 0-1 çubuğuna indir (geriye gitmez). */
function overallFraction(p: VizProgress): number {
  if (p.stage === "decode") return 0.8 + 0.2 * p.fraction;
  if (p.stage === "scan") return 0.05 + 0.75 * p.fraction;
  return 0.05 + 0.7 * p.fraction;
}

function YolIzleyiciDialog({
  fileId, cacheKey, name, onClose, liveLayer, toolColors,
}: GcodeViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [geom, setGeom] = useState<ParsedGcode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ label: string; pct: number }>({ label: "Model getiriliyor", pct: 2 });
  const [layer, setLayer] = useState(-1); // -1 = tamamı
  const [playing, setPlaying] = useState(false);
  const [following, setFollowing] = useState(liveLayer != null);
  /**
   * Dolgu/destek/etek görünür mü — VARSAYILAN KAPALI.
   * Açıkken bu parçalar saydam çizilip arkalarındaki gövdeyi siliyordu; hatlar belirsizleşiyordu.
   */
  const [showSupport, setShowSupport] = useState(false);
  const reduceMotion = usePrefersReducedMotion();

  const vizRef = useRef<VizScene | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const layerRef = useRef(-1);
  const playRef = useRef(false);

  // Renk dizisi her render'da yeni bir referans olabilir; sahneyi boşuna yeniden kurmamak için
  // içeriğinden türetilmiş KARARLI bir kopya kullanılır.
  const toolKey = useMemo(() => (toolColors ?? []).map((c) => c ?? "").join("|"), [toolColors]);
  const stableColors = useMemo(
    () => (toolKey ? toolKey.split("|").map((c) => c || null) : undefined),
    [toolKey],
  );

  const layerCount = geom?.layerRanges.length ?? 0;
  /** Yazıcının 1-tabanlı katman numarasını dizinin 0-tabanlı indeksine çevir. */
  const liveIdx = useMemo(() => {
    if (liveLayer == null || !Number.isFinite(liveLayer) || layerCount === 0) return null;
    return Math.max(0, Math.min(layerCount - 1, Math.round(liveLayer) - 1));
  }, [liveLayer, layerCount]);

  // Geometri yükle (belirli ilerlemeyle)
  // Yeni dosya → ilerleme SIFIRLANIR. Yüzde geri gitmiyor (aşamalar sırayla ilerlesin diye);
  // aynı pencere başka bir dosya için yeniden kullanılırsa (cacheKey değişir, bileşen unmount
  // OLMAZ) önceki dosyanın 100 değeri kalıyor, çubuk "Hazır · %100"de donuyor ve kullanıcı model
  // indirilirken bitmiş sanıyordu. Sıfırlama RENDER sırasında yapılır — React'in "prop değişince
  // durumu ayarla" deseni.
  const loadKey = `${cacheKey}|${fileId}`;
  const [activeKey, setActiveKey] = useState(loadKey);
  if (activeKey !== loadKey) {
    setActiveKey(loadKey);
    setProgress({ label: "Model getiriliyor", pct: 2 });
    setGeom(null);
    setError(null);
  }

  useEffect(() => {
    let alive = true;
    loadGeometry(cacheKey, fileId, (p) => {
      if (!alive) return;
      setError(null); // yeni dosya yükleniyor → önceki hatayı temizle
      const pct = Math.round(overallFraction(p) * 100);
      // Geri gitme kilidi güncelleyici içinde: yüzde yalnız ARTARAK ilerler, etiket her zaman
      // güncellenir.
      setProgress((s) => (pct <= s.pct ? { ...s, label: STAGE_LABEL[p.stage] } : { label: STAGE_LABEL[p.stage], pct }));
    })
      .then((g) => {
        if (!alive) return;
        if (g.totalSegments > 0) { setProgress({ label: "Hazır", pct: 100 }); setGeom(g); }
        else setError("Bu dosyadan çizim çıkarılamadı");
      })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : "Dosya işlenemedi"); });
    return () => { alive = false; };
  }, [cacheKey, fileId]);

  const applyLayer = useCallback((v: number) => {
    layerRef.current = v;
    setLayer(v);
    vizRef.current?.setLayer(v);
  }, []);

  // three kurulumu
  useEffect(() => {
    if (!geom || !mountRef.current) return;
    const mount = mountRef.current;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    mount.appendChild(renderer.domElement);
    // Palet ayrı bir etkide uygulanır (aşağıda) — renkler sonradan gelse bile sahne yeniden kurulmaz.
    const viz = buildVizScene(geom, { background: null, mode: "viewer" });
    const controls = new OrbitControls(viz.camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.target.set(0, Math.max(5, (geom.bounds.maxZ - geom.bounds.minZ) * 0.32), 0);

    vizRef.current = viz;
    rendererRef.current = renderer;
    controlsRef.current = controls;
    viz.setLayer(layerRef.current);

    const resize = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      viz.camera.aspect = w / h;
      viz.camera.updateProjectionMatrix();
      // Kalın çizgi materyali kalınlığı çözünürlükle hesaplar — güncellenmezse çizgiler
      // yeniden boyutlandırmadan sonra yanlış kalınlıkta kalır.
      const dpr = renderer.getPixelRatio();
      viz.setResolution(w * dpr, h * dpr);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    let raf = 0;
    let lastStep = 0;
    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
      // Oynatma: uzun modellerde hız katman sayısına ölçeklenir
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
      /**
       * BOŞTA ÇİZME. `OrbitControls.update()` kamera hâlâ hareket ediyorsa (sönümleme dahil)
       * true döner; sahne değişikliklerini de sahnenin kendi bayrağı bildiriyor. İkisi de
       * yoksa çizilecek YENİ bir şey yok — eskiden birebir aynı kare saniyede 60 kez
       * çiziliyordu. Electron'da `backgroundThrottling: false` olduğu için pencere tepsiye
       * alınsa bile bu devam ediyordu; tarayıcının doğal freni burada yok.
       */
      const hareket = controls.update();
      if (hareket || viz.kirliMi()) renderer.render(viz.scene, viz.camera);
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

  // Gerçek filament renkleri (varsa, sonradan da gelebilir) — sahneyi yeniden kurmadan uygula.
  useEffect(() => {
    if (!stableColors?.length) return;
    vizRef.current?.setPalette({ toolColors: stableColors });
  }, [stableColors, geom]);

  // Görünürlük anahtarı sahneyi YENİDEN KURMAZ (WebGL bağlamı pahalı) — yalnız renk
  // tamponunu ve derinlik yazımını tazeler, geçiş anlık olur.
  useEffect(() => {
    vizRef.current?.setShowSupport(showSupport);
  }, [showSupport, geom]);

  // CANLI KİLİT: takip açıkken yazıcının katmanına yapış.
  useEffect(() => {
    if (!following || liveIdx == null || !vizRef.current) return;
    playRef.current = false;
    setPlaying(false);
    applyLayer(liveIdx);
  }, [following, liveIdx, geom, applyLayer]);

  const leaveFollow = () => {
    if (following) setFollowing(false);
    playRef.current = false;
    setPlaying(false);
  };

  const togglePlay = () => {
    if (!vizRef.current) return;
    leaveFollow();
    if (reduceMotion) { applyLayer(-1); return; } // hareket azalt: animasyon yerine tam model
    const next = !playing;
    if (next && (layer < 0 || layer >= (vizRef.current.layerCount - 1))) applyLayer(0);
    playRef.current = next;
    setPlaying(next);
  };

  const shownLayer = layer < 0 ? layerCount : layer + 1;
  const shownZ = layer >= 0 ? geom?.layerRanges[layer]?.z : geom?.bounds.maxZ;

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
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10">
              <div className="w-full max-w-[220px]">
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn("h-full rounded-full bg-primary", !reduceMotion && "transition-[width] duration-300 ease-out")}
                    style={{ width: `${Math.max(2, progress.pct)}%` }}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground tabular-nums">
                {progress.label} · %{progress.pct}
              </p>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center px-6 text-center">
              <p className="text-xs text-muted-foreground">{error}</p>
            </div>
          )}
          {geom && following && liveIdx != null && (
            <div className="absolute left-3 top-3 inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-background/80 px-2.5 py-1 text-[11px] text-primary backdrop-blur">
              <Radio className={cn("h-3 w-3", !reduceMotion && "animate-pulse")} />
              Şu an burada
            </div>
          )}
          {/* Dolgu/destek/etek varsayılan olarak GİZLİ: çizildiklerinde saydamlıkları
              arkadaki gövdeyi siliyor ve model belirsizleşiyor. İsteyen açabilsin. */}
          {geom && (
            <button
              type="button"
              onClick={() => setShowSupport((v) => !v)}
              title={
                showSupport
                  ? "Dolgu ve desteği gizle — model hatları netleşir"
                  : "Dolgu ve desteği göster"
              }
              className={cn(
                "absolute right-3 top-3 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] backdrop-blur transition-colors",
                showSupport
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background/80 text-muted-foreground hover:text-foreground"
              )}
            >
              {showSupport ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              Dolgu ve destek
            </button>
          )}
        </div>

        {geom && layerCount > 0 && (
          <div className="flex items-center gap-3">
            <Button
              size="icon" variant="outline" className="h-8 w-8 shrink-0 transition-transform active:scale-90"
              onClick={togglePlay}
              title={playing ? "Duraklat" : "İnşayı oynat"}
            >
              {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>

            <div className="relative flex-1">
              <input
                type="range"
                min={0}
                max={layerCount}
                value={layer < 0 ? layerCount : layer + 1}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  leaveFollow();
                  applyLayer(v >= layerCount ? -1 : v - 1);
                }}
                className="w-full accent-[oklch(0.72_0.15_60)]"
              />
              {liveIdx != null && layerCount > 0 && (
                <span
                  aria-hidden
                  title="Yazıcının bastığı katman"
                  className={cn(
                    "pointer-events-none absolute top-0 h-2 w-0.5 -translate-x-1/2 rounded-full bg-primary",
                    !reduceMotion && "transition-[left] duration-500 ease-out",
                  )}
                  style={{ left: `${((liveIdx + 1) / layerCount) * 100}%` }}
                />
              )}
            </div>

            <span className="text-[11px] tabular-nums shrink-0 inline-flex items-center gap-1 text-muted-foreground">
              <Layers className="h-3.5 w-3.5" /> {shownLayer}/{layerCount}
              {shownZ != null && <span className="opacity-70">· {shownZ.toFixed(1)} mm</span>}
            </span>

            {liveIdx != null && !following && (
              <Button
                size="sm" variant="outline"
                className="h-8 shrink-0 gap-1 text-xs transition-transform active:scale-95"
                onClick={() => setFollowing(true)}
              >
                <Radio className="h-3.5 w-3.5" /> Canlıya dön
              </Button>
            )}
            {liveIdx == null && layer >= 0 && (
              <Button
                size="icon" variant="ghost" className="h-8 w-8 shrink-0 transition-transform active:scale-90"
                title="Tam modeli göster"
                onClick={() => { playRef.current = false; setPlaying(false); applyLayer(-1); }}
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * İZLEYİCİ SEÇİCİ — parçaya kaynak model bağlıysa GERÇEK MODELİ, yoksa baskı yollarını gösterir.
 *
 * Neden burada: izleyici dört ayrı yerden açılıyor ve hepsi yalnız `fileId` geçiyor. Seçim
 * burada yapılınca o dört çağrı yerinin hiçbirine dokunmak gerekmiyor.
 *
 * Yol çizen izleyici model ölçeğinde yüzey gösteremiyor (bir şerit 1 pikselden ince kalıyor,
 * tüm yüzey aynı açıyla ışık alıyor). Kaynak model varsa dilimleyicideki görüntünün aynısı
 * çizilir; yoksa eski davranış korunur.
 */
export function GcodeViewerDialog(props: GcodeViewerProps & { layerTotal?: number | null }) {
  const [meshVar, setMeshVar] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    // Burada senkron `setMeshVar(null)` YOK: React derleyicisi efekt içinde basamaklı render
    // uyarısı veriyor. Başlangıç değeri zaten null ve iletişim kutusu her açılışta yeniden
    // monte ediliyor, bayat değer kalmıyor.
    fetch(`/api/models/${props.fileId}/mesh?bilgi=1`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { var?: boolean } | null) => { if (alive) setMeshVar(!!j?.var); })
      .catch(() => { if (alive) setMeshVar(false); });
    return () => { alive = false; };
  }, [props.fileId]);

  // Karar gelene kadar yol izleyicisini kurma: iki sahne birden açılmasın (ikisi de WebGL
  // bağlamı alıyor ve tarayıcı bağlam sayısını sınırlıyor).
  if (meshVar === null) {
    return (
      <Dialog open onOpenChange={(a) => { if (!a) props.onClose(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Box className="h-4 w-4 text-primary" /> 3D Önizleme — {props.name}
            </DialogTitle>
          </DialogHeader>
          <div className="flex h-[420px] flex-col items-center justify-center gap-3 rounded-xl border bg-popover">
            <p className="text-sm text-muted-foreground">Model açılıyor…</p>
            <div className="relative h-1.5 w-44 overflow-hidden rounded-full bg-muted">
              <div
                className="absolute inset-y-0 h-full w-1/3 rounded-full bg-primary"
                style={{ animation: "indeterminate-bar 1.4s ease-in-out infinite" }}
              />
            </div>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  if (meshVar) {
    return (
      <MeshViewerDialog
        fileId={props.fileId}
        name={props.name}
        onClose={props.onClose}
        liveLayer={props.liveLayer}
        layerTotal={props.layerTotal}
        renk={props.toolColors?.find((c) => !!c) ?? null}
      />
    );
  }

  return <YolIzleyiciDialog {...props} />;
}
