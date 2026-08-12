"use client";

import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { AnimatedNumber } from "@/components/ui/animated-number";
import Link from "next/link";
import { formatCurrency, cn } from "@/lib/utils";
import { computePackagingCost, type PackagingSettings, type NylonLevel } from "@/core/packaging";
import { resolveProductCost } from "@/core/product-cost";

interface FilamentType {
  id: string;
  name: string;
  costPerGram: number;
}

/** Parent'a (debounce'lu) bildirilen, hesaplamaya hazır maliyet değerleri. */
export interface CostValues {
  filamentTypeId: string;
  filamentWeight: number;
  printTimeHours: number;
  wasteRate: number; // 0-1
  packagingOptionId: string;
  nylonLevel: NylonLevel;
  tapeUsed: boolean;
  desi: number | null;
}

/** Form'un başlangıç (seed) değerleri — ürünün kayıtlı maliyetinden türetilir. */
export interface CostInitial {
  filamentTypeId: string;
  filamentWeight: string;
  printTimeHours: string;
  wasteRate: string; // yüzde metni
  packagingOptionId: string;
  nylonLevel: NylonLevel;
  tapeUsed: boolean;
  desiInput: string;
}

/** Kayıtlı (sunucudaki) maliyet — form değerleriyle karşılaştırmak için gereken en dar şekil. */
export interface SavedCostSnapshot {
  desi: number | null;
  cost: {
    filamentTypeId: string | null;
    filamentWeight: number | null;
    printTimeHours: number | null;
    wasteRate: number | null;
    packagingOptionId: string | null;
    nylonLevel: string | null;
    tapeUsed: boolean | null;
  } | null;
}

/**
 * Desi metnini sayıya çevirir.
 *
 * ⚠️ "0" GEÇERLİ bir desidir (çok küçük ürünlerde bilerek girilir). Eskiden `parseFloat(x) || null`
 * kullanılıyordu: 0 "boş" sayılıp desi SİLİNİYORDU — ürün detayı açılır açılmaz kayıt tetikleniyor,
 * desi null'a düşüyor ve kargo 1 desi üzerinden hesaplanmaya başlıyordu.
 * Yalnız boş/geçersiz metin "girilmedi" (null) demektir.
 */
