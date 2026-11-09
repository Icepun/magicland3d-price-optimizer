"use client";
/**
 * TAKILI FİLAMENTİN RENGİ / TÜRÜ — yazıcının ekranındaki "filament düzenle", bilgisayardan.
 *
 * Yazıcı ekranları sabit bir paletle sınırlı; burada her renk seçilebilir. Önce kullanıcının
 * stoğundaki makara renkleri (Filament sayfası) gelir — çoğu zaman takılan makara oradadır.
 * Kaydedilen değer yazıcıdan geri okunarak doğrulanır (sunucu tarafı).
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, Loader2, Palette } from "lucide-react";
import { cn } from "@/lib/utils";
import { BAMBU_FILAMENT_TIPLERI, renkKodu, U1_FILAMENT_TIPLERI } from "@/core/printers/filament-tipleri";

interface StokMakara { colorHex: string; colorName: string | null; material: string; isActive: boolean }

const TEMEL_RENKLER: { ad: string; hex: string }[] = [
  { ad: "Siyah", hex: "#161616" },
  { ad: "Beyaz", hex: "#F5F5F5" },
  { ad: "Gri", hex: "#8C9099" },
  { ad: "Gümüş", hex: "#C0C4C8" },
  { ad: "Kırmızı", hex: "#E72F1D" },
  { ad: "Bordo", hex: "#7B1E2B" },
  { ad: "Pembe", hex: "#F55A74" },
  { ad: "Turuncu", hex: "#F28C28" },
  { ad: "Sarı", hex: "#F4D03F" },
  { ad: "Altın", hex: "#C9A227" },
  { ad: "Yeşil", hex: "#2ECC71" },
  { ad: "Koyu yeşil", hex: "#1E5631" },
  { ad: "Mavi", hex: "#2F6BFF" },
  { ad: "Lacivert", hex: "#1B2A4A" },
  { ad: "Mor", hex: "#7D3C98" },
  { ad: "Kahverengi", hex: "#6F4C2F" },
  { ad: "Bej", hex: "#D9C3A5" },
  { ad: "Şeffaf", hex: "#E8EEF2" },
];

export function FilamentRenkDialog({
  printerId, printerName, isBambu, slot, mevcut, onClose,
}: {
  printerId: string;
  /** Başlıkta gösterilir (baskı başlatma penceresinden açılınca verilmez). */
  printerName?: string;
  isBambu: boolean;
  slot: number;
  mevcut: { color: string; type: string };
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const baslangicRenk = renkKodu(mevcut.color) ? `#${renkKodu(mevcut.color)}` : "#9CA3AF";
  const tipler: readonly string[] = isBambu ? BAMBU_FILAMENT_TIPLERI : U1_FILAMENT_TIPLERI;
  const [renk, setRenk] = useState(baslangicRenk);
  const [hexYazi, setHexYazi] = useState(baslangicRenk.slice(1));
  const [tip, setTip] = useState<string>(mevcut.type && tipler.includes(mevcut.type) ? mevcut.type : "");
  const [durum, setDurum] = useState<"bos" | "kaydediliyor" | "tamam">("bos");
  const [hata, setHata] = useState<string | null>(null);

  const stokQ = useQuery<StokMakara[]>({
    queryKey: ["spools"],
    queryFn: async () => {
      const r = await fetch("/api/spools");
      if (!r.ok) throw new Error("Stok okunamadı");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });
  // Stoktaki renkler: aynı renk bir kez (ad + kod), en çok 24.
  const stokRenkleri = useMemo(() => {
    const gorulen = new Set<string>();
    const out: { ad: string; hex: string; malzeme: string }[] = [];
    for (const s of stokQ.data ?? []) {
      const hex = renkKodu(s.colorHex);
      if (!s.isActive || !hex) continue;
      const anahtar = `${hex}|${(s.colorName ?? "").toLocaleLowerCase("tr-TR")}`;
      if (gorulen.has(anahtar)) continue;
      gorulen.add(anahtar);
      out.push({ ad: s.colorName || `#${hex}`, hex: `#${hex}`, malzeme: s.material });
      if (out.length >= 24) break;
    }
    return out;
  }, [stokQ.data]);

  const renkSec = (hex: string) => {
    setRenk(hex.toUpperCase());
    setHexYazi(hex.slice(1).toUpperCase());
    setHata(null);
  };
  const degisti = renk.toUpperCase() !== baslangicRenk.toUpperCase() || (tip !== "" && tip !== mevcut.type);
  const etiket = isBambu ? `Makara ${slot + 1}` : `${slot + 1}. kafa`;

  const kaydet = async () => {
    setDurum("kaydediliyor");
    setHata(null);
    try {
      const r = await fetch(`/api/printers/${printerId}/filament-ayar`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          slot,
          renk: renk.toUpperCase() !== baslangicRenk.toUpperCase() ? renk : null,
          tip: tip && tip !== mevcut.type ? tip : null,
        }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}) as { error?: string });
        throw new Error((j as { error?: string }).error || "Kaydedilemedi.");
      }
      setDurum("tamam");
      void qc.invalidateQueries({ queryKey: ["printers"] });
      void qc.invalidateQueries({ queryKey: ["printer-slots", printerId] });
      setTimeout(onClose, 900);
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Kaydedilemedi.");
      setDurum("bos");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && durum !== "kaydediliyor" && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Palette className="h-4 w-4 text-primary" /> {printerName ? `${etiket} — ${printerName}` : etiket}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Önizleme: seçilen renk büyük, yumuşak geçişle */}
          <div className="flex items-center gap-3 rounded-xl border p-3">
            <span
              className="h-12 w-12 shrink-0 rounded-full border border-black/25 shadow-inner transition-colors duration-300"
              style={{ background: renk }}
            />
            <div className="min-w-0">
              <p className="text-sm font-semibold">{tip || mevcut.type || "Filament"}</p>
              <p className="text-xs text-muted-foreground font-mono">{renk.toUpperCase()}</p>
            </div>
          </div>

          {stokRenkleri.length > 0 && (
            <div className="space-y-1.5 motion-safe:animate-in motion-safe:fade-in duration-300">
              <p className="text-[11px] text-muted-foreground">Stoğundaki renkler</p>
              <div className="flex flex-wrap gap-2">
                {stokRenkleri.map((r) => (
                  <RenkKutusu key={`${r.hex}-${r.ad}`} hex={r.hex} ad={r.ad} alt={r.malzeme} secili={renk} onSec={renkSec} />
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">Temel renkler</p>
            <div className="flex flex-wrap gap-2">
              {TEMEL_RENKLER.map((r) => <RenkKutusu key={r.hex} hex={r.hex} ad={r.ad} secili={renk} onSec={renkSec} />)}
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">Özel renk</p>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={renk}
                onChange={(e) => renkSec(e.target.value)}
                className="h-9 w-12 cursor-pointer rounded-md border bg-transparent p-0.5"
                aria-label="Renk seç"
              />
              <div className="flex items-center rounded-md border px-2 h-9">
                <span className="text-xs text-muted-foreground">#</span>
                <input
                  value={hexYazi}
                  onChange={(e) => {
                    const v = e.target.value.replace(/[^0-9a-fA-F]/g, "").slice(0, 6).toUpperCase();
                    setHexYazi(v);
                    if (v.length === 6) setRenk(`#${v}`);
                  }}
                  className="w-20 bg-transparent text-xs font-mono outline-none"
                  aria-label="Renk kodu"
                />
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-[11px] text-muted-foreground">Malzeme</p>
            <div className="flex flex-wrap gap-1.5">
              {tipler.map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => { setTip(t); setHata(null); }}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs transition-all duration-150 active:scale-95",
                    (tip || mevcut.type) === t ? "border-primary bg-primary/10 font-semibold" : "hover:bg-muted",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {hata && (
            <p className="flex items-start gap-1.5 text-xs text-destructive motion-safe:animate-in motion-safe:fade-in">
              <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" /> {hata}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose} disabled={durum === "kaydediliyor"}>Vazgeç</Button>
          <Button size="sm" onClick={kaydet} disabled={!degisti || durum !== "bos"} className="min-w-[7.5rem]">
            {durum === "kaydediliyor" ? (
              <><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Kaydediliyor…</>
            ) : durum === "tamam" ? (
              <><Check className="h-3.5 w-3.5 mr-1 motion-safe:animate-in motion-safe:zoom-in-50" /> Kaydedildi</>
            ) : (
              "Yazıcıya kaydet"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RenkKutusu({ hex, ad, alt, secili, onSec }: {
  hex: string; ad: string; alt?: string; secili: string; onSec: (hex: string) => void;
}) {
  const sec = hex.toUpperCase() === secili.toUpperCase();
  return (
    <button
      type="button"
      onClick={() => onSec(hex)}
      title={alt ? `${ad} · ${alt}` : ad}
      className={cn(
        "relative h-8 w-8 rounded-full border border-black/25 shadow-inner transition-all duration-150",
        "hover:scale-110 active:scale-95",
        sec && "ring-2 ring-primary ring-offset-2 ring-offset-background scale-110",
      )}
      style={{ background: hex }}
    >
      {sec && (
        <Check
          className="absolute inset-0 m-auto h-4 w-4 drop-shadow motion-safe:animate-in motion-safe:zoom-in-50"
          style={{ color: aciklik(hex) > 0.6 ? "#111" : "#fff" }}
        />
      )}
    </button>
  );
}

/** Rengin algılanan açıklığı (0-1) — seçim işaretini koyu/açık zemine göre boyamak için. */
function aciklik(hex: string): number {
  const k = renkKodu(hex);
  if (!k) return 0.5;
  const r = parseInt(k.slice(0, 2), 16), g = parseInt(k.slice(2, 4), 16), b = parseInt(k.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
