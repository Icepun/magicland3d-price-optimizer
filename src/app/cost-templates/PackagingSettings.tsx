"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Plus, RefreshCw, Trash2, Package, Scissors, StickyNote } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import {
  parsePackagingSettings,
  type PackagingComponentKey,
  type PackagingScope,
} from "@/core/packaging";
import { fetchJson } from "@/lib/fetch-json";
import { useKayitBolumu } from "./kaydet-cubugu";

function genId() {
  return `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

const KART = "rounded-2xl border-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none";
const GIRDI = "rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25";

/** "1,5" → 1.5 · boş/geçersiz → null. */
function sayi(metin: string): number | null {
  const t = metin.trim().replace(",", ".");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}
/** Kaydedilecek metin: boşsa varsayılan, değilse sayının kendisi (virgül noktaya). */
const kayitMetni = (metin: string, varsayilan: string) => {
  const n = sayi(metin);
  return n == null ? varsayilan : String(n);
};

/**
 * Formun TÜM alanları METİN olarak tutulur — sayıya ancak kaydederken çevrilir. Eskiden poşet fiyatı
 * sayı olarak tutuluyordu: "0" yazınca alan boşalıyor, "0,05" girişi 5 TL kaydedilebiliyordu.
 */
interface PaketFormu {
  options: { id: string; name: string; fiyat: string }[];
  nylonRollPrice: string;
  nylonRollGrams: string;
  nylonLowGrams: string;
  nylonMediumGrams: string;
  nylonHighGrams: string;
  tapePrice: string;
  tapeProductsPerRoll: string;
  cardQty: string;
  cardPrice: string;
  stickerQty: string;
  stickerPrice: string;
  sakizQty: string;
  sakizPrice: string;
  scopes: Record<PackagingComponentKey, PackagingScope>;
}
type MetinAlani = Exclude<keyof PaketFormu, "options" | "scopes">;

function formdan(ayarlar: Record<string, string>): PaketFormu {
  const p = parsePackagingSettings(ayarlar);
  const m = (n: number) => (n ? String(n) : "");
  return {
    options: p.options.map((o) => ({ id: o.id, name: o.name, fiyat: String(o.price ?? 0) })),
    nylonRollPrice: m(p.nylonRollPrice),
    nylonRollGrams: m(p.nylonRollGrams),
    nylonLowGrams: String(p.nylonLowGrams),
    nylonMediumGrams: String(p.nylonMediumGrams),
    nylonHighGrams: String(p.nylonHighGrams),
    tapePrice: m(p.tapePrice),
    tapeProductsPerRoll: String(p.tapeProductsPerRoll),
    cardQty: m(p.cardQty),
    cardPrice: m(p.cardPrice),
    stickerQty: m(p.stickerQty),
    stickerPrice: m(p.stickerPrice),
    sakizQty: m(p.sakizQty),
    sakizPrice: m(p.sakizPrice),
    scopes: { ...p.scopes },
  };
}

/** Kaydedilecek AppSetting değerleri (anahtar → metin). */
function degerler(f: PaketFormu): Record<string, string> {
  return {
    packagingOptions: JSON.stringify(f.options.map((o) => ({ id: o.id, name: o.name, price: sayi(o.fiyat) ?? 0 }))),
    nylonRollPrice: kayitMetni(f.nylonRollPrice, "0"),
    nylonRollGrams: kayitMetni(f.nylonRollGrams, "0"),
    nylonLowGrams: kayitMetni(f.nylonLowGrams, "10"),
    nylonMediumGrams: kayitMetni(f.nylonMediumGrams, "20"),
    nylonHighGrams: kayitMetni(f.nylonHighGrams, "30"),
    tapePrice: kayitMetni(f.tapePrice, "0"),
    tapeProductsPerRoll: kayitMetni(f.tapeProductsPerRoll, "20"),
    cardQty: kayitMetni(f.cardQty, "0"),
    cardPrice: kayitMetni(f.cardPrice, "0"),
    stickerQty: kayitMetni(f.stickerQty, "0"),
    stickerPrice: kayitMetni(f.stickerPrice, "0"),
    sakizQty: kayitMetni(f.sakizQty, "0"),
    sakizPrice: kayitMetni(f.sakizPrice, "0"),
    packagingScopes: JSON.stringify(f.scopes),
  };
}

/** Metin alanı — sayı klavyesi, virgül de kabul ("0," yazarken alan silinmez). */
function SayiAlani({ deger, onChange, placeholder, sag }: { deger: string; onChange: (v: string) => void; placeholder?: string; sag?: string }) {
  return (
    <div className="relative">
      <Input
        type="text"
        inputMode="decimal"
        className={cn(GIRDI, sag && "pr-8")}
        value={deger}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {sag && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{sag}</span>}
    </div>
  );
}

export function PackagingSettings() {
  const { data: settings, isLoading, isError, isFetching, refetch } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });
  // Veri GELMEDEN form açılmaz: eskiden ayarlar okunamayınca form varsayılan/sıfır değerlerle açılıyor,
  // tek alan değiştirip kaydetmek bütün paketleme fiyatlarını sıfırla eziyordu (denetim, 23 Kas 2026).
  if (isLoading && !settings) {
    return (
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Skeleton className="h-[260px] w-full rounded-2xl lg:col-span-2" />
        <Skeleton className="h-[220px] w-full rounded-2xl" />
        <Skeleton className="h-[220px] w-full rounded-2xl" />
      </div>
    );
  }
  if (!settings) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-2xl bg-rose-500/[0.05] px-4 py-10 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
        <AlertTriangle className="h-8 w-8 text-rose-300/80" />
        <p className="font-medium">Paketleme ayarları yüklenemedi</p>
        <p className="text-sm text-muted-foreground">Bağlantını kontrol edip tekrar dene.</p>
        <Button variant="outline" size="sm" className="gap-1.5" disabled={isFetching} onClick={() => void refetch()}>
          <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} /> Tekrar dene
        </Button>
      </div>
    );
  }
  return <PackagingSettingsForm settings={settings} yenilenemedi={isError} />;
}

function PackagingSettingsForm({ settings, yenilenemedi }: { settings: Record<string, string>; yenilenemedi: boolean }) {
  const sunucu = formdan(settings);
  const sunucuImza = JSON.stringify(degerler(sunucu));
  const [baz, setBaz] = useState<PaketFormu>(sunucu);
  const [f, setF] = useState<PaketFormu>(sunucu);
  const bazDeger = degerler(baz);
  const simdi = degerler(f);
  const degisen = Object.fromEntries(Object.entries(simdi).filter(([k, v]) => bazDeger[k] !== v));
  const kirli = Object.keys(degisen).length > 0;

  /**
   * Sunucudan yeni değer gelince (kayıt sonrası / başka cihaz) form YENİDEN KURULMAZ: kaydedilmemiş
   * değişiklik varsa korunur, yoksa yeni değerler gösterilir. Eskiden form her ayar değişikliğinde
   * baştan kuruluyordu — filament eklemek bile yazılanları siliyordu.
   */
  const [izlenen, setIzlenen] = useState(sunucuImza);
  if (izlenen !== sunucuImza) {
    setIzlenen(sunucuImza);
    setBaz(sunucu);
    if (!kirli) setF(sunucu);
  }

  useKayitBolumu("paketleme", {
    etiket: "Paketleme ve ek maliyetler",
    kirli,
    degisiklikler: () => degisen,
    vazgec: () => setF(baz),
    // Yalnız GÖNDERİLEN değerler kayıtlı sayılır (kayıt sürerken yazılan kirli kalır).
    kaydedildi: (gonderilen) => {
      const giden = new Set(Object.keys(gonderilen));
      setBaz((b) => {
        const yeni: PaketFormu = { ...b };
        if (giden.has("packagingOptions")) yeni.options = f.options.map((o) => ({ ...o }));
        if (giden.has("packagingScopes")) yeni.scopes = { ...f.scopes };
        for (const k of Object.keys(f) as (keyof PaketFormu)[]) {
          if (k === "options" || k === "scopes" || !giden.has(k)) continue;
          yeni[k] = f[k];
        }
        return yeni;
      });
    },
  });

  // Silme onayı: o seçeneği kullanan ürün varsa sorulur.
  const { data: kullanim } = useQuery<Record<string, number>>({
    queryKey: ["paketleme-kullanimi"],
    queryFn: () => fetchJson("/api/settings/paketleme-kullanimi"),
    staleTime: 60_000,
  });
  const [silinecek, setSilinecek] = useState<string | null>(null);

  const metin = (k: MetinAlani, v: string) => setF((o) => ({ ...o, [k]: v }));
  const secenekler = (v: PaketFormu["options"]) => setF((o) => ({ ...o, options: v }));
  const setScope = (key: PackagingComponentKey, scope: PackagingScope) =>
    setF((o) => ({ ...o, scopes: { ...o.scopes, [key]: scope } }));

  const n = (m: string) => sayi(m) ?? 0;
  const nylonPerGram = n(f.nylonRollGrams) > 0 ? n(f.nylonRollPrice) / n(f.nylonRollGrams) : 0;
  const tapeUrun = n(f.tapeProductsPerRoll) > 0 ? n(f.tapeProductsPerRoll) : 20;
  const tapePerProduct = n(f.tapePrice) / tapeUrun;
  const cardPerUnit = n(f.cardQty) > 0 ? n(f.cardPrice) / n(f.cardQty) : 0;
  const stickerPerUnit = n(f.stickerQty) > 0 ? n(f.stickerPrice) / n(f.stickerQty) : 0;
  const sakizPerUnit = n(f.sakizQty) > 0 ? n(f.sakizPrice) / n(f.sakizQty) : 0;
  const fixedTotal = cardPerUnit + stickerPerUnit + sakizPerUnit;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {yenilenemedi && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-[#C9D2F2] lg:col-span-2">
          <AlertTriangle className="h-3.5 w-3.5 text-[#A9AEFF]" /> Ayarlar güncellenemedi — son alınan gösteriliyor.
        </p>
      )}
      {/* Paketleme Seçenekleri */}
      <Card className={cn(KART, "lg:col-span-2")}>
        <CardHeader className="flex flex-row items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" /> Paketleme Seçenekleri (Poşet / Koli)
            </CardTitle>
            <CardDescription>
              Poşet ve kutu tiplerini fiyatlarıyla tanımla. Üründe sadece seçersin, fiyat buradan çekilir.
            </CardDescription>
          </div>
          <Button
            size="sm"
            className="h-8 gap-1 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] px-3 text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.97] motion-reduce:hover:translate-y-0"
            onClick={() => secenekler([...f.options, { id: genId(), name: "Yeni paketleme", fiyat: "0" }])}
          >
            <Plus className="h-4 w-4" /> Ekle
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {f.options.length === 0 && (
            <p className="text-sm text-muted-foreground py-2">Henüz paketleme seçeneği yok. &quot;Ekle&quot; ile başla.</p>
          )}
          {f.options.map((opt, i) => {
            const kullanan = kullanim?.[opt.id] ?? 0;
            return (
              <div key={opt.id} className="space-y-1.5 animate-in fade-in slide-in-from-left-1 duration-300">
                <div className="flex items-center gap-2">
                  <Input
                    className={cn(GIRDI, "flex-1")}
                    value={opt.name}
                    placeholder="Paketleme adı"
                    onChange={(e) => secenekler(f.options.map((o, idx) => (idx === i ? { ...o, name: e.target.value } : o)))}
                  />
                  <div className="w-32">
                    <SayiAlani
                      deger={opt.fiyat}
                      placeholder="0"
                      sag="TL"
                      onChange={(v) => secenekler(f.options.map((o, idx) => (idx === i ? { ...o, fiyat: v } : o)))}
                    />
                  </div>
                  {kullanan > 0 && (
                    <span className="hidden w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground sm:block" title="Bu seçeneği kullanan ürün sayısı">
                      {kullanan} ürün
                    </span>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 rounded-lg text-rose-400 transition hover:bg-rose-500/10 hover:text-rose-300 active:scale-95"
                    title="Sil"
                    onClick={() => {
                      if (kullanan > 0) setSilinecek(opt.id);
                      else secenekler(f.options.filter((_, idx) => idx !== i));
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                {/* Kullanılan seçenek silinirken SOR: o ürünlerin poşet maliyeti "eksik" olur. */}
                {silinecek === opt.id && (
                  <div className="flex flex-wrap items-center gap-2 rounded-xl bg-rose-500/[0.07] px-3 py-2 text-xs ring-1 ring-rose-400/25 animate-in fade-in slide-in-from-top-1 duration-200">
                    <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-rose-300" />
                    <span className="min-w-0 flex-1">
                      Bu seçeneği <strong>{kullanan} ürün</strong>{" "}kullanıyor. Silersen o ürünlerin maliyeti &quot;eksik&quot; görünür, yenisini seçmen gerekir.
                    </span>
                    <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setSilinecek(null)}>
                      Vazgeç
                    </Button>
                    <Button
                      size="sm"
                      className="h-7 bg-rose-500 text-xs text-white hover:bg-rose-500/90"
                      onClick={() => {
                        secenekler(f.options.filter((o) => o.id !== opt.id));
                        setSilinecek(null);
                      }}
                    >
                      Yine de sil
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Naylon */}
      <Card className={KART} style={{ animationDelay: "70ms" }}>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Scissors className="h-5 w-5 text-primary" /> Naylon
          </CardTitle>
          <CardDescription>
            1 top naylonun fiyatı + kaç gram olduğunu gir; gram başı maliyet otomatik hesaplanır. Üründe Az/Orta/Çok seçilir.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">1 Top Fiyatı (TL)</Label>
              <SayiAlani deger={f.nylonRollPrice} onChange={(v) => metin("nylonRollPrice", v)} placeholder="örn. 250" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">1 Top Gram</Label>
              <SayiAlani deger={f.nylonRollGrams} onChange={(v) => metin("nylonRollGrams", v)} placeholder="örn. 2000" />
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
              <SayiAlani deger={f.nylonLowGrams} onChange={(v) => metin("nylonLowGrams", v)} placeholder="boşsa 10" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Orta (g)</Label>
              <SayiAlani deger={f.nylonMediumGrams} onChange={(v) => metin("nylonMediumGrams", v)} placeholder="boşsa 20" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Çok (g)</Label>
              <SayiAlani deger={f.nylonHighGrams} onChange={(v) => metin("nylonHighGrams", v)} placeholder="boşsa 30" />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Bant */}
      <Card className={KART} style={{ animationDelay: "140ms" }}>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Scissors className="h-5 w-5 text-primary rotate-90" /> Bant
          </CardTitle>
          <CardDescription>1 bant fiyatı + kaç ürüne yettiğini gir. Üründe &quot;Var/Yok&quot; seçilir.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">1 Bant Fiyatı (TL)</Label>
              <SayiAlani deger={f.tapePrice} onChange={(v) => metin("tapePrice", v)} placeholder="örn. 40" />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Kaç Ürüne Yetiyor</Label>
              <SayiAlani deger={f.tapeProductsPerRoll} onChange={(v) => metin("tapeProductsPerRoll", v)} placeholder="boşsa 20" />
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
      <Card className={cn(KART, "lg:col-span-2")} style={{ animationDelay: "210ms" }}>
        <CardHeader>
          <CardTitle className="text-lg">Paketleme Hesaplama Kapsamı</CardTitle>
          <CardDescription>
            Çok adetli siparişlerde hangi kalemin her üründe, siparişte bir kez veya gönderide bir kez uygulanacağını seç.
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
            <div key={key} className="space-y-1.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 transition-colors hover:bg-white/[0.04]">
              <Label className="text-xs">{label}</Label>
              <select
                value={f.scopes[key]}
                onChange={(event) => setScope(key, event.target.value as PackagingScope)}
                className="h-9 w-full cursor-pointer rounded-xl border border-white/[0.08] bg-white/[0.03] px-2 text-sm outline-none transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-2 focus-visible:ring-[#7A7EFF]/25"
              >
                <option value="per_unit">Ürün başına</option>
                <option value="per_order">Sipariş başına</option>
                <option value="per_shipment">Gönderi başına</option>
              </select>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Sabit Ek Maliyetler */}
      <Card className={cn(KART, "lg:col-span-2")} style={{ animationDelay: "280ms" }}>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <StickyNote className="h-5 w-5 text-primary" /> Sabit Ek Maliyetler (Kart / Sticker / Sakız)
          </CardTitle>
          <CardDescription>
            &quot;Kaç adet aldın / kaç TL ödedin&quot; gir; birim maliyet hesaplanır ve yukarıdaki seçtiğin kapsama göre siparişe uygulanır.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {([
              { label: "Kart", qty: "cardQty", price: "cardPrice", unit: cardPerUnit },
              { label: "Sticker", qty: "stickerQty", price: "stickerPrice", unit: stickerPerUnit },
              { label: "Sakız", qty: "sakizQty", price: "sakizPrice", unit: sakizPerUnit },
            ] as const).map((row) => (
              <div key={row.label} className="space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 transition-colors hover:bg-white/[0.04]">
                <p className="text-sm font-semibold">{row.label}</p>
                <div className="space-y-1">
                  <Label className="text-xs">Adet</Label>
                  <SayiAlani deger={f[row.qty]} onChange={(v) => metin(row.qty, v)} placeholder="örn. 100" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Toplam Fiyat (TL)</Label>
                  <SayiAlani deger={f[row.price]} onChange={(v) => metin(row.price, v)} placeholder="örn. 50" />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Adet başı: <strong>{formatCurrency(row.unit)}</strong>
                </p>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between rounded-xl bg-gradient-to-r from-[#9B5CFF]/12 to-[#4F8CFF]/[0.06] px-4 py-2.5 ring-1 ring-[#7A7EFF]/25">
            <span className="text-sm font-medium">Kart / sticker / sakız birim maliyeti toplamı</span>
            <span className="text-lg font-semibold tabular-nums text-[#C9D2F2]">{formatCurrency(fixedTotal)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
