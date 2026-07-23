"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { computePackagingCost, type PackagingSettings, type NylonLevel } from "@/core/packaging";

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

/**
 * İZOLE maliyet formu (state colocation). Tüm input state'i BURADA local tutulur → tuşa basınca
 * yalnızca bu küçük kart render olur; ağır ürün-detay sayfası (3 platform kartı, grafikler) DEĞİL.
 * Değerler 250ms debounce'la parent'a bildirilir; canlı önizleme + otomatik kayıt onu kullanır.
 *
 * memo + sabit prop'lar: parent 250ms'de bir render olsa da bu form (kullanıcı yazmadıkça) yeniden
 * render OLMAZ → yazarken donma yok.
 */
function CostEditorImpl({
  initial,
  filaments,
  packagingSettings,
  globalSettings,
  savePending,
  variantCount,
  applyPending,
  onApply,
  onChange,
}: {
  initial: CostInitial;
  filaments: FilamentType[];
  packagingSettings: PackagingSettings;
  globalSettings: Record<string, string>;
  savePending: boolean;
  variantCount: number;
  applyPending: boolean;
  onApply: () => void;
  onChange: (v: CostValues) => void;
}) {
  const [filamentTypeId, setFilamentTypeId] = useState(initial.filamentTypeId);
  const [filamentWeight, setFilamentWeight] = useState(initial.filamentWeight);
  const [printTimeHours, setPrintTimeHours] = useState(initial.printTimeHours);
  const [wasteRate, setWasteRate] = useState(initial.wasteRate);
  const [packagingOptionId, setPackagingOptionId] = useState(initial.packagingOptionId);
  const [nylonLevel, setNylonLevel] = useState<NylonLevel>(initial.nylonLevel);
  const [tapeUsed, setTapeUsed] = useState(initial.tapeUsed);
  const [desiInput, setDesiInput] = useState(initial.desiInput);

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
      desi: parseFloat(desiInput) || null,
    }),
    [filamentTypeId, fWeight, pTime, wRate, packagingOptionId, nylonLevel, tapeUsed, desiInput]
  );
  useEffect(() => {
    const t = setTimeout(() => onChange(values), 250);
    return () => clearTimeout(t);
  }, [values, onChange]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Üretim Maliyeti</CardTitle>
        <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
          Filament + elektrik + paketleme. Kargo, komisyon ve KDV her platform için otomatik hesaplanır.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          <p className="text-xs font-semibold text-primary">3D BASKI</p>
          <div>
            <Label className="text-xs">Filament Türü</Label>
            <select
              value={filamentTypeId}
              onChange={(e) => setFilamentTypeId(e.target.value)}
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
                onChange={(e) => setFilamentWeight(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Süre (saat)</Label>
              <Input
                type="number"
                min="0"
                step="0.1"
                value={printTimeHours}
                onChange={(e) => setPrintTimeHours(e.target.value)}
              />
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
              onChange={(e) => setWasteRate(e.target.value)}
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs font-semibold text-primary">PAKETLEME</p>
            <Link
              href="/cost-templates"
              className="text-[10px] text-muted-foreground hover:text-primary underline underline-offset-2"
            >
              Fiyatları düzenle
            </Link>
          </div>
          <div>
            <Label className="text-xs">Poşet / Koli</Label>
            <select
              value={packagingOptionId}
              onChange={(e) => setPackagingOptionId(e.target.value)}
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
                onChange={(e) => setNylonLevel(e.target.value as NylonLevel)}
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
                onChange={(e) => setTapeUsed(e.target.value === "yes")}
                className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="no">Yok</option>
                <option value="yes">Var ({formatCurrency(tapeCostPerProduct)})</option>
              </select>
            </div>
          </div>
          {fixedExtras > 0 && (
            <p className="text-[10px] text-muted-foreground">
              + Kart/Sticker/Sakız birim toplamı: {formatCurrency(fixedExtras)} — seçilen kapsama göre
            </p>
          )}
        </div>

        <Separator />

        <div className="space-y-2">
          <p className="text-xs font-semibold text-primary">KARGO</p>
          <div>
            <Label className="text-xs">Desi</Label>
            <Input
              type="number"
              min="0"
              step="0.1"
              value={desiInput}
              onChange={(e) => setDesiInput(e.target.value)}
              placeholder="örn. 2"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Trendyol kargosu desi + barem&apos;e göre otomatik hesaplanır. Shopify kargosu Kargo
              Kuralları&apos;ndaki Shopify baremine göre.
            </p>
          </div>
        </div>

        <Separator />

        <div className="space-y-1 text-xs text-muted-foreground tabular-nums">
          <div className="flex justify-between">
            <span>Malzeme</span>
            <span>{formatCurrency(calcFilament)}</span>
          </div>
          <div className="flex justify-between">
            <span>Elektrik</span>
            <span>{formatCurrency(calcElectricity)}</span>
          </div>
          <div className="flex justify-between">
            <span>Aşınma</span>
            <span>{formatCurrency(calcMachineWear)}</span>
          </div>
          {calcLabor > 0 && (
            <div className="flex justify-between">
              <span>İşçilik</span>
              <span>{formatCurrency(calcLabor)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span>Paketleme</span>
            <span>{formatCurrency(calcPackaging)}</span>
          </div>
          {calcWaste > 0 && (
            <div className="flex justify-between text-amber-500">
              <span>Fire</span>
              <span>+{formatCurrency(calcWaste)}</span>
            </div>
          )}
        </div>

        <div className="flex justify-between items-baseline pt-1">
          <span className="text-xs font-semibold uppercase tracking-wider">Üretim Maliyeti</span>
          <span className="text-lg font-bold tabular-nums">{formatCurrency(calculatedTotalCost)}</span>
        </div>

        <p className="text-center text-[11px] text-muted-foreground pt-0.5 h-4">
          {savePending ? "Kaydediliyor…" : "✓ Değişiklikler otomatik kaydedilir"}
        </p>

        {variantCount > 1 && (
          <Button
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onApply}
            disabled={applyPending}
            title="Aynı varyant grubundaki tüm ürünlere bu maliyeti (ve desi) uygular"
          >
            {applyPending ? "Uygulanıyor..." : `Bu maliyeti tüm varyantlara uygula (${variantCount})`}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export const CostEditor = memo(CostEditorImpl);
