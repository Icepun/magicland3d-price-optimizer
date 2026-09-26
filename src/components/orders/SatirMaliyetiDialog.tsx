"use client";

import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Calculator, Coins, Loader2, Plus, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { fetchJson } from "@/lib/fetch-json";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";
import { parsePackagingSettings, type NylonLevel } from "@/core/packaging";
import { EK_FILAMENT_AZAMI, filamentFiyatHaritasi } from "@/core/filament-karisimi";
import { satirMaliyetiCozumle, type SatirMaliyeti, type SatirMaliyetModu } from "@/core/order-line-cost";

interface FilamentTuru {
  id: string;
  name: string;
  costPerGram: number;
}

export interface SatirMaliyetiHedefi {
  platform: "shopify" | "trendyol" | "hepsiburada";
  siparisId: string;
  siparisNo: string;
  satirAnahtari: string;
  satirAdi: string;
  adet: number;
  gorsel: string | null;
  /** Bu satıra daha önce siparişe özel maliyet girilmiş mi (düzenleme)? */
  kayitli: boolean;
}

interface KayitYaniti {
  kayit: { maliyet: SatirMaliyeti | null; desi: number | null; satirAdi: string } | null;
}

/** Form metinleri — kayıtlı girdiden ya da boş başlar. */
interface FormBaslangici {
  mod: SatirMaliyetModu;
  filamentTypeId: string;
  filamentWeight: string;
  ekler: { filamentTypeId: string; gram: string }[];
  printTimeHours: string;
  wasteRate: string; // yüzde
  tutar: string;
  packagingOptionId: string;
  nylonLevel: NylonLevel;
  tapeUsed: boolean;
  desi: string;
}

const sayiMetni = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "" : String(n));

function baslangic(k: KayitYaniti["kayit"]): FormBaslangici {
  const m = k?.maliyet;
  return {
    mod: m?.mod ?? "hesap",
    filamentTypeId: m?.filamentTypeId ?? "",
    filamentWeight: sayiMetni(m?.filamentWeight),
    ekler: (m?.ekFilamentler ?? []).map((e) => ({ filamentTypeId: e.filamentTypeId, gram: String(e.gram) })),
    printTimeHours: sayiMetni(m?.printTimeHours),
    wasteRate: m?.wasteRate != null ? String(Math.round(m.wasteRate * 10000) / 100) : "",
    tutar: sayiMetni(m?.tutar),
    packagingOptionId: m?.packagingOptionId ?? "",
    nylonLevel: ((m?.nylonLevel as NylonLevel) ?? "none") || "none",
    tapeUsed: Boolean(m?.tapeUsed),
    desi: sayiMetni(k?.desi),
  };
}

