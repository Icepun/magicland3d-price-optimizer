"use client";

/**
 * 3B ÖNİZLEME KARŞILAŞTIRMA LABORATUVARI — ürüne DAHİL DEĞİL.
 *
 * Kullanıcı "hub'a entegre etmeden önce aynı modeli yan yana kıyaslayacak şekilde göster" dedi.
 * Bu sayfa hiçbir menüde bağlı değil; yalnız /viz-lab adresinden açılır ve şipşak kaldırılabilir.
 *
 * Aynı model dosyası altı farklı yaklaşımla çizilir:
 *   1. KAYITLI      — bugün kartlarda görünen, veritabanına bir kez yazılmış görüntü (bayat).
 *   2. KART 240     — bugünkü kodun bugünkü ayarla ürettiği kare (kartların kullandığı boyut).
 *   3. KART 512     — aynı çizim, yüksek çözünürlük (yalnız çözünürlüğün etkisi).
 *   4. DOLGU KATI   — dolgu da katı çizilir (Plan B). Model içi boş kabuk gibi durmaz.
 *   5. CANLI 3B     — gerçek WebGL, cihaz çözünürlüğünde, döndürülebilir (Plan C).
 *   6. SLICER       — OrcaSlicer'ın dosyaya GÖMDÜĞÜ kendi render'ı, 800×800 (Plan D).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Loader2, RotateCcw } from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { loadGeometry } from "@/lib/gcode-viz/viz-pipeline";
import { vizKeyForModel } from "@/lib/gcode-viz/viz-cache";
import { buildVizScene, type VizMode } from "@/lib/gcode-viz/three-scene";
import type { ParsedGcode } from "@/lib/gcode-viz/viz-pack";

interface ModelSecim {
  id: string;
  ad: string;
  urun: string;
  label?: string;
  originalName?: string;
  contentMd5?: string | null;
  sizeBytes?: number | null;
}

/** Tek seferlik offscreen render — laboratuvar için; ürün kodundaki paylaşımlı renderer'a dokunmaz. */
function offscreenRender(g: ParsedGcode, size: number, mode: VizMode): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  const viz = buildVizScene(g, { background: null, mode });
  try {
    viz.camera.aspect = 1;
    viz.camera.updateProjectionMatrix();
    viz.setResolution(size, size);
    viz.setLayer(-1);
    renderer.render(viz.scene, viz.camera);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  } finally {
    viz.dispose();
    renderer.dispose();
  }
}

