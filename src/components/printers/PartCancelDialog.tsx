"use client";
/**
 * BOZULAN PARÇAYI ATLA — tabladaki tek bir parçanın baskısını iptal eder, diğerleri devam eder.
 *
 * ⚠️ GERİ ALINAMAZ SAYILIR. Geri alma yalnız BUNDAN SONRAKİ katmanları kurtarır; iptal
 * boyunca atlanan katmanlar geri gelmez. Bu yüzden tasarımın tamamı YANLIŞ PARÇA SEÇİMİNİ
 * önlemeye ayarlı:
 *
 *  • SEÇİM İSİMDEN DEĞİL YERDEN. Kopyaların adları birbirinin aynı olabiliyor
 *    (UNDERBODY.STL_ID_0/1/2_COPY_0). Ham ad ekranda HİÇ görünmez; parçalar tabladaki
 *    yerlerine göre numaralanır ve tepeden görünüşte tıklanır.
 *  • TIKLAMA = SEÇİM, İPTAL DEĞİL. İptal ayrı bir onaydan geçer; onayda seçilen parça
 *    vurgulu mini haritayla birlikte görünür, varsayılan odak "Vazgeç"tedir.
 *  • SON PARÇA KORUNUR. Klipper tüm nesneler dışlanınca baskıyı durdurmuyor — dosya sonuna
 *    kadar ısıtıcılar açık boşa çalışıyor. Tek parça kaldıysa iptal sunulmaz.
 *  • 3B (24 Eyl 2026): tepeden görünüşte yalnız kaba kutular vardı; üst üste binen kutularda
 *    hangi numaranın hangi parça olduğu anlaşılmıyordu. Dosya parçaları etiketlediyse harita
 *    3B'ye geçer (gerçek biçimler, üstüne gelince parlayan parça). Tepeden görünüş hazır olana
 *    dek ve 3B açılamazsa yedek olarak kalır.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Loader2, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cizimSirasi, parcalariSirala, poligonSvg, type Cerceve, type MappedPart, type PartPolygon,
} from "@/app/printers/part-map";
import type { ParsedGcode } from "@/lib/gcode-viz/viz-pack";

// three.js yalnız pencere 3B gösterecekse yüklenir.
const ParcaSecici3B = dynamic(() => import("./ParcaSecici3B").then((m) => m.ParcaSecici3B), { ssr: false });

export interface PartCancelDialogProps {
  printerId: string;
  /** Tabla çerçevesi (mm) — nozul noktasıyla AYNI kaynaktan gelir. */
  frame: Cerceve;
  /** Yazıcının o an bastığı parçanın HAM adı. */
  currentName: string | null;
  /** Zaten iptal edilmiş parçaların HAM adları. */
  excluded: string[];
  onClose: () => void;
  /** Parça listesini yazıcıdan çeker (poligonlar dahil). */
  fetchParts: () => Promise<PartPolygon[]>;
  /** İptal komutunu gönderir; hata fırlatırsa arayüz mesajı gösterir. */
  onExclude: (name: string) => Promise<void>;
  onUndo: (name: string) => Promise<void>;
  /** İptal geri alınabilir mi? Bambu'da atlanan parça bir daha basılmaz → düğme gösterilmez. */
  geriAlinabilir?: boolean;
  /** Basılan dosyanın 3B kaydı (kütüphanede varsa). Dosya parçaları etiketlediyse harita 3B olur. */
  model3d?: { fileId: string; cacheKey: string } | null;
  /** Basılan katman (paket indeksi) — 3B'de basılan kısım katı, kalanı taslak görünür. */
  katmanIdx?: number | null;
  toolColors?: (string | null)[];
  reduceMotion?: boolean;
}

