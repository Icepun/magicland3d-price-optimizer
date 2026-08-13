"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatCurrency } from "@/lib/utils";
import { KATEGORI_RENKLERI } from "@/lib/expense-admin-shared";

/**
 * Gider Ödemeleri sayfasının yönetim ekranları: kategoriler ve tekrarlayan sabit giderler.
 * Saf sunum; veri türetmesi yok.
 */

const ALAN =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm outline-none " +
  "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50";

export interface KategoriKaydi {
  id: string;
  name: string;
  color: string | null;
  sortOrder: number;
}

/**
 * Kategorileri kullanıcı belirler; grafik rengi de burada seçilir.
 *
 * Kategori kaldırmak GEÇMİŞ HARCAMAYI SİLMEZ — gider kayıtlarındaki kategori metni yerinde
 * kalır. Aksi hâlde "geçen yıl reklama ne verdim" sorusu cevapsız kalırdı.
 */
export function KategoriYonetimi({
  kategoriler,
  pending,
  onEkle,
  onSil,
}: {
  kategoriler: KategoriKaydi[];
  pending: boolean;
  onEkle: (name: string, color: string) => void;
  onSil: (id: string) => void;
}) {
  const [ad, setAd] = useState("");
  const [renk, setRenk] = useState(KATEGORI_RENKLERI[0]);
  const temiz = ad.trim();

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-2">
        <div className="flex-1 min-w-0">
          <label className="text-[11px] text-muted-foreground">Kategori adı</label>
          <input
            value={ad}
            maxLength={60}
            placeholder="Örn. Kira"
            onChange={(e) => setAd(e.target.value)}
            className={ALAN}
          />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {KATEGORI_RENKLERI.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRenk(r)}
              aria-label="Renk seç"
              className={cn(
                "h-7 w-7 rounded-full border-2 transition-transform active:scale-90",
                renk === r ? "border-foreground scale-110" : "border-transparent"
              )}
              style={{ background: r }}
            />
          ))}
        </div>
        <Button
          size="sm"
          className="h-9 shrink-0"
          disabled={!temiz || pending}
          onClick={() => {
            onEkle(temiz, renk);
            setAd("");
          }}
        >
          Ekle
        </Button>
      </div>

      {kategoriler.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Henüz kategori yok. Ekledikçe grafik renklenir.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-[320px] overflow-y-auto">
          {kategoriler.map((k) => (
            <div key={k.id} className="flex items-center gap-2 rounded-lg border p-2">
              <span
                className="h-3 w-3 shrink-0 rounded-full"
                style={{ background: k.color ?? KATEGORI_RENKLERI[0] }}
                aria-hidden
              />
              <span className="text-sm flex-1 truncate">{k.name}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive"
                disabled={pending}
                onClick={() => onSil(k.id)}
              >
                Kaldır
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Kategoriyi kaldırmak geçmiş ödemeleri silmez.
      </p>
    </div>
  );
}

export interface TekrarKaydi {
  id: string;
  name: string;
  category: string | null;
  amount: number;
  dayOfMonth: number;
  isActive: boolean;
}

/**
 * Her ay tekrarlayan sabit giderler.
 *
 * ⚠️ Buraya eklenen kayıt, ödeme günü gelince gider listesine KENDİLİĞİNDEN düşer ve o ayın
 * net kârından iner. Günü gelmemiş ay yazılmaz; aynı ay iki kez yazılmaz.
 */
export function SabitGiderYonetimi({
  kayitlar,
  kategoriler,
  pending,
  onEkle,
  onSil,
}: {
  kayitlar: TekrarKaydi[];
  kategoriler: KategoriKaydi[];
  pending: boolean;
  onEkle: (v: {
    name: string;
    category: string | null;
    amount: number;
    dayOfMonth: number;
  }) => void;
  onSil: (id: string) => void;
}) {
  const [ad, setAd] = useState("");
  const [tutar, setTutar] = useState("");
  const [gun, setGun] = useState("1");
  const [kategori, setKategori] = useState("");
  const tutarSayi = Number(tutar);
  const gecerli = ad.trim().length > 0 && Number.isFinite(tutarSayi) && tutarSayi > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label className="text-[11px] text-muted-foreground">Gider adı</label>
          <input
            value={ad}
            maxLength={120}
            placeholder="Örn. Muhasebe"
            onChange={(e) => setAd(e.target.value)}
            className={ALAN}
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Tutar (TL)</label>
          <input
            value={tutar}
            type="number"
            min="0.01"
            step="0.01"
            inputMode="decimal"
            placeholder="0,00"
            onChange={(e) => setTutar(e.target.value)}
            className={ALAN}
          />
        </div>
        <div>
          <label className="text-[11px] text-muted-foreground">Ayın kaçında</label>
          <input
            value={gun}
            type="number"
            min="1"
            max="31"
            onChange={(e) => setGun(e.target.value)}
            className={ALAN}
          />
        </div>
        <div className="sm:col-span-2">
          <label className="text-[11px] text-muted-foreground">Kategori</label>
          <select
            value={kategori}
            onChange={(e) => setKategori(e.target.value)}
            className={ALAN}
          >
            <option value="">Kategorisiz</option>
            {kategoriler.map((k) => (
              <option key={k.id} value={k.name}>
                {k.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Button
        size="sm"
        className="w-full"
        disabled={!gecerli || pending}
        onClick={() => {
          onEkle({
            name: ad.trim(),
            category: kategori || null,
            amount: tutarSayi,
            dayOfMonth: Math.min(31, Math.max(1, Number(gun) || 1)),
          });
          setAd("");
          setTutar("");
        }}
      >
        Sabit gider ekle
      </Button>

      {kayitlar.length === 0 ? (
        <p className="text-sm text-muted-foreground py-4 text-center">
          Henüz sabit gider yok. Eklediğinde her ay kendiliğinden listene düşer.
        </p>
      ) : (
        <div className="space-y-1.5 max-h-[280px] overflow-y-auto">
          {kayitlar.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded-lg border p-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate">{r.name}</p>
                <p className="text-[11px] text-muted-foreground tabular-nums">
                  {`Her ayın ${r.dayOfMonth}. günü · ${formatCurrency(r.amount)}`}
                  {r.category ? ` · ${r.category}` : ""}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs text-destructive shrink-0"
                disabled={pending}
                onClick={() => onSil(r.id)}
              >
                Kaldır
              </Button>
            </div>
          ))}
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Ödeme günü gelince listene otomatik eklenir. Kaldırmak geçmiş ödemeleri silmez.
      </p>
    </div>
  );
}