const sayi = (t: string): number | null => {
  const s = t.trim().replace(",", ".");
  if (!s) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * SİPARİŞE ÖZEL MALİYET — ürünler sayfasında olmayan (ya da maliyeti girilmemiş) ürünün YALNIZ
 * bu siparişteki maliyeti. Alanlar ürün sayfasındakinin aynısı; hesap da aynı motordan.
 */
export function SatirMaliyetiDialog({ hedef, onClose }: { hedef: SatirMaliyetiHedefi; onClose: () => void }) {
  const { data: filamentler = [], isLoading: filamentYukleniyor } = useQuery<FilamentTuru[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetchJson("/api/filament-types"),
    staleTime: 10 * 60_000,
  });
  const { data: ayarlar, isLoading: ayarYukleniyor } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });
  const kayitSorgusu = useQuery<KayitYaniti>({
    queryKey: ["satir-maliyeti", hedef.platform, hedef.siparisId, hedef.satirAnahtari],
    queryFn: () =>
      fetchJson(
        `/api/orders/satir-maliyeti?platform=${hedef.platform}&siparis=${encodeURIComponent(
          hedef.siparisId
        )}&anahtar=${encodeURIComponent(hedef.satirAnahtari)}`
      ),
    enabled: hedef.kayitli,
    staleTime: 0,
  });

  const hazir =
    !filamentYukleniyor && !ayarYukleniyor && Boolean(ayarlar) && (!hedef.kayitli || kayitSorgusu.isSuccess);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[88vh] overflow-y-auto">
        <DialogHeader className="space-y-1">
          <DialogTitle className="flex items-center gap-2">
            <Coins className="h-4 w-4 text-amber-500" />
            {hedef.kayitli ? "Siparişe özel maliyet" : "Maliyet gir"}
          </DialogTitle>
          <div className="flex items-center gap-2.5">
            {hedef.gorsel && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={hedef.gorsel}
                alt=""
                className="h-9 w-9 shrink-0 rounded-md border object-cover animate-in fade-in duration-300"
              />
            )}
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{hedef.satirAdi}</p>
              <p className="text-[11px] text-muted-foreground">
                Yalnız bu sipariş için · {hedef.siparisNo} · {hedef.adet} adet
              </p>
            </div>
          </div>
        </DialogHeader>

        {!hazir ? (
          <div className="space-y-3 pt-1">
            <Skeleton className="h-9 w-full rounded-lg" />
            <Skeleton className="h-24 w-full rounded-lg" />
            <Skeleton className="h-16 w-full rounded-lg" />
          </div>
        ) : (
          <SatirMaliyetiFormu
            hedef={hedef}
            baslangic={baslangic(kayitSorgusu.data?.kayit ?? null)}
            filamentler={filamentler}
            ayarlar={ayarlar ?? {}}
            onClose={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function SatirMaliyetiFormu({
  hedef,
  baslangic: b,
  filamentler,
  ayarlar,
  onClose,
}: {
  hedef: SatirMaliyetiHedefi;
  baslangic: FormBaslangici;
  filamentler: FilamentTuru[];
  ayarlar: Record<string, string>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [mod, setMod] = useState<SatirMaliyetModu>(b.mod);
  const [filamentTypeId, setFilamentTypeId] = useState(b.filamentTypeId);
  const [filamentWeight, setFilamentWeight] = useState(b.filamentWeight);
  // Başlangıç satırları 1..n; yeni satırlar sayaçtan (ref yalnız olay işleyicisinde okunur).
  const sayac = useRef(b.ekler.length);
  const [ekler, setEkler] = useState(() => b.ekler.map((e, i) => ({ anahtar: i + 1, ...e })));
  const [printTimeHours, setPrintTimeHours] = useState(b.printTimeHours);
  const [wasteRate, setWasteRate] = useState(b.wasteRate);
  const [tutar, setTutar] = useState(b.tutar);
  const [packagingOptionId, setPackagingOptionId] = useState(b.packagingOptionId);
  const [nylonLevel, setNylonLevel] = useState<NylonLevel>(b.nylonLevel);
  const [tapeUsed, setTapeUsed] = useState(b.tapeUsed);
  const [desi, setDesi] = useState(b.desi);
  const [silSor, setSilSor] = useState(false);

  const paketlemeAyari = useMemo(() => parsePackagingSettings(ayarlar), [ayarlar]);
  const fiyatlar = useMemo(() => filamentFiyatHaritasi(filamentler), [filamentler]);
  const bantBirim =
    paketlemeAyari.tapeProductsPerRoll > 0 ? paketlemeAyari.tapePrice / paketlemeAyari.tapeProductsPerRoll : 0;

  // ── Doğrulama (geçersizken kayıt düğmesi kapalı) ──
  const hatalar: Record<string, string | undefined> = {};
  const denetle = (ad: string, metin: string, anahtar: string, ust?: number) => {
    const n = sayi(metin);
    if (n === null) return;
    if (Number.isNaN(n)) hatalar[anahtar] = `${ad} için sayı gir`;
    else if (n < 0) hatalar[anahtar] = `${ad} eksi olamaz`;
    else if (ust != null && n > ust) hatalar[anahtar] = `${ad} en fazla ${ust} olabilir`;
  };
  if (mod === "hesap") {
    denetle("Ağırlık", filamentWeight, "gram");
    denetle("Süre", printTimeHours, "sure");
    denetle("Fire", wasteRate, "fire", 100);
    ekler.forEach((e, i) => denetle("Ağırlık", e.gram, `ek${i}`));
  } else {
    denetle("Tutar", tutar, "tutar");
  }
  denetle("Desi", desi, "desi");
  const hataVar = Object.values(hatalar).some(Boolean);

  const girdi: SatirMaliyeti = {
    mod,
    filamentTypeId: filamentTypeId || null,
    filamentWeight: sayi(filamentWeight) ?? null,
    ekFilamentler: ekler
      .map((e) => ({ filamentTypeId: e.filamentTypeId, gram: sayi(e.gram) ?? 0 }))
      .filter((e) => e.filamentTypeId && e.gram > 0),
    printTimeHours: sayi(printTimeHours) ?? null,
    wasteRate: sayi(wasteRate) != null ? (sayi(wasteRate) as number) / 100 : null,
    tutar: sayi(tutar) ?? null,
    packagingOptionId: packagingOptionId || null,
    nylonLevel,
    tapeUsed,
  };
  const cozum = hataVar ? null : satirMaliyetiCozumle(girdi, ayarlar, fiyatlar);
  const biliniyor = Boolean(cozum?.productionCostKnown);
  const birim = cozum?.totalCost ?? NaN;

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson("/api/orders/satir-maliyeti", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: hedef.platform,
          siparisId: hedef.siparisId,
          satirAnahtari: hedef.satirAnahtari,
          satirAdi: hedef.satirAdi,
          maliyet: girdi,
          desi: sayi(desi) ?? null,
        }),
      }),
    onSuccess: () => {
      toast.success("Maliyet kaydedildi — sipariş kârı güncelleniyor");
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.removeQueries({ queryKey: ["satir-maliyeti", hedef.platform, hedef.siparisId, hedef.satirAnahtari] });
      onClose();
    },
    onError: (e) => toast.error("Kaydedilemedi", { description: e instanceof Error ? e.message : undefined }),
  });

  const kaldir = useMutation({
    mutationFn: () =>
      fetchJson("/api/orders/satir-maliyeti", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: hedef.platform,
          siparisId: hedef.siparisId,
          satirAnahtari: hedef.satirAnahtari,
        }),
      }),
    onSuccess: () => {
      toast.success("Siparişe özel maliyet kaldırıldı");
      void qc.invalidateQueries({ queryKey: ["orders"] });
      void qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.removeQueries({ queryKey: ["satir-maliyeti", hedef.platform, hedef.siparisId, hedef.satirAnahtari] });
      onClose();
    },
    onError: () => toast.error("Kaldırılamadı"),
  });

  const secim =
    "w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";
  const hataSatiri = (anahtar: string) =>
    hatalar[anahtar] ? (
      <p className="mt-1 text-[10px] text-destructive animate-in fade-in slide-in-from-top-1 duration-200">
        {hatalar[anahtar]}
      </p>
    ) : null;
  const mesgul = kaydet.isPending || kaldir.isPending;

  return (
    <div className="space-y-4">
      {/* Yöntem */}
      <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 animate-in fade-in duration-300">
        {(
          [
            ["hesap", "Filamentle hesapla", Calculator],
            ["tutar", "Tutar gir", Coins],
          ] as const
        ).map(([k, etiket, Ikon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setMod(k)}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 active:scale-95",
              mod === k ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
            )}
          >
            <Ikon className="h-3.5 w-3.5" />
            {etiket}
          </button>
        ))}
      </div>

      {mod === "hesap" ? (
        <div key="hesap" className="space-y-3 animate-in fade-in slide-in-from-bottom-1 duration-300">
          <div>
            <Label className="text-xs">Filament türü</Label>
            <select value={filamentTypeId} onChange={(e) => setFilamentTypeId(e.target.value)} className={secim}>
              <option value="">Seçin...</option>
              {filamentler.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({formatCurrency(f.costPerGram)}/g)
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Ağırlık (g)</Label>
              <Input type="number" min="0" step="1" value={filamentWeight} onChange={(e) => setFilamentWeight(e.target.value)} />
              {hataSatiri("gram")}
            </div>
            <div>
              <Label className="text-xs">Süre (saat)</Label>
              <Input type="number" min="0" step="0.1" value={printTimeHours} onChange={(e) => setPrintTimeHours(e.target.value)} />
              {hataSatiri("sure")}
            </div>
          </div>
          {ekler.map((e, i) => (
            <div key={e.anahtar} className="flex items-start gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
              <div className="min-w-0 flex-1">
                <Label className="text-xs">Filament {i + 2}</Label>
                <select
                  value={e.filamentTypeId}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    setEkler((l) => l.map((x) => (x.anahtar === e.anahtar ? { ...x, filamentTypeId: v } : x)));
                  }}
                  className={secim}
                >
                  <option value="">Seçin...</option>
                  {filamentler.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({formatCurrency(f.costPerGram)}/g)
                    </option>
                  ))}
                </select>
              </div>
              <div className="w-24 shrink-0">
                <Label className="text-xs">Ağırlık (g)</Label>
                <Input
                  type="number"
                  min="0"
                  step="1"
                  value={e.gram}
                  onChange={(ev) => {
                    const v = ev.target.value;
                    setEkler((l) => l.map((x) => (x.anahtar === e.anahtar ? { ...x, gram: v } : x)));
                  }}
                />
                {hataSatiri(`ek${i}`)}
              </div>
              <button
                type="button"
                onClick={() => setEkler((l) => l.filter((x) => x.anahtar !== e.anahtar))}
                className="mt-6 grid h-8 w-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive active:scale-90"
                aria-label="Bu filamenti kaldır"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ))}
          {ekler.length < EK_FILAMENT_AZAMI && (
            <button
              type="button"
              onClick={() => setEkler((l) => [...l, { anahtar: ++sayac.current, filamentTypeId: "", gram: "" }])}
              className="inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[11px] font-medium text-primary transition-colors hover:bg-primary/10 active:scale-95"
            >
              <Plus className="h-3 w-3" />
              Başka filament ekle
            </button>
          )}
          <div>
            <Label className="text-xs">Fire (%)</Label>
            <Input type="number" min="0" max="100" step="0.1" value={wasteRate} onChange={(e) => setWasteRate(e.target.value)} />
            {hataSatiri("fire")}
          </div>
        </div>
      ) : (
        <div key="tutar" className="animate-in fade-in slide-in-from-bottom-1 duration-300">
          <Label className="text-xs">Adet başı ürün maliyeti (₺)</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={tutar}
            onChange={(e) => setTutar(e.target.value)}
            placeholder="örn. 45"
            autoFocus
          />
          {hataSatiri("tutar")}
        </div>
      )}

      {/* Paketleme + desi — ürün sayfasıyla aynı seçimler */}
      <div className="space-y-2 rounded-lg border p-3 animate-in fade-in duration-500">
        <p className="text-xs font-semibold text-primary">PAKETLEME VE KARGO</p>
        <select value={packagingOptionId} onChange={(e) => setPackagingOptionId(e.target.value)} className={secim}>
          <option value="">Poşet / koli yok</option>
          {paketlemeAyari.options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name} ({formatCurrency(o.price)})
            </option>
          ))}
        </select>
        <div className="grid grid-cols-3 gap-2">
          <div>
            <Label className="text-xs">Naylon</Label>
            <select value={nylonLevel} onChange={(e) => setNylonLevel(e.target.value as NylonLevel)} className={secim}>
              <option value="none">Yok</option>
              <option value="low">Az</option>
              <option value="medium">Orta</option>
              <option value="high">Çok</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Bant</Label>
            <select value={tapeUsed ? "yes" : "no"} onChange={(e) => setTapeUsed(e.target.value === "yes")} className={secim}>
              <option value="no">Yok</option>
              <option value="yes">Var ({formatCurrency(bantBirim)})</option>
            </select>
          </div>
          <div>
            <Label className="text-xs">Desi</Label>
            <Input type="number" min="0" step="0.1" value={desi} onChange={(e) => setDesi(e.target.value)} placeholder="örn. 2" />
            {hataSatiri("desi")}
          </div>
        </div>
      </div>

      {/* Özet — rakamlar akar */}
      <div
        className={cn(
          "flex items-center justify-between rounded-lg border px-3 py-2.5 transition-colors duration-300",
          biliniyor ? "border-emerald-500/30 bg-emerald-500/5" : "border-dashed"
        )}
      >
        <div className="text-xs text-muted-foreground">
          <p>Adet başı maliyet</p>
          {biliniyor && hedef.adet > 1 && (
            <p className="mt-0.5 tabular-nums animate-in fade-in duration-300">
              Bu siparişte {hedef.adet} adet: {formatCurrency(birim * hedef.adet)}
            </p>
          )}
        </div>
        <div className="text-right">
          <AnimatedNumber
            value={biliniyor ? birim : NaN}
            durationMs={320}
            format={(n) => formatCurrency(n)}
            className={cn("block text-lg font-bold tabular-nums", !biliniyor && "text-muted-foreground")}
          />
          {!biliniyor && (
            <p className="text-[10px] text-amber-500">
              {mod === "tutar" ? "Tutar gir" : "Filament ve ağırlık gir"}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 pt-1">
        <div>
          {hedef.kayitli &&
            (silSor ? (
              <div className="flex items-center gap-1 animate-in fade-in slide-in-from-left-1 duration-200">
                <Button size="sm" variant="destructive" disabled={mesgul} onClick={() => kaldir.mutate()}>
                  Kaldır
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setSilSor(false)}>
                  Vazgeç
                </Button>
              </div>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                onClick={() => setSilSor(true)}
                disabled={mesgul}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1.5" />
                Kaldır
              </Button>
            ))}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={mesgul}>
            Vazgeç
          </Button>
          <Button size="sm" onClick={() => kaydet.mutate()} disabled={mesgul || !biliniyor || hataVar}>
            {kaydet.isPending && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
            Kaydet
          </Button>
        </div>
      </div>
    </div>
  );
}
