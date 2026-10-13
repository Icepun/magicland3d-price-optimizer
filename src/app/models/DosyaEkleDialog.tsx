"use client";
/**
 * KÜTÜPHANEDEN DOSYA EKLE — boş hücreye tıklayınca açılır.
 *
 * Tablo eksikleri gösteriyor; doldurmak için her seferinde ürün sayfasına gidip dönmek
 * gerekiyordu. Burada dosya doğrudan o model + yazıcı için yüklenir, tablo yerinde yeşile döner.
 */
import { useRef, useState } from "react";
import { CloudUpload, Layers, Loader2, Printer } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { baskiDosyasiMi } from "@/lib/model-dosya-gorunum";
import { setUploadsActive } from "@/lib/gcode-viz/viz-uploads";
import { uploadProductModel, type UploadProgress } from "@/lib/upload-model";

export interface DosyaEkleHedefi {
  /** Dosyanın yükleneceği ürün. */
  productId: string;
  /** Başlıkta görünen ad (model ya da varyant). */
  ad: string;
  /** Yazıcı ailesinin adı ("Snapmaker U1"). */
  aileAdi: string;
  /** Ailenin temsilci yazıcısı — dosya ona kaydedilir, ailedeki hepsi basar. */
  printerConfigId: string;
  /** Ürünün varyant grubundaki ürün sayısı (grupsuzsa 1). */
  varyantSayisi: number;
  /** Açılışta "tüm varyantlara ekle" seçili mi? (grup satırından açıldıysa evet) */
  tumVaryantlar: boolean;
}

