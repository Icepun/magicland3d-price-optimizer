"use client";
/**
 * KAYNAK MODEL İZLEYİCİSİ — parçaya bağlı gerçek 3B model, dilimleyicideki gibi.
 *
 * Baskı dosyaları dilimlenmiş olduğu için içlerinde geometri yok; kullanıcı parçaya ayrı bir
 * STL / OBJ / proje .3mf bağladıysa burası devreye girer. Baskı ilerlemesi Z kırpmasıyla
 * gösterilir: model gerçekten alttan yukarı büyür.
 *
 * Model bağlı değilse bu bileşen hiç açılmaz — `GcodeViewerDialog` yol çizen eski izleyiciye düşer.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Box, Pause, Play, Radio, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { kaynakModeliYukle, type MeshIlerleme } from "@/lib/mesh-viz/mesh-load";
import { buildMeshSahne, meshKamerasi, type MeshSahne } from "@/lib/mesh-viz/mesh-scene";
import { usePrefersReducedMotion } from "@/lib/client-state";

export interface MeshViewerProps {
  fileId: string;
  name: string;
  onClose: () => void;
  /** Yazıcının bastığı katman (1'den başlar) ve toplam — verilirse canlı kilit açılır. */
  liveLayer?: number | null;
  layerTotal?: number | null;
  /** Filament rengi ("#RRGGBB") — modelin rengi buna göre ayarlanır. */
  renk?: string | null;
}

const ASAMA_ETIKET: Record<MeshIlerleme["asama"], string> = {
  indir: "Model getiriliyor",
  ayristir: "Model açılıyor",
  hazirla: "Model hazırlanıyor",
};

/** Aşamaları tek bir 0-100 çubuğuna indir (geriye gitmez). */
function toplamYuzde(p: MeshIlerleme): number {
  if (p.asama === "hazirla") return 90 + 10 * p.oran;
  if (p.asama === "ayristir") return 70 + 20 * p.oran;
  return 4 + 66 * p.oran;
}

