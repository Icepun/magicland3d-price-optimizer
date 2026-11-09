"use client";
/**
 * BASKIDAN ÖNCE PARÇA SEÇİMİ — "bu parçaları hiç basma".
 *
 * Baskı sırasındaki parça iptalinin (`PartCancelDialog`) başlangıç hâli. Fark: burada hiçbir şey
 * geri alınamaz değil — seçim baskı başlayana kadar yalnız bir işarettir. Bu yüzden tıklama
 * DOĞRUDAN aç/kapat yapar, ayrı onay yoktur. Parçalar yine tabladaki yerlerine göre numaralanır
 * (ham ad gösterilmez) ve 3B görünüş hazırsa tepeden görünüşün yerine geçer.
 *
 * Son parça korunur: hepsini kapatmak baskıyı başlatıp boşa çalıştırmak olurdu.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  cizimSirasi, parcalariSirala, poligonSvg, type Cerceve, type PartPolygon,
} from "@/app/printers/part-map";
import type { ParsedGcode } from "@/lib/gcode-viz/viz-pack";

const ParcaSecici3B = dynamic(() => import("./ParcaSecici3B").then((m) => m.ParcaSecici3B), { ssr: false });

/** Tabla ölçüsü bilinmiyorsa parçaların kapladığı alandan pay bırakarak bir çerçeve çıkar. */
export function parcaCercevesi(parts: PartPolygon[]): Cerceve {
  const xs = parts.flatMap((p) => p.polygon.map((q) => q[0]));
  const ys = parts.flatMap((p) => p.polygon.map((q) => q[1]));
  if (!xs.length || !ys.length) return { minX: 0, maxX: 256, minY: 0, maxY: 256 };
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const kenar = Math.max(maxX - minX, maxY - minY) * 1.2 + 10;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return { minX: cx - kenar / 2, maxX: cx + kenar / 2, minY: cy - kenar / 2, maxY: cy + kenar / 2 };
}

export interface BaslangicParcaDialogProps {
  parts: PartPolygon[];
  frame: Cerceve | null;
  model3d: { fileId: string; cacheKey: string } | null;
  /** Şu an "basılmasın" işaretli parçalar (ham adlar). */
  secilenler: string[];
  toolColors?: (string | null)[];
  reduceMotion?: boolean;
  onKaydet: (atlanacak: string[]) => void;
  onClose: () => void;
}