export function parseDesiInput(text: string): number | null {
  const trimmed = text.trim().replace(",", ".");
  if (!trimmed) return null;
  const parsed = Number.parseFloat(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

/** Alan bazında kısa uyarılar — dolu olan her anahtar o alanın altında gösterilir. */
export interface CostFieldErrors {
  filamentWeight?: string;
  printTimeHours?: string;
  wasteRate?: string;
  desi?: string;
}

/**
 * Geçersiz değeri KAYNAKTA yakalar.
 *
 * Sunucu fire oranını %100 ile sınırlar ve sınır aşılınca isteğin TAMAMINI reddeder — o an
 * formdaki hiçbir alan (gramaj, süre, desi…) kaydedilmez. Bu yüzden geçersiz alan varken istek
 * hiç gönderilmez; kullanıcı tek satırlık uyarıyı alanın altında görür.
 */
export function validateCostFields(fields: {
  filamentWeight: string;
  printTimeHours: string;
  wasteRate: string;
  desiInput: string;
}): CostFieldErrors {
  const errors: CostFieldErrors = {};
  /** Boş = kontrol edilecek bir şey yok; NaN = sayı değil. */
  const sayi = (text: string): number | null => {
    const trimmed = text.trim().replace(",", ".");
    if (!trimmed) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : NaN;
  };
  const denetle = (
    text: string,
    ad: string,
    ustSinir?: { limit: number; mesaj: string }
  ): string | undefined => {
    const value = sayi(text);
    if (value === null) return undefined;
    if (Number.isNaN(value)) return `${ad} için sayı gir`;
    if (value < 0) return `${ad} eksi olamaz`;
    if (ustSinir && value > ustSinir.limit) return ustSinir.mesaj;
    return undefined;
  };

  const weight = denetle(fields.filamentWeight, "Ağırlık");
  if (weight) errors.filamentWeight = weight;
  const time = denetle(fields.printTimeHours, "Süre");
  if (time) errors.printTimeHours = time;
  const waste = denetle(fields.wasteRate, "Fire", {
    limit: 100,
    mesaj: "Fire en fazla %100 olabilir",
  });
  if (waste) errors.wasteRate = waste;
  const desi = denetle(fields.desiInput, "Desi");
  if (desi) errors.desi = desi;
  return errors;
}

/** Kayıtlı maliyetin form değerleri karşılığı — seed, "değişti mi?" ve flush TEK kaynaktan. */
export function costValuesOf(saved: SavedCostSnapshot): CostValues {
  const c = saved.cost;
  return {
    filamentTypeId: c?.filamentTypeId || "",
    filamentWeight: c?.filamentWeight ?? 0,
    printTimeHours: c?.printTimeHours ?? 0,
    wasteRate: Number(c?.wasteRate) || 0,
    packagingOptionId: c?.packagingOptionId || "",
    nylonLevel: (c?.nylonLevel as NylonLevel) || "none",
    tapeUsed: Boolean(c?.tapeUsed),
    desi: saved.desi ?? null,
  };
}

/**
 * İki maliyet formu aynı mı? Tolerans şart: yüzde ↔ oran çevrimi (0,07 → 7 → 0,07) ondalık
 * artığı bırakıyor ve form açılır açılmaz "değişmiş" görünüp kendiliğinden kayıt tetikliyordu.
 */
export function costValuesEqual(a: CostValues | null, b: CostValues | null): boolean {
  if (!a || !b) return a === b;
  const yakin = (x: number, y: number) => Math.abs(x - y) < 1e-9;
  return (
    a.filamentTypeId === b.filamentTypeId &&
    yakin(a.filamentWeight, b.filamentWeight) &&
    yakin(a.printTimeHours, b.printTimeHours) &&
    yakin(a.wasteRate, b.wasteRate) &&
    a.packagingOptionId === b.packagingOptionId &&
    a.nylonLevel === b.nylonLevel &&
    a.tapeUsed === b.tapeUsed &&
    // Desi'de 0 ile "girilmedi" AYRI şeyler → null karşılaştırması sayıya düşürülmez.
    (a.desi === null || b.desi === null ? a.desi === b.desi : yakin(a.desi, b.desi))
  );
}

/** Döküm satırı — tutar zıplamadan akar (ayar değiştirirken hangi kalemin oynadığı görünür). */
function DokumSatiri({
  ad,
  tutar,
  isaret = "",
  className,
}: {
  ad: string;
  tutar: number;
  isaret?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex justify-between", className)}>
      <span>{ad}</span>
      <AnimatedNumber
        value={tutar}
        durationMs={260}
        format={(n) => `${isaret}${formatCurrency(n)}`}
      />
    </div>
  );
}

/** Form bölümü — kart açılırken kademeli girer. */
function Bolum({
  baslik,
  sag,
  gecikmeMs,
  children,
}: {
  baslik: string;
  sag?: ReactNode;
  gecikmeMs: number;
  children: ReactNode;
}) {
  return (
    <div
      className="space-y-3 animate-in fade-in slide-in-from-bottom-1 duration-500"
      style={{ animationDelay: `${gecikmeMs}ms`, animationFillMode: "both" }}
    >
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold text-primary">{baslik}</p>
        {sag}
      </div>
      {children}
    </div>
  );
}

/**
 * İZOLE maliyet formu (state colocation). Tüm input state'i BURADA local tutulur → tuşa basınca
 * yalnızca bu küçük kart render olur; ağır ürün-detay sayfası (3 platform kartı, grafikler) DEĞİL.
 * Değerler 250ms debounce'la parent'a bildirilir; canlı önizleme + otomatik kayıt onu kullanır.
 *
 * memo + sabit prop'lar: parent 250ms'de bir render olsa da bu form (kullanıcı yazmadıkça) yeniden
 * render OLMAZ → yazarken donma yok.
 */
function CostEditorImpl({
  productId,
  initial,
  filaments,
  packagingSettings,
  globalSettings,
  savePending,
  variantCount,
  applyPending,
  onApply,
  onChange,
  onFlush,
}: {
  productId: string;
  initial: CostInitial;
  filaments: FilamentType[];
  packagingSettings: PackagingSettings;
  globalSettings: Record<string, string>;
  savePending: boolean;
  variantCount: number;
  applyPending: boolean;
  onApply: () => void;
  onChange: (v: CostValues) => void;
  /** Form sökülürken (varyant değişimi / sayfadan çıkış) bekleyen kaydı hemen yazdırır. */
  onFlush: (productId: string, v: CostValues) => void;
}) {
  const [filamentTypeId, setFilamentTypeId] = useState(initial.filamentTypeId);
  const [filamentWeight, setFilamentWeight] = useState(initial.filamentWeight);
  const [printTimeHours, setPrintTimeHours] = useState(initial.printTimeHours);
  const [wasteRate, setWasteRate] = useState(initial.wasteRate);
  const [packagingOptionId, setPackagingOptionId] = useState(initial.packagingOptionId);
  const [nylonLevel, setNylonLevel] = useState<NylonLevel>(initial.nylonLevel);
  const [tapeUsed, setTapeUsed] = useState(initial.tapeUsed);
  const [desiInput, setDesiInput] = useState(initial.desiInput);

  // Kullanıcı bu formda gerçekten bir şey değiştirdi mi? Açılışta hiçbir alana dokunulmadan
  // kayıt tetiklenmesin (eskiden "Maliyet kaydedildi" bildirimi kendiliğinden çıkıyordu).
  const touchedRef = useRef(false);
  const touch = () => {
    touchedRef.current = true;
  };

  // ── Canlı maliyet (local, anında) ──
  const selectedFilament = filaments.find((f) => f.id === filamentTypeId);
  const costPerGram = selectedFilament?.costPerGram || 0;
  const fWeight = parseFloat(filamentWeight) || 0;
  const pTime = parseFloat(printTimeHours) || 0;
  const wRate = (parseFloat(wasteRate) || 0) / 100;
  const electricityRate =
    globalSettings.costElectricityIncluded === "true"
      ? parseFloat(globalSettings.costElectricityPerHour || "0")
      : 0;
  const machineWearRate = parseFloat(globalSettings.costMachineWearPerHour || "0");
  const laborRate = parseFloat(globalSettings.costLaborPerHour || "0");

  const packagingBreakdown = computePackagingCost(
    { packagingOptionId: packagingOptionId || null, nylonLevel, tapeUsed },
    packagingSettings
  );
  const tapeCostPerProduct =
    packagingSettings.tapeProductsPerRoll > 0
      ? packagingSettings.tapePrice / packagingSettings.tapeProductsPerRoll
      : 0;

  const calcFilament = fWeight * costPerGram;
  const calcElectricity = pTime * electricityRate;
  const calcMachineWear = pTime * machineWearRate;
  const calcLabor = pTime * laborRate;
  const printSubtotal = calcFilament + calcElectricity + calcMachineWear + calcLabor;
  const calcWaste = printSubtotal * wRate;
  const calcPackaging = packagingBreakdown.total;
  const calculatedTotalCost = printSubtotal + calcWaste + calcPackaging;
  const fixedExtras = packagingBreakdown.card + packagingBreakdown.sticker + packagingBreakdown.sakiz;

  // "Maliyet biliniyor mu?" kararı TEK kaynaktan (@/core). Paketleme her ürüne otomatik eklendiği
  // için toplam asla 0 olmaz; maliyet girilmemişken tutar göstermek "girildi" izlenimi veriyordu.
  const productionKnown =
    resolveProductCost(
      {
        costMode: "detailed",
        manualCost: null,
        totalCost: null,
        filamentWeight: fWeight,
        printTimeHours: pTime,
        wasteRate: wRate,
        packagingOptionId: packagingOptionId || null,
        nylonLevel,
        tapeUsed,
      },
      globalSettings,
      costPerGram
    )?.productionCostKnown ?? false;

  // ── Alan bazında doğrulama — geçersizken istek HİÇ gitmez ──
  const fieldErrors = validateCostFields({
    filamentWeight,
    printTimeHours,
    wasteRate,
    desiInput,
  });
  const hasFieldError = Object.keys(fieldErrors).length > 0;

  // ── 250ms debounce → parent'a bildir (canlı önizleme + otomatik kayıt parent'ta) ──
  const values = useMemo<CostValues>(
    () => ({
      filamentTypeId,
      filamentWeight: fWeight,
      printTimeHours: pTime,
      wasteRate: wRate,
      packagingOptionId,
      nylonLevel,
      tapeUsed,
      desi: parseDesiInput(desiInput),
    }),
    [filamentTypeId, fWeight, pTime, wRate, packagingOptionId, nylonLevel, tapeUsed, desiInput]
  );
  useEffect(() => {
    if (!touchedRef.current || hasFieldError) return;
    const t = setTimeout(() => onChange(values), 250);
    return () => clearTimeout(t);
  }, [values, onChange, hasFieldError]);

  // Sökülme anında (varyant değişimi / geri tuşu) bekleyen 250ms + parent'taki kayıt gecikmesi
  // birlikte ~1sn ediyordu; o süre dolmadan çıkınca değişiklik kayboluyordu. Son geçerli değerler
  // ref'te tutulup sökülürken FLUSH edilir.
  const pendingRef = useRef({ productId, values, valid: !hasFieldError, onFlush });
  useEffect(() => {
    pendingRef.current = { productId, values, valid: !hasFieldError, onFlush };
  });
  useEffect(
    () => () => {
      const p = pendingRef.current;
      if (!touchedRef.current || !p.valid) return;
      p.onFlush(p.productId, p.values);
    },
    []
  );

  // Başlıktaki tek satırlık durum — üç ayrı yerde tekrarlanan uyarıların yerini alır ve
  // toplam rakamla birlikte kart boyunca ekranda kalır.
  const durum = hasFieldError
    ? { metin: "Kırmızı alanı düzelt", renk: "text-destructive" }
    : !productionKnown
      ? { metin: "Filament ve ağırlık gir", renk: "text-amber-500" }
      : savePending
        ? { metin: "Kaydediliyor…", renk: "text-muted-foreground" }
        : { metin: "Otomatik kaydedilir", renk: "text-muted-foreground" };

  return (
    // overflow-visible ŞART: Card'ın varsayılan `overflow-hidden`'ı kartı kendi kaydırma kutusu
    // yapar ve içindeki sticky başlık yapışmaz (toplam ekrandan kaçardı).
    <Card
      className="overflow-visible animate-in fade-in slide-in-from-bottom-2 duration-500"
      style={{ animationFillMode: "both" }}
    >
      {/* Toplam BAŞLIĞA sabit: kartta aşağı inip gramaj/süre değiştirirken etkilenen rakam ekranda kalır. */}
      <CardHeader className="sticky top-0 z-20 -mt-4 pt-4 border-b border-border/60 bg-card/95 backdrop-blur-sm">
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <CardTitle className="text-sm">Üretim Maliyeti</CardTitle>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Kargo, komisyon ve KDV platform kartlarında.
            </p>
          </div>
          <div className="shrink-0 text-right">
            <AnimatedNumber
              /* BİLİNMEYEN ≠ SIFIR: hesaplanamıyorsa NaN → formatCurrency "—" yazar, 0 değil. */
              value={productionKnown ? calculatedTotalCost : NaN}
              durationMs={420}
              format={(n) => formatCurrency(n)}
              className={cn(
                "block text-xl font-bold tabular-nums leading-none transition-colors",
                productionKnown ? "text-foreground" : "text-muted-foreground"
              )}
            />
            <p className={cn("mt-1.5 text-[10px] leading-none", durum.renk)}>{durum.metin}</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Bolum baslik="3D BASKI" gecikmeMs={40}>
          <div>
            <Label className="text-xs">Filament Türü</Label>
            <select
              value={filamentTypeId}
              onChange={(e) => { touch(); setFilamentTypeId(e.target.value); }}
              className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Seçin...</option>
              {filaments.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name} ({formatCurrency(f.costPerGram)}/g)
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Ağırlık (g)</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={filamentWeight}
                onChange={(e) => { touch(); setFilamentWeight(e.target.value); }}
                aria-invalid={Boolean(fieldErrors.filamentWeight)}
              />
              {fieldErrors.filamentWeight && (
                <p className="text-[10px] text-destructive mt-1 animate-in fade-in slide-in-from-top-1 duration-200">{fieldErrors.filamentWeight}</p>
              )}
            </div>
            <div>
              <Label className="text-xs">Süre (saat)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={printTimeHours}
                onChange={(e) => { touch(); setPrintTimeHours(e.target.value); }}
                aria-invalid={Boolean(fieldErrors.printTimeHours)}
              />
              {fieldErrors.printTimeHours && (
                <p className="text-[10px] text-destructive mt-1 animate-in fade-in slide-in-from-top-1 duration-200">{fieldErrors.printTimeHours}</p>
              )}
            </div>
          </div>
          <div>
            <Label className="text-xs">Fire (%)</Label>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={wasteRate}
              onChange={(e) => { touch(); setWasteRate(e.target.value); }}
              aria-invalid={Boolean(fieldErrors.wasteRate)}
            />
            {fieldErrors.wasteRate && (
              <p className="text-[10px] text-destructive mt-1 animate-in fade-in slide-in-from-top-1 duration-200">{fieldErrors.wasteRate}</p>
            )}
          </div>
        </Bolum>

        <Separator />

        <Bolum
          baslik="PAKETLEME"
          gecikmeMs={110}
          sag={
            <Link
              href="/cost-templates"
              className="text-[10px] text-muted-foreground underline underline-offset-2 transition-colors hover:text-primary active:text-primary/70"
            >
              Fiyatları düzenle
            </Link>
          }
        >
          <div>
            <Label className="text-xs">Poşet / Koli</Label>
            <select
              value={packagingOptionId}
              onChange={(e) => { touch(); setPackagingOptionId(e.target.value); }}
              className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              <option value="">Yok</option>
              {packagingSettings.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name} ({formatCurrency(o.price)})
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="text-xs">Naylon</Label>
              <select
                value={nylonLevel}
                onChange={(e) => { touch(); setNylonLevel(e.target.value as NylonLevel); }}
                className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="none">Yok</option>
                <option value="low">Az ({packagingSettings.nylonLowGrams}g)</option>
                <option value="medium">Orta ({packagingSettings.nylonMediumGrams}g)</option>
                <option value="high">Çok ({packagingSettings.nylonHighGrams}g)</option>
              </select>
            </div>
            <div>
              <Label className="text-xs">Bant</Label>
              <select
                value={tapeUsed ? "yes" : "no"}
                onChange={(e) => { touch(); setTapeUsed(e.target.value === "yes"); }}
                className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="no">Yok</option>
                <option value="yes">Var ({formatCurrency(tapeCostPerProduct)})</option>
              </select>
            </div>
          </div>
          {fixedExtras > 0 && (
            <p className="text-[10px] text-muted-foreground animate-in fade-in duration-300">
              Kart, sticker ve sakız: {formatCurrency(fixedExtras)}
            </p>
          )}
        </Bolum>

        <Separator />

        <Bolum baslik="KARGO" gecikmeMs={180}>
          <div>
            <Label className="text-xs">Desi</Label>
            <Input
              type="number"
              min="0"
              step="0.1"
              value={desiInput}
              onChange={(e) => { touch(); setDesiInput(e.target.value); }}
              placeholder="örn. 2"
              aria-invalid={Boolean(fieldErrors.desi)}
            />
            {fieldErrors.desi ? (
              <p className="text-[10px] text-destructive mt-1 animate-in fade-in slide-in-from-top-1 duration-200">{fieldErrors.desi}</p>
            ) : (
              <p className="text-[10px] text-muted-foreground mt-1">
                Kargo ücreti desiye göre otomatik hesaplanır.
              </p>
            )}
          </div>
        </Bolum>

        <Separator />

        {/* Döküm — başlıktaki toplamın nereden geldiği. Rakamlar akar, ayar değiştirince zıplamaz. */}
        <div
          className="space-y-1 text-xs text-muted-foreground tabular-nums animate-in fade-in duration-500"
          style={{ animationDelay: "240ms", animationFillMode: "both" }}
        >
          <DokumSatiri ad="Malzeme" tutar={calcFilament} />
          <DokumSatiri ad="Elektrik" tutar={calcElectricity} />
          <DokumSatiri ad="Aşınma" tutar={calcMachineWear} />
          {calcLabor > 0 && <DokumSatiri ad="İşçilik" tutar={calcLabor} />}
          <DokumSatiri ad="Paketleme" tutar={calcPackaging} />
          {calcWaste > 0 && (
            <DokumSatiri ad="Fire" tutar={calcWaste} isaret="+" className="text-amber-500" />
          )}
        </div>

        {variantCount > 1 && (
          <Button
            size="sm"
            variant="outline"
            className="w-full transition-transform active:scale-[0.99]"
            onClick={onApply}
            disabled={applyPending}
            title="Bu maliyeti gruptaki tüm varyantlara yazar"
          >
            {applyPending ? "Uygulanıyor…" : `Tüm varyantlara uygula (${variantCount})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export const CostEditor = memo(CostEditorImpl);