export function MeshViewerDialog({ fileId, name, onClose, liveLayer, layerTotal, renk }: MeshViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const sahneRef = useRef<MeshSahne | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const kontrolRef = useRef<OrbitControls | null>(null);
  const kameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const oranRef = useRef(1);

  const [hazir, setHazir] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [ilerleme, setIlerleme] = useState({ etiket: "Model getiriliyor", yuzde: 3 });
  const [oran, setOran] = useState(1);
  const [oynuyor, setOynuyor] = useState(false);
  const [canliKilit, setCanliKilit] = useState(true);
  const [ucgen, setUcgen] = useState(0);
  const [yukseklikMm, setYukseklikMm] = useState(0);
  const azHareket = usePrefersReducedMotion();

  const canliOran =
    liveLayer != null && liveLayer > 0 && layerTotal != null && layerTotal > 0
      ? Math.max(0, Math.min(1, liveLayer / layerTotal))
      : null;

  const oranUygula = useCallback((v: number) => {
    oranRef.current = v;
    setOran(v);
    sahneRef.current?.ilerlemeAyarla(v);
  }, []);

  // ── Modeli getir ──────────────────────────────────────────────────────────
  const [geometri, setGeometri] = useState<THREE.BufferGeometry | null>(null);
  useEffect(() => {
    let alive = true;
    kaynakModeliYukle(fileId, (p) => {
      if (alive) setIlerleme({ etiket: ASAMA_ETIKET[p.asama], yuzde: toplamYuzde(p) });
    })
      .then((r) => {
        if (!alive) return;
        if (!r) { setHata("Kaynak model bulunamadı"); return; }
        setUcgen(r.ucgen);
        setYukseklikMm(r.olcu.z);
        setGeometri(r.geometri);
      })
      .catch((e) => { if (alive) setHata(e instanceof Error ? e.message : "Model açılamadı"); });
    return () => { alive = false; };
  }, [fileId]);

  // ── three kurulumu ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!geometri || !mountRef.current) return;
    const mount = mountRef.current;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    // ⚠️ Bu bayrak olmadan kırpma düzlemi SESSİZCE çalışmaz — ilerleme hiç görünmez.
    renderer.localClippingEnabled = true;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    mount.appendChild(renderer.domElement);

    const sahne = buildMeshSahne(geometri, { renk });
    const kamera = meshKamerasi(sahne.yaricap, mount.clientWidth || 1, mount.clientHeight || 1);
    const kontrol = new OrbitControls(kamera, renderer.domElement);
    kontrol.enableDamping = true;
    kontrol.dampingFactor = 0.08;
    kontrol.target.set(0, 0, 0);

    sahneRef.current = sahne;
    rendererRef.current = renderer;
    kontrolRef.current = kontrol;
    kameraRef.current = kamera;
    sahne.ilerlemeAyarla(oranRef.current);
    setHazir(true);

    const boyutla = () => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      kamera.aspect = w / h;
      kamera.updateProjectionMatrix();
    };
    boyutla();
    const ro = new ResizeObserver(boyutla);
    ro.observe(mount);

    let id = 0;
    const dongu = () => {
      id = requestAnimationFrame(dongu);
      /**
       * BOŞTA ÇİZME. `OrbitControls.update()` kamera hâlâ hareket ediyorsa true döner;
       * sahne değişikliklerini sahnenin kendi bayrağı bildiriyor. İkisi de yoksa birebir
       * aynı kareyi saniyede 60 kez çizmenin anlamı yok — üstelik Electron'da
       * `backgroundThrottling: false`, yani pencere tepsideyken bile duruyordu.
       */
      const hareket = kontrol.update();
      if (hareket || sahne.kirliMi()) renderer.render(sahne.sahne, kamera);
    };
    dongu();

    return () => {
      cancelAnimationFrame(id);
      ro.disconnect();
      kontrol.dispose();
      sahne.serbestBirak();
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
      sahneRef.current = null;
      rendererRef.current = null;
    };
    // ⚠️ `renk` BİLEREK bağımlılık DEĞİL: rengin değişmesi sahnenin yeniden kurulmasını
    // gerektirmiyor, aşağıdaki ayrı efekt onu yerinde uyguluyor. Bağımlılığa eklenirse
    // panelin tek bir boş yoklaması kamerayı sıfırlar ve bir WebGL bağlamı harcanır.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometri]);

  // Renk sahneye YERİNDE uygulanır (sahne kurulumundan bağımsız).
  useEffect(() => {
    sahneRef.current?.renkAyarla(renk);
  }, [renk]);

  /**
   * CANLI KİLİT türetilmiş değerdir, durum değil. Efekt içinde `setState` çağırmak React
   * derleyicisinde basamaklı render uyarısı veriyor; oran render sırasında hesaplanıp
   * sahneye yalnız yan etki olarak uygulanıyor.
   */
  const etkinOran = canliKilit && canliOran != null ? canliOran : oran;
  useEffect(() => {
    if (!hazir) return;
    oranRef.current = etkinOran;
    sahneRef.current?.ilerlemeAyarla(etkinOran);
  }, [etkinOran, hazir]);

  // ── Oynat ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!oynuyor || !hazir || azHareket) return;
    let id = 0;
    let son = performance.now();
    const adim = (t: number) => {
      const dt = (t - son) / 1000;
      son = t;
      const yeni = oranRef.current + dt * 0.22; // ~4,5 saniyede tam baskı
      if (yeni >= 1) { oranUygula(1); setOynuyor(false); return; }
      oranUygula(yeni);
      id = requestAnimationFrame(adim);
    };
    id = requestAnimationFrame(adim);
    return () => cancelAnimationFrame(id);
  }, [oynuyor, hazir, azHareket, oranUygula]);

  const yuzde = Math.round(oran * 100);

  return (
    <Dialog open onOpenChange={(a) => { if (!a) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Box className="h-4 w-4 text-primary" />
            3D Önizleme — {name}
          </DialogTitle>
        </DialogHeader>

        <div className="relative h-[420px] w-full overflow-hidden rounded-xl border bg-popover">
          <div ref={mountRef} className="absolute inset-0" />

          {!hazir && !hata && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-10">
              <p className="text-sm text-muted-foreground">{ilerleme.etiket}</p>
              <div className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted">
                <div
                  className={cn("h-full rounded-full bg-primary", !azHareket && "transition-[width] duration-300 ease-out")}
                  style={{ width: `${Math.max(3, Math.round(ilerleme.yuzde))}%` }}
                />
              </div>
              <p className="text-xs tabular-nums text-muted-foreground">%{Math.round(ilerleme.yuzde)}</p>
            </div>
          )}

          {hata && (
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="text-sm text-muted-foreground">{hata}</p>
            </div>
          )}

          {hazir && ucgen > 0 && (
            <div className="pointer-events-none absolute right-3 top-3 rounded-full border bg-background/70 px-2.5 py-1 text-[11px] tabular-nums text-muted-foreground backdrop-blur">
              {Math.round(yukseklikMm)} mm
            </div>
          )}
        </div>

        <div className="flex items-center gap-3">
          <Button
            size="icon"
            variant="outline"
            className="h-9 w-9 shrink-0"
            disabled={!hazir}
            onClick={() => {
              setCanliKilit(false);
              // Hareket azaltma isteğinde animasyon yerine doğrudan tam modele geç.
              if (azHareket) { oranUygula(1); return; }
              if (!oynuyor) oranUygula(0);
              setOynuyor((o) => !o);
            }}
            aria-label={oynuyor ? "Duraklat" : "Baskıyı oynat"}
          >
            {oynuyor ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>

          <input
            type="range"
            min={0}
            max={1000}
            value={Math.round(oran * 1000)}
            disabled={!hazir}
            onChange={(e) => { setCanliKilit(false); setOynuyor(false); oranUygula(Number(e.target.value) / 1000); }}
            className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary"
            aria-label="Baskı ilerlemesi"
          />

          <span className="w-12 shrink-0 text-right text-xs tabular-nums text-muted-foreground">%{yuzde}</span>

          {canliOran != null && !canliKilit && (
            <Button size="sm" variant="outline" className="h-9 shrink-0 gap-1.5" onClick={() => { setOynuyor(false); setCanliKilit(true); }}>
              <Radio className="h-3.5 w-3.5" /> Canlıya dön
            </Button>
          )}
          {hazir && (
            <Button
              size="icon"
              variant="ghost"
              className="h-9 w-9 shrink-0"
              onClick={() => {
                const k = kameraRef.current, s = sahneRef.current, c = kontrolRef.current;
                if (!k || !s || !c) return;
                const y = meshKamerasi(s.yaricap, 1, 1);
                k.position.copy(y.position);
                c.target.set(0, 0, 0);
                c.update();
              }}
              aria-label="Görünümü sıfırla"
            >
              <RotateCcw className="h-4 w-4" />
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