/** Canlı, döndürülebilir sahne (Plan C) — cihaz çözünürlüğünde çizer. */
function CanliSahne({ g, yukseklik = 320 }: { g: ParsedGcode | null; yukseklik?: number }) {
  const kutuRef = useRef<HTMLDivElement | null>(null);
  const sifirla = useRef<(() => void) | null>(null);

  useEffect(() => {
    const kutu = kutuRef.current;
    if (!kutu || !g) return;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    // ⚠️ Kartların bugünkü sorunu tam olarak bu satırın yokluğu: 240px raster 168px kutuda
    // büyütülüyordu. Canlı sahnede piksel oranı cihazdan gelir → her ekranda keskin.
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    const w = kutu.clientWidth || 320;
    renderer.setSize(w, yukseklik, false);
    renderer.domElement.style.width = "100%";
    renderer.domElement.style.height = `${yukseklik}px`;
    kutu.appendChild(renderer.domElement);

    const viz = buildVizScene(g, { background: null, mode: "viewer" });
    viz.camera.aspect = w / yukseklik;
    viz.camera.updateProjectionMatrix();
    viz.setResolution(w * renderer.getPixelRatio(), yukseklik * renderer.getPixelRatio());
    viz.setLayer(-1);

    const controls = new OrbitControls(viz.camera, renderer.domElement);
    controls.enableDamping = true;
    const baslangic = viz.camera.position.clone();
    sifirla.current = () => {
      viz.camera.position.copy(baslangic);
      controls.target.set(0, 0, 0);
      controls.update();
    };

    let calisiyor = true;
    const dongu = () => {
      if (!calisiyor) return;
      controls.update();
      renderer.render(viz.scene, viz.camera);
      requestAnimationFrame(dongu);
    };
    dongu();

    const olcuDegisti = () => {
      const yw = kutu.clientWidth || 320;
      renderer.setSize(yw, yukseklik, false);
      viz.camera.aspect = yw / yukseklik;
      viz.camera.updateProjectionMatrix();
      viz.setResolution(yw * renderer.getPixelRatio(), yukseklik * renderer.getPixelRatio());
    };
    const gozlemci = new ResizeObserver(olcuDegisti);
    gozlemci.observe(kutu);

    return () => {
      calisiyor = false;
      gozlemci.disconnect();
      controls.dispose();
      viz.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [g, yukseklik]);

  return (
    <div className="relative">
      <div ref={kutuRef} className="w-full overflow-hidden rounded-lg" style={{ height: yukseklik }} />
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-1 top-1 h-6 text-[10px]"
        onClick={() => sifirla.current?.()}
      >
        <RotateCcw className="h-3 w-3 mr-1" /> açıyı sıfırla
      </Button>
    </div>
  );
}

function Kutu({
  baslik,
  aciklama,
  children,
}: {
  baslik: string;
  aciklama: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border bg-muted/10 overflow-hidden flex flex-col">
      <div className="px-3 py-2 border-b bg-muted/20">
        <div className="text-xs font-semibold">{baslik}</div>
        <div className="text-[10px] text-muted-foreground leading-snug mt-0.5">{aciklama}</div>
      </div>
      <div
        className="flex-1 flex items-center justify-center p-2 min-h-[320px]"
        style={{ background: "radial-gradient(ellipse at 50% 38%, oklch(0.95 0.02 265 / 12%), transparent 72%)" }}
      >
        {children}
      </div>
    </div>
  );
}

export default function VizLabPage() {
  const [secili, setSecili] = useState<ModelSecim | null>(null);
  const [g, setG] = useState<ParsedGcode | null>(null);
  const [yukleniyor, setYukleniyor] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [gorseller, setGorseller] = useState<Record<string, string | null>>({});

  const { data: modelData } = useQuery<{ products?: { id: string; name: string; files?: ModelSecim[] }[] }>({
    queryKey: ["models"],
    queryFn: () => fetchJson("/api/models"),
    staleTime: 5 * 60_000,
  });

  const modeller = useMemo(() => {
    const liste: ModelSecim[] = [];
    for (const u of modelData?.products ?? []) {
      for (const f of u.files ?? []) liste.push({ ...f, urun: u.name, ad: f.label ?? f.originalName ?? f.id });
    }
    return liste.slice(0, 300);
  }, [modelData]);

  const { data: slicerOnizleme } = useQuery<{ dataUrl: string; genislik: number; yukseklik: number }>({
    queryKey: ["slicer-preview", secili?.id],
    queryFn: () => fetchJson(`/api/models/${secili?.id}/slicer-preview`),
    enabled: !!secili?.id,
    retry: false,
  });

  const { data: kayitli } = useQuery<{ thumbnail?: string } | null>({
    queryKey: ["kayitli-onizleme", secili?.id],
    queryFn: async () => {
      const r = await fetch(`/api/models/${secili?.id}/preview`);
      if (!r.ok) return null;
      const b = await r.blob();
      return { thumbnail: await new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.readAsDataURL(b);
      }) };
    },
    enabled: !!secili?.id,
    retry: false,
  });

  const yukle = useCallback(async (m: ModelSecim) => {
    setSecili(m);
    setG(null);
    setGorseller({});
    setHata(null);
    setYukleniyor(true);
    try {
      const geom = await loadGeometry(vizKeyForModel(m), m.id);
      setG(geom);
      // Sırayla çiz — hepsi aynı anda GPU'ya yüklenirse tarayıcı bağlam kaybedebilir.
      const uretilecek: [string, number, VizMode][] = [
        ["kart240", 240, "card"],
        ["kart512", 512, "card"],
        ["dolgu512", 512, "viewer"],
      ];
      for (const [anahtar, boy, mod] of uretilecek) {
        const url = offscreenRender(geom, boy, mod);
        setGorseller((o) => ({ ...o, [anahtar]: url }));
        await new Promise((r) => setTimeout(r, 30));
      }
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Model yüklenemedi");
    } finally {
      setYukleniyor(false);
    }
  }, []);

  return (
    <div className="p-6 space-y-4 mx-auto w-full max-w-[1600px]">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">3B Önizleme — Karşılaştırma</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Aynı model, altı farklı yaklaşımla. Bu sayfa uygulamaya dahil değil; yalnız kıyaslamak için.
        </p>
      </div>

      <Card>
        <CardContent className="p-3">
          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="h-9 rounded-md border bg-background px-3 text-sm min-w-[420px]"
              value={secili?.id ?? ""}
              onChange={(e) => {
                const m = modeller.find((x) => x.id === e.target.value);
                if (m) void yukle(m);
              }}
            >
              <option value="">Model seç…</option>
              {modeller.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.urun} — {m.ad}
                </option>
              ))}
            </select>
            {yukleniyor && (
              <span className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> model okunuyor ve çiziliyor…
              </span>
            )}
            {hata && <span className="text-xs text-destructive">{hata}</span>}
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Kutu
          baslik="1 · ŞU AN GÖRDÜĞÜN (kayıtlı)"
          aciklama="Veritabanına bir kez yazılmış görüntü. Render sürümü olmadığı için hiç yenilenmiyor."
        >
          {kayitli?.thumbnail ? (
            <img src={kayitli.thumbnail} alt="" className="max-h-[300px] object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">kayıtlı görüntü yok</span>
          )}
        </Kutu>

        <Kutu
          baslik="2 · BUGÜNKÜ KOD · kart · 240px"
          aciklama="Kartların bugün kullandığı boyut. Fark 1 ile 2 arasındaysa sorun bayatlıktır."
        >
          {gorseller.kart240 ? (
            <img src={gorseller.kart240} alt="" style={{ width: 240, height: 240 }} className="object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </Kutu>

        <Kutu baslik="3 · BUGÜNKÜ KOD · kart · 512px" aciklama="Aynı çizim, yüksek çözünürlük. Yalnız çözünürlüğün katkısı.">
          {gorseller.kart512 ? (
            <img src={gorseller.kart512} alt="" className="max-h-[300px] object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </Kutu>

        <Kutu
          baslik="4 · DOLGU KATI · 512px (Plan B)"
          aciklama="Dolgu da katı çiziliyor — model içi boş kabuk gibi durmuyor."
        >
          {gorseller.dolgu512 ? (
            <img src={gorseller.dolgu512} alt="" className="max-h-[300px] object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </Kutu>

        <Kutu
          baslik="5 · CANLI 3B (Plan C)"
          aciklama="Gerçek WebGL, cihaz çözünürlüğünde. Fareyle döndür — kayıtlı görüntü yok, bayatlama yok."
        >
          {g ? <CanliSahne g={g} /> : <span className="text-xs text-muted-foreground">model seç</span>}
        </Kutu>

        <Kutu
          baslik="6 · SLICER'IN KENDİ GÖRSELİ (Plan D)"
          aciklama={
            slicerOnizleme
              ? `OrcaSlicer'ın dosyaya gömdüğü render — ${slicerOnizleme.genislik}×${slicerOnizleme.yukseklik}`
              : "Dosyaya gömülü slicer render'ı"
          }
        >
          {slicerOnizleme?.dataUrl ? (
            <img src={slicerOnizleme.dataUrl} alt="" className="max-h-[300px] object-contain" />
          ) : (
            <span className="text-xs text-muted-foreground">bu dosyada gömülü önizleme yok</span>
          )}
        </Kutu>
      </div>
    </div>
  );
}