export function PartCancelDialog({
  printerId, frame, currentName, excluded, onClose, fetchParts, onExclude, onUndo, geriAlinabilir = true,
  model3d, katmanIdx, toolColors, reduceMotion = false,
}: PartCancelDialogProps) {
  const [parts, setParts] = useState<MappedPart[] | null>(null);
  const [hata, setHata] = useState<string | null>(null);
  const [secili, setSecili] = useState<string | null>(null);
  const [onayda, setOnayda] = useState(false);
  const [calisiyor, setCalisiyor] = useState(false);
  const [sonIptal, setSonIptal] = useState<MappedPart | null>(null);
  const [geriAlindi, setGeriAlindi] = useState(false);
  // 3B: parça etiketli geometri gelince tepeden görünüşün yerine geçer.
  const [geom, setGeom] = useState<ParsedGcode | null>(null);
  const [ucHazir, setUcHazir] = useState(false);
  const [ucHata, setUcHata] = useState(false);
  const [uzerinde, setUzerinde] = useState<string | null>(null);
  const [listeUst, setListeUst] = useState<string | null>(null);
  const modelDosya = model3d?.fileId ?? null;
  const modelAnahtar = model3d?.cacheKey ?? null;

  useEffect(() => {
    if (!modelDosya || !modelAnahtar) return;
    let alive = true;
    import("@/lib/gcode-viz/viz-pipeline")
      .then((m) => m.loadGeometry(modelAnahtar, modelDosya))
      .then((g) => { if (alive && g.objects && g.objectKeys?.length) setGeom(g); })
      .catch(() => { /* 3B olmadan tepeden görünüşle devam */ });
    return () => { alive = false; };
  }, [modelDosya, modelAnahtar]);

  const ilerleme = useMemo(() => {
    if (!geom || katmanIdx == null || geom.layerRanges.length === 0) return null;
    return geom.layerRanges[Math.min(geom.layerRanges.length - 1, Math.max(0, katmanIdx))].end;
  }, [geom, katmanIdx]);

  useEffect(() => {
    let alive = true;
    fetchParts()
      .then((ham) => { if (alive) setParts(parcalariSirala(ham)); })
      // Sunucu parçanın neden olmadığını söyleyebiliyor (etiketsiz dosya vb.) — onu göster.
      .catch((e: unknown) => {
        if (alive) setHata(e instanceof Error && e.message ? e.message : "Parça listesi alınamadı.");
      });
    return () => { alive = false; };
  }, [fetchParts, printerId]);

  const kalan = useMemo(
    () => (parts ?? []).filter((p) => !excluded.includes(p.name)).length,
    [parts, excluded],
  );
  /** Son parçayı iptal etmek baskıyı bitirmez — yazıcı dosya sonuna kadar boşa koşar. */
  const sonParca = kalan <= 1;

  const seciliParca = useMemo(
    () => (parts ?? []).find((p) => p.name === secili) ?? null,
    [parts, secili],
  );

  const uygula = useCallback(async () => {
    if (!seciliParca) return;
    setCalisiyor(true);
    setHata(null);
    try {
      await onExclude(seciliParca.name);
      setSonIptal(seciliParca);
      setOnayda(false);
      setSecili(null);
      setGeriAlindi(false);
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Parça iptal edilemedi. Tekrar dene.");
      setOnayda(false);
    } finally {
      setCalisiyor(false);
    }
  }, [seciliParca, onExclude]);

  const geriAl = useCallback(async () => {
    if (!sonIptal) return;
    setCalisiyor(true);
    try {
      await onUndo(sonIptal.name);
      setGeriAlindi(true);
    } catch {
      setHata("Geri alınamadı.");
    } finally {
      setCalisiyor(false);
    }
  }, [sonIptal, onUndo]);

  const iptalEdilmis = (p: MappedPart) => excluded.includes(p.name) || sonIptal?.name === p.name;
  const parcaSec = useCallback((ad: string) => { setSecili(ad); setOnayda(false); }, []);
  const iptaller = useMemo(
    () => (sonIptal && !excluded.includes(sonIptal.name) ? [...excluded, sonIptal.name] : excluded),
    [excluded, sonIptal],
  );
  const uc = !!geom && !ucHata && (parts?.length ?? 0) > 0;
  const ucGorunur = uc && ucHazir;

  return (
    <Dialog open onOpenChange={(o) => !o && !calisiyor && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Hangi parça bozuldu?</DialogTitle>
        </DialogHeader>

        {parts === null && !hata && (
          <div className="py-10 text-center">
            <Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" />
            <p className="text-xs text-muted-foreground mt-2">Parçalar okunuyor…</p>
          </div>
        )}

        {parts !== null && parts.length === 0 && (
          <div className="py-8 text-center space-y-1.5">
            <p className="text-sm">Bu baskıda parçalar ayrı ayrı işaretlenmemiş.</p>
            <p className="text-xs text-muted-foreground">
              Dilimleyicide &quot;Exclude objects&quot; seçeneğini açıp yeniden dilimle.
            </p>
          </div>
        )}

        {parts !== null && parts.length > 0 && (
          <div className="space-y-3">
            {/* TABLANIN TEPEDEN GÖRÜNÜŞÜ — büyük tıklama hedefleri, konumdan seçim. */}
            <div className="relative h-[380px] rounded-lg border bg-muted/20 overflow-hidden">
              <div className={cn("absolute inset-0", !reduceMotion && "transition-opacity duration-500", ucGorunur ? "pointer-events-none opacity-0" : "opacity-100")}>
              <svg viewBox="0 0 100 100" className="block w-full h-[380px]" preserveAspectRatio="xMidYMid meet">
                {/* Büyük parça ALTTA çizilir → küçük parça üstte ve tıklanabilir kalır. */}
                {cizimSirasi(parts).map((p) => {
                  const kapali = iptalEdilmis(p);
                  const sec = p.name === secili;
                  const basiliyor = p.name === currentName;
                  return (
                    <polygon
                      key={p.name}
                      points={poligonSvg(p.polygon, frame)}
                      className={cn(
                        "transition-[fill,stroke] duration-200",
                        kapali ? "pointer-events-none" : "cursor-pointer",
                      )}
                      fill={kapali ? "oklch(0.5 0 0 / 12%)" : sec ? "oklch(0.65 0.2 25 / 42%)" : "oklch(0.72 0.14 220 / 26%)"}
                      stroke={kapali ? "oklch(0.5 0 0 / 30%)" : sec ? "oklch(0.65 0.2 25)" : basiliyor ? "oklch(0.75 0.16 155)" : "oklch(0.72 0.14 220 / 70%)"}
                      strokeWidth={sec ? 1.4 : 0.7}
                      onClick={() => !kapali && parcaSec(p.name)}
                    />
                  );
                })}
                {parts.map((p) => {
                  const o = poligonSvg([p.center], frame).split(",");
                  return (
                    <text
                      key={`t-${p.name}`}
                      x={o[0]} y={o[1]}
                      textAnchor="middle" dominantBaseline="central"
                      fontSize="4.5" fontWeight="700"
                      fill={iptalEdilmis(p) ? "oklch(0.6 0 0)" : "oklch(0.98 0 0)"}
                      className="pointer-events-none select-none"
                    >
                      {p.no}
                    </text>
                  );
                })}
              </svg>
              </div>
              {uc && geom && parts && (
                <ParcaSecici3B
                  geom={geom}
                  parcalar={parts}
                  iptaller={iptaller}
                  secili={secili}
                  basilan={currentName}
                  disVurgu={listeUst}
                  ilerleme={ilerleme}
                  toolColors={toolColors}
                  reduceMotion={reduceMotion}
                  onSec={parcaSec}
                  onUzerinde={setUzerinde}
                  onHazir={() => setUcHazir(true)}
                  onHata={() => setUcHata(true)}
                />
              )}
            </div>
            <p className="text-xs text-muted-foreground text-center">
              {ucGorunur ? "Bozulan parçayı seç." : "Tablanın üstten görünüşü — bozulan parçayı seç."}
            </p>

            {/* Liste — haritanın yedeği; aynı numaralar, aynı durumlar. */}
            <div className="flex flex-wrap gap-1.5">
              {parts.map((p) => {
                const kapali = iptalEdilmis(p);
                return (
                  <button
                    key={p.name}
                    disabled={kapali}
                    onClick={() => parcaSec(p.name)}
                    onMouseEnter={() => setListeUst(p.name)}
                    onMouseLeave={() => setListeUst(null)}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors",
                      kapali && "opacity-45 line-through",
                      p.name === secili && "border-destructive/60 bg-destructive/10",
                      p.name === uzerinde && p.name !== secili && "border-[#3fd0ff]/60 bg-[#3fd0ff]/10",
                    )}
                  >
                    <span className="font-semibold tabular-nums">{p.no}. parça</span>
                    {p.name === currentName && !kapali && (
                      <span className="text-[10px] text-muted-foreground">şu an basılıyor</span>
                    )}
                    {kapali && <span className="text-[10px] text-muted-foreground">iptal edildi</span>}
                  </button>
                );
              })}
            </div>

            {sonParca && (
              <div className="flex items-start gap-2 rounded-lg border p-2.5" style={{ borderColor: "color-mix(in oklch, var(--panel-amber) 40%, var(--border))" }}>
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" style={{ color: "var(--panel-amber)" }} />
                <p className="text-xs">
                  Bu son parça. İptal etmek baskıyı bitirmez — yazıcı boşa çalışır.
                  Baskıyı tamamen durdurmak istiyorsan kartaki &quot;Baskıyı iptal et&quot; düğmesini kullan.
                </p>
              </div>
            )}

            {sonIptal && !geriAlindi && (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
                <p className="flex-1 text-xs">
                  {sonIptal.no}. parça iptal edildi. Yazıcı birkaç saniye içinde atlayacak.
                </p>
                {geriAlinabilir && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" disabled={calisiyor} onClick={geriAl}>
                    Geri al
                  </Button>
                )}
              </div>
            )}
            {geriAlindi && sonIptal && (
              <p className="text-xs text-muted-foreground">
                {sonIptal.no}. parça yeniden basılıyor — atlanan yerde iz kalabilir.
              </p>
            )}

            {/* ONAY (3B) — seçilen parça yukarıda kırmızı; varsayılan odak "Vazgeç". */}
            {onayda && seciliParca && ucGorunur && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/45 bg-destructive/10 p-2.5 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 duration-200">
                <p className="flex-1 text-xs">
                  <span className="font-semibold">{seciliParca.no}. parça</span> yarım kalacak, diğerleri basılmaya devam edecek.
                </p>
                <Button variant="outline" size="sm" className="h-7 text-xs" autoFocus onClick={() => setOnayda(false)}>Vazgeç</Button>
                <Button size="sm" variant="destructive" className="h-7 text-xs" disabled={calisiyor} onClick={uygula}>
                  {calisiyor ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Parça iptal ediliyor…</> : "Evet, iptal et"}
                </Button>
              </div>
            )}

            {hata && <p className="text-xs text-destructive">{hata}</p>}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={calisiyor}>Kapat</Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!secili || calisiyor || sonParca || (onayda && ucGorunur)}
            onClick={() => setOnayda(true)}
          >
            Parçayı iptal et
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* ONAY (tepeden görünüş) — seçilen parça mini haritada VURGULU; varsayılan odak "Vazgeç". */}
      {onayda && seciliParca && !ucGorunur && (
        <Dialog open onOpenChange={(o) => !o && setOnayda(false)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-base">{seciliParca.no}. parçayı iptal et?</DialogTitle>
            </DialogHeader>
            <div className="rounded-lg border bg-muted/20 overflow-hidden">
              <svg viewBox="0 0 100 100" className="block w-full h-[150px]" preserveAspectRatio="xMidYMid meet">
                {cizimSirasi(parts ?? []).map((p) => (
                  <polygon
                    key={p.name}
                    points={poligonSvg(p.polygon, frame)}
                    fill={p.name === seciliParca.name ? "oklch(0.65 0.2 25 / 55%)" : "oklch(0.5 0 0 / 12%)"}
                    stroke={p.name === seciliParca.name ? "oklch(0.65 0.2 25)" : "oklch(0.5 0 0 / 30%)"}
                    strokeWidth={p.name === seciliParca.name ? 1.6 : 0.6}
                  />
                ))}
              </svg>
            </div>
            <p className="text-sm text-muted-foreground">
              Bu parça yarım kalacak, diğerleri basılmaya devam edecek.
            </p>
            <DialogFooter className="gap-2">
              <Button variant="outline" size="sm" autoFocus onClick={() => setOnayda(false)}>Vazgeç</Button>
              <Button size="sm" variant="destructive" disabled={calisiyor} onClick={uygula}>
                {calisiyor ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Parça iptal ediliyor…</> : "Parçayı iptal et"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Dialog>
  );
}