function fmtSize(b: number) {
  return b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`;
}

export function DosyaEkleDialog({
  hedef, onClose, onEklendi,
}: {
  hedef: DosyaEkleHedefi;
  onClose: () => void;
  /** En az bir dosya eklendiyse çağrılır — tablo tazelensin. */
  onEklendi: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const azHareket = usePrefersReducedMotion();
  const [tumVaryantlar, setTumVaryantlar] = useState(hedef.tumVaryantlar);
  const [surukleniyor, setSurukleniyor] = useState(false);
  const surukSayaci = useRef(0);
  /** Süren yükleme: kaçıncı dosya, adı ve bayt ilerlemesi. */
  const [yukleme, setYukleme] = useState<{ sira: number; toplam: number; ad: string; p: UploadProgress } | null>(null);
  const mesgul = yukleme !== null;
  const coklu = hedef.varyantSayisi > 1;

  const yukle = async (liste: File[]) => {
    const uygun = liste.filter((f) => baskiDosyasiMi(f.name));
    if (uygun.length < liste.length) toast.error("Yalnız .gcode ve .3mf dosyaları eklenebilir");
    if (!uygun.length || mesgul) return;
    let tamam = 0;
    setUploadsActive(1); // arka plan görselleştirme üretimi yükleme boyunca beklesin
    try {
      for (const [i, f] of uygun.entries()) {
        const ilerle = (p: UploadProgress) => setYukleme({ sira: i + 1, toplam: uygun.length, ad: f.name, p });
        ilerle({ loaded: 0, total: f.size, bytesPerSec: 0 });
        try {
          await uploadProductModel({
            productId: hedef.productId,
            printerConfigId: hedef.printerConfigId,
            file: f,
            applyToVariants: coklu && tumVaryantlar,
            onProgress: ilerle,
          });
          tamam++;
        } catch (e) {
          toast.error(`${f.name}: ${e instanceof Error ? e.message : "yüklenemedi"}`);
        }
      }
    } finally {
      setUploadsActive(-1);
      setYukleme(null);
      if (inputRef.current) inputRef.current.value = "";
    }
    if (tamam > 0) {
      toast.success(`${tamam} parça eklendi${coklu && tumVaryantlar ? ` · ${hedef.varyantSayisi} varyanta` : ""}`);
      onEklendi();
      onClose();
    }
  };

  const dosyaTasiyor = (e: React.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const yuzde = yukleme && yukleme.p.total > 0 ? Math.min(100, Math.round((yukleme.p.loaded / yukleme.p.total) * 100)) : 0;
  const isleniyor = !!yukleme && yukleme.p.total > 0 && yukleme.p.loaded >= yukleme.p.total;

  return (
    <Dialog open onOpenChange={(o) => !o && !mesgul && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex min-w-0 items-center gap-2 pr-8">
            <CloudUpload className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">Dosya ekle</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-1">
          <p className="break-words text-sm font-medium leading-snug">{hedef.ad}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Printer className="h-3.5 w-3.5" /> {hedef.aileAdi}
          </p>
        </div>

        {coklu && (
          <button
            type="button"
            role="switch"
            aria-checked={tumVaryantlar}
            disabled={mesgul}
            onClick={() => setTumVaryantlar((v) => !v)}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-lg border p-2.5 text-left transition-colors disabled:opacity-60",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              tumVaryantlar ? "border-primary/40 bg-primary/[0.06]" : "border-dashed hover:bg-muted/40",
            )}
          >
            <span
              className={cn(
                "relative h-4 w-7 shrink-0 rounded-full transition-colors",
                tumVaryantlar ? "bg-primary" : "bg-muted-foreground/30",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-3 w-3 rounded-full bg-background transition-[left] duration-200",
                  tumVaryantlar ? "left-3.5" : "left-0.5",
                )}
              />
            </span>
            <Layers className="h-4 w-4 shrink-0 text-primary" />
            <span className="min-w-0 flex-1 text-xs">
              <span className="font-medium">Tüm varyantlara ekle</span>
              <span className="block text-[11px] text-muted-foreground">
                {tumVaryantlar ? `${hedef.varyantSayisi} varyantın hepsine eklenir.` : "Yalnız bu varyanta eklenir."}
              </span>
            </span>
          </button>
        )}

        <input
          ref={inputRef}
          type="file"
          accept=".gcode,.gco,.g,.3mf"
          multiple
          className="hidden"
          onChange={(e) => { if (e.target.files?.length) void yukle(Array.from(e.target.files)); }}
        />

        {yukleme ? (
          // BELİRLİ ilerleme: kaçıncı dosya, yüzde ve bayt — donuk bekleme yok.
          <div className="space-y-2 rounded-lg border bg-muted/30 p-3 animate-in fade-in duration-200" aria-live="polite">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="flex min-w-0 items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
                <span className="truncate">{yukleme.ad}</span>
              </span>
              <span className="shrink-0 font-semibold tabular-nums">{yuzde}%</span>
            </div>
            <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
              <div
                className="relative h-full overflow-hidden rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${Math.max(3, yuzde)}%` }}
              >
                {!azHareket && (
                  <div
                    className="absolute inset-0"
                    style={{ background: "linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent)", animation: "printer-shimmer 1.2s linear infinite" }}
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-[10px] tabular-nums text-muted-foreground">
              <span>
                {yukleme.toplam > 1 ? `${yukleme.sira}/${yukleme.toplam} dosya · ` : ""}
                {fmtSize(yukleme.p.loaded)} / {fmtSize(yukleme.p.total)}
              </span>
              <span>{isleniyor ? "dosya işleniyor…" : yukleme.p.bytesPerSec > 0 ? `${fmtSize(yukleme.p.bytesPerSec)}/sn` : "başlıyor…"}</span>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragEnter={(e) => {
              if (!dosyaTasiyor(e)) return;
              e.preventDefault();
              surukSayaci.current += 1;
              setSurukleniyor(true);
            }}
            onDragOver={(e) => {
              if (!dosyaTasiyor(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "copy";
            }}
            onDragLeave={(e) => {
              if (!dosyaTasiyor(e)) return;
              surukSayaci.current = Math.max(0, surukSayaci.current - 1);
              if (surukSayaci.current === 0) setSurukleniyor(false);
            }}
            onDrop={(e) => {
              if (!dosyaTasiyor(e)) return;
              e.preventDefault();
              surukSayaci.current = 0;
              setSurukleniyor(false);
              void yukle(Array.from(e.dataTransfer.files ?? []));
            }}
            className={cn(
              "group/birak flex w-full flex-col items-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-7 text-center transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              surukleniyor ? "border-primary bg-primary/10" : "border-border/70 hover:border-primary/50 hover:bg-primary/[0.04]",
            )}
          >
            <CloudUpload
              className={cn(
                "h-7 w-7 transition-all duration-200",
                surukleniyor ? "scale-110 text-primary" : "text-muted-foreground/50 group-hover/birak:-translate-y-0.5 group-hover/birak:text-primary",
              )}
            />
            <span className="text-sm font-medium">{surukleniyor ? "Bırak, yüklensin" : "Dosyaları sürükle ya da seç"}</span>
            <span className="text-[11px] text-muted-foreground">.gcode · .3mf — birden fazla seçebilirsin</span>
          </button>
        )}

        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={onClose} disabled={mesgul}>
            {mesgul ? "Yükleniyor…" : "Kapat"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