export function BaslangicParcaDialog({
  parts: hamParcalar, frame, model3d, secilenler, toolColors, reduceMotion = false, onKaydet, onClose,
}: BaslangicParcaDialogProps) {
  const parts = useMemo(() => parcalariSirala(hamParcalar), [hamParcalar]);
  const cerceve = useMemo(() => frame ?? parcaCercevesi(hamParcalar), [frame, hamParcalar]);
  const [atlanacak, setAtlanacak] = useState<string[]>(() => secilenler.filter((s) => parts.some((p) => p.name === s)));
  const [sonParcaUyari, setSonParcaUyari] = useState(false);
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

  // "En az bir parça" uyarısı birkaç saniye sonra kendiliğinden kaybolur.
  useEffect(() => {
    if (!sonParcaUyari) return;
    const t = setTimeout(() => setSonParcaUyari(false), 2600);
    return () => clearTimeout(t);
  }, [sonParcaUyari]);

  const degistir = useCallback((ad: string) => {
    if (atlanacak.includes(ad)) {
      setAtlanacak(atlanacak.filter((x) => x !== ad));
      return;
    }
    if (parts.length - atlanacak.length <= 1) {
      setSonParcaUyari(true);
      return;
    }
    setAtlanacak([...atlanacak, ad]);
  }, [atlanacak, parts.length]);

  const basilacak = parts.length - atlanacak.length;
  const uc = !!geom && !ucHata && parts.length > 0;
  const ucGorunur = uc && ucHazir;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="text-base">Hangi parçalar basılsın?</DialogTitle>
          <p className="text-xs text-muted-foreground">Basılmasını istemediğin parçalara dokun.</p>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative h-[360px] rounded-lg border bg-muted/20 overflow-hidden">
            <div className={cn("absolute inset-0", !reduceMotion && "transition-opacity duration-500", ucGorunur ? "pointer-events-none opacity-0" : "opacity-100")}>
              <svg viewBox="0 0 100 100" className="block w-full h-[360px]" preserveAspectRatio="xMidYMid meet">
                {cizimSirasi(parts).map((p) => {
                  const kapali = atlanacak.includes(p.name);
                  const ust = p.name === listeUst;
                  return (
                    <polygon
                      key={p.name}
                      points={poligonSvg(p.polygon, cerceve)}
                      className="cursor-pointer transition-[fill,stroke] duration-200"
                      fill={kapali ? "oklch(0.5 0 0 / 10%)" : ust ? "oklch(0.72 0.14 220 / 42%)" : "oklch(0.72 0.14 220 / 26%)"}
                      stroke={kapali ? "oklch(0.5 0 0 / 35%)" : "oklch(0.72 0.14 220 / 75%)"}
                      strokeDasharray={kapali ? "1.6 1.2" : undefined}
                      strokeWidth={ust ? 1.2 : 0.7}
                      onClick={() => degistir(p.name)}
                    />
                  );
                })}
                {parts.map((p) => {
                  const o = poligonSvg([p.center], cerceve).split(",");
                  return (
                    <text
                      key={`t-${p.name}`}
                      x={o[0]} y={o[1]}
                      textAnchor="middle" dominantBaseline="central"
                      fontSize="4.5" fontWeight="700"
                      fill={atlanacak.includes(p.name) ? "oklch(0.6 0 0)" : "oklch(0.98 0 0)"}
                      textDecoration={atlanacak.includes(p.name) ? "line-through" : undefined}
                      className="pointer-events-none select-none"
                    >
                      {p.no}
                    </text>
                  );
                })}
              </svg>
            </div>
            {uc && geom && (
              <ParcaSecici3B
                geom={geom}
                parcalar={parts}
                iptaller={atlanacak}
                secili={null}
                basilan={null}
                disVurgu={listeUst}
                ilerleme={null}
                toolColors={toolColors}
                reduceMotion={reduceMotion}
                iptalSecilebilir
                ipucuMetni="Sürükleyerek çevir · dokunarak aç/kapat"
                onSec={degistir}
                onUzerinde={setUzerinde}
                onHazir={() => setUcHazir(true)}
                onHata={() => setUcHata(true)}
              />
            )}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {parts.map((p, i) => {
              const kapali = atlanacak.includes(p.name);
              return (
                <button
                  key={p.name}
                  onClick={() => degistir(p.name)}
                  onMouseEnter={() => setListeUst(p.name)}
                  onMouseLeave={() => setListeUst(null)}
                  style={{ animationDelay: reduceMotion ? undefined : `${Math.min(i, 14) * 25}ms` }}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-all duration-200 active:scale-95",
                    "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1",
                    kapali ? "opacity-55 border-dashed" : "border-primary/40 bg-primary/10",
                    p.name === uzerinde && "ring-1 ring-[#3fd0ff]/60",
                  )}
                >
                  {kapali
                    ? <span className="h-3.5 w-3.5 rounded-sm border border-muted-foreground/50" />
                    : <Check className="h-3.5 w-3.5 text-primary" />}
                  <span className={cn("font-semibold tabular-nums", kapali && "line-through")}>{p.no}. parça</span>
                  {kapali && <span className="text-[10px] text-muted-foreground">basılmayacak</span>}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 text-xs">
            <span className="tabular-nums">
              <b className="text-foreground">{basilacak}</b>
              <span className="text-muted-foreground"> / {parts.length} parça basılacak</span>
            </span>
            {atlanacak.length > 0 && (
              <button
                onClick={() => setAtlanacak([])}
                className="ml-auto inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors motion-safe:animate-in motion-safe:fade-in"
              >
                <RotateCcw className="h-3 w-3" /> Hepsini bas
              </button>
            )}
          </div>

          {sonParcaUyari && (
            <p className="flex items-center gap-1.5 text-xs motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1" style={{ color: "var(--panel-amber)" }}>
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> En az bir parça basılmalı.
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Vazgeç</Button>
          <Button size="sm" onClick={() => onKaydet(atlanacak)}>Tamam</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
