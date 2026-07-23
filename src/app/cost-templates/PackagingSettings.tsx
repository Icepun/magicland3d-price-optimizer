"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Plus, Trash2, Package, Scissors, StickyNote } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency } from "@/lib/utils";
import {
  parsePackagingSettings,
  type PackagingOption,
  type PackagingComponentKey,
  type PackagingScope,
} from "@/core/packaging";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

function genId() {
  return `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function PackagingSettings() {
  const { data: settings = {} } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });
  return (
    <PackagingSettingsForm
      key={JSON.stringify(settings)}
      settings={settings}
    />
  );
}

function PackagingSettingsForm({ settings }: { settings: Record<string, string> }) {
  const qc = useQueryClient();
  const [initial] = useState(() => parsePackagingSettings(settings));

  // Paketleme seçenekleri (controlled liste)
  const [options, setOptions] = useState<PackagingOption[]>(initial.options);
  // Naylon / Bant / Sabit ek maliyet alanları
  const [nylonRollPrice, setNylonRollPrice] = useState(initial.nylonRollPrice ? String(initial.nylonRollPrice) : "");
  const [nylonRollGrams, setNylonRollGrams] = useState(initial.nylonRollGrams ? String(initial.nylonRollGrams) : "");
  const [nylonLowGrams, setNylonLowGrams] = useState(String(initial.nylonLowGrams));
  const [nylonMediumGrams, setNylonMediumGrams] = useState(String(initial.nylonMediumGrams));
  const [nylonHighGrams, setNylonHighGrams] = useState(String(initial.nylonHighGrams));
  const [tapePrice, setTapePrice] = useState(initial.tapePrice ? String(initial.tapePrice) : "");
  const [tapeProductsPerRoll, setTapeProductsPerRoll] = useState(String(initial.tapeProductsPerRoll));
  const [cardQty, setCardQty] = useState(initial.cardQty ? String(initial.cardQty) : "");
  const [cardPrice, setCardPrice] = useState(initial.cardPrice ? String(initial.cardPrice) : "");
  const [stickerQty, setStickerQty] = useState(initial.stickerQty ? String(initial.stickerQty) : "");
  const [stickerPrice, setStickerPrice] = useState(initial.stickerPrice ? String(initial.stickerPrice) : "");
  const [sakizQty, setSakizQty] = useState(initial.sakizQty ? String(initial.sakizQty) : "");
  const [sakizPrice, setSakizPrice] = useState(initial.sakizPrice ? String(initial.sakizPrice) : "");
  const [scopes, setScopes] = useState(initial.scopes);

  const save = useMutation({
    mutationFn: (data: Record<string, string>) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      clearPricingQueryCache(qc);
      toast.success("Paketleme ayarları kaydedildi — tüm ürünlere uygulandı");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  const saveOptions = (next: PackagingOption[]) => {
    setOptions(next);
    save.mutate({ packagingOptions: JSON.stringify(next) });
  };

  const saveNumeric = () => {
    save.mutate({
      nylonRollPrice: nylonRollPrice || "0",
      nylonRollGrams: nylonRollGrams || "0",
      nylonLowGrams: nylonLowGrams || "10",
      nylonMediumGrams: nylonMediumGrams || "20",
      nylonHighGrams: nylonHighGrams || "30",
      tapePrice: tapePrice || "0",
      tapeProductsPerRoll: tapeProductsPerRoll || "20",
      cardQty: cardQty || "0",
      cardPrice: cardPrice || "0",
      stickerQty: stickerQty || "0",
      stickerPrice: stickerPrice || "0",
      sakizQty: sakizQty || "0",
      sakizPrice: sakizPrice || "0",
      packagingScopes: JSON.stringify(scopes),
    });
  };

  const setScope = (key: PackagingComponentKey, scope: PackagingScope) =>
    setScopes((current) => ({ ...current, [key]: scope }));

  const nylonPerGram =
    Number(nylonRollGrams) > 0 ? Number(nylonRollPrice) / Number(nylonRollGrams) : 0;
  const tapePerProduct =
    Number(tapeProductsPerRoll) > 0 ? Number(tapePrice) / Number(tapeProductsPerRoll) : 0;
  const cardPerUnit = Number(cardQty) > 0 ? Number(cardPrice) / Number(cardQty) : 0;
  const stickerPerUnit = Number(stickerQty) > 0 ? Number(stickerPrice) / Number(stickerQty) : 0;
  const sakizPerUnit = Number(sakizQty) > 0 ? Number(sakizPrice) / Number(sakizQty) : 0;
  const fixedTotal = cardPerUnit + stickerPerUnit + sakizPerUnit;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Paketleme Seçenekleri */}
      <Card className="lg:col-span-2">
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" /> Paketleme Seçenekleri (Poşet / Koli)
            </CardTitle>
            <CardDescription>
              Poşet ve kutu tiplerini fiyatlarıyla tanımla. Üründe sadece seçersin, fiyat
              buradan çekilir. Zam yapınca tüm ürünler otomatik güncellenir.
            </CardDescription>
          </div>
          <Button
            size="sm"
            onClick={() =>
              setOptions((prev) => [...prev, { id: genId(), name: "Yeni paketleme", price: 0 }])
            }
          >
            <Plus className="h-4 w-4 mr-1" /> Ekle
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {options.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              Henüz paketleme seçeneği yok. &quot;Ekle&quot; ile başla.
            </p>
          )}
          {options.map((opt, i) => (
            <div key={opt.id} className="flex items-center gap-2">
              <Input
                className="flex-1"
                value={opt.name}
                placeholder="Paketleme adı"
                onChange={(e) =>
                  setOptions((prev) =>
                    prev.map((o, idx) => (idx === i ? { ...o, name: e.target.value } : o))
                  )
                }
              />
              <div className="relative w-32">
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={opt.price || ""}
                  placeholder="0.00"
                  onChange={(e) =>
                    setOptions((prev) =>
                      prev.map((o, idx) =>
                        idx === i ? { ...o, price: parseFloat(e.target.value) || 0 } : o
                      )
                    )
                  }
                />
                <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                  TL
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="h-9 w-9 text-destructive shrink-0"
                onClick={() => setOptions((prev) => prev.filter((_, idx) => idx !== i))}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button
            className="w-full mt-2"
            onClick={() => saveOptions(options)}
            disabled={save.isPending}
          >
            {save.isPending ? "Kaydediliyor..." : "Paketleme Seçeneklerini Kaydet"}
          </Button>
        </CardContent>
      </Card>

      {/* Naylon */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Scissors className="h-5 w-5 text-primary" /> Naylon
          </CardTitle>
          <CardDescription>
            1 top naylonun fiyatı + kaç gram olduğunu gir; gram başı maliyet otomatik
            hesaplanır. Üründe Az/Orta/Çok seçilir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">1 Top Fiyatı (TL)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={nylonRollPrice}
                onChange={(e) => setNylonRollPrice(e.target.value)}
                placeholder="örn. 250"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">1 Top Gram</Label>
              <Input
                type="number"
                min="0"
                step="1"
                value={nylonRollGrams}
                onChange={(e) => setNylonRollGrams(e.target.value)}
                placeholder="örn. 2000"
              />
            </div>
          </div>
          {nylonPerGram > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Gram başı: <strong>{formatCurrency(nylonPerGram)}</strong>/g
            </p>
          )}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Az (g)</Label>
              <Input type="number" min="0" value={nylonLowGrams} onChange={(e) => setNylonLowGrams(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Orta (g)</Label>
              <Input type="number" min="0" value={nylonMediumGrams} onChange={(e) => setNylonMediumGrams(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Çok (g)</Label>
              <Input type="number" min="0" value={nylonHighGrams} onChange={(e) => setNylonHighGrams(e.target.value)} />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bant */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Scissors className="h-5 w-5 text-primary rotate-90" /> Bant
          </CardTitle>
          <CardDescription>
            1 bant fiyatı + kaç ürüne yettiğini gir. Üründe &quot;Var/Yok&quot; seçilir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">1 Bant Fiyatı (TL)</Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={tapePrice}
                onChange={(e) => setTapePrice(e.target.value)}
                placeholder="örn. 40"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kaç Ürüne Yetiyor</Label>
              <Input
                type="number"
                min="1"
                step="1"
                value={tapeProductsPerRoll}
                onChange={(e) => setTapeProductsPerRoll(e.target.value)}
                placeholder="20"
              />
            </div>
          </div>
          {tapePerProduct > 0 && (
            <p className="text-[11px] text-muted-foreground">
              Ürün başı: <strong>{formatCurrency(tapePerProduct)}</strong>
            </p>
          )}
        </CardContent>
      </Card>

      {/* Hesaplama kapsamları */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg">Paketleme Hesaplama Kapsamı</CardTitle>
          <CardDescription>
            Çok adetli siparişlerde hangi kalemin her üründe, siparişte bir kez veya
            gönderide bir kez uygulanacağını seç.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {([
            ["option", "Poşet / Kutu"],
            ["nylon", "Naylon"],
            ["tape", "Bant"],
            ["card", "Kart"],
            ["sticker", "Sticker"],
            ["sakiz", "Sakız"],
          ] as Array<[PackagingComponentKey, string]>).map(([key, label]) => (
            <div key={key} className="space-y-1 rounded-lg border bg-muted/20 p-3">
              <Label className="text-xs">{label}</Label>
              <select
                value={scopes[key]}
                onChange={(event) => setScope(key, event.target.value as PackagingScope)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              >
                <option value="per_unit">Ürün başına</option>
                <option value="per_order">Sipariş başına</option>
                <option value="per_shipment">Gönderi başına</option>
              </select>
            </div>
          ))}
          <Button
            className="sm:col-span-2 lg:col-span-3"
            onClick={saveNumeric}
            disabled={save.isPending}
          >
            {save.isPending ? "Kaydediliyor..." : "Paketleme Kapsamlarını Kaydet"}
          </Button>
        </CardContent>
      </Card>

      {/* Sabit Ek Maliyetler */}
      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <StickyNote className="h-5 w-5 text-primary" /> Sabit Ek Maliyetler (Kart / Sticker / Sakız)
          </CardTitle>
          <CardDescription>
            &quot;Kaç adet aldın / kaç TL ödedin&quot; gir; birim maliyet hesaplanır ve yukarıdaki
            seçtiğin kapsama göre siparişe uygulanır.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {[
              { label: "Kart", qty: cardQty, setQty: setCardQty, price: cardPrice, setPrice: setCardPrice, unit: cardPerUnit },
              { label: "Sticker", qty: stickerQty, setQty: setStickerQty, price: stickerPrice, setPrice: setStickerPrice, unit: stickerPerUnit },
              { label: "Sakız", qty: sakizQty, setQty: setSakizQty, price: sakizPrice, setPrice: setSakizPrice, unit: sakizPerUnit },
            ].map((row) => (
              <div key={row.label} className="space-y-2 p-3 rounded-lg border bg-muted/20">
                <p className="text-sm font-semibold">{row.label}</p>
                <div className="space-y-1">
                  <Label className="text-xs">Adet</Label>
                  <Input
                    type="number"
                    min="0"
                    step="1"
                    value={row.qty}
                    onChange={(e) => row.setQty(e.target.value)}
                    placeholder="örn. 100"
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Toplam Fiyat (TL)</Label>
                  <Input
                    type="number"
                    min="0"
                    step="0.01"
                    value={row.price}
                    onChange={(e) => row.setPrice(e.target.value)}
                    placeholder="örn. 50"
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Adet başı: <strong>{formatCurrency(row.unit)}</strong>
                </p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-lg bg-primary/5 border border-primary/20 px-4 py-2.5">
            <span className="text-sm font-medium">Kart / sticker / sakız birim maliyeti toplamı</span>
            <span className="text-lg font-bold tabular-nums text-primary">{formatCurrency(fixedTotal)}</span>
          </div>
          <Button className="w-full" onClick={saveNumeric} disabled={save.isPending}>
            {save.isPending ? "Kaydediliyor..." : "Naylon / Bant / Ek Maliyetleri Kaydet"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
