"use client";

/**
 * REKLAM BÜTÇESİ KARTI — platform başına günlük reklam harcaması.
 *
 * Bu tutar Giderler listesine YAZILMAZ; doğrudan ürün/sipariş maliyetine yedirilir (kullanıcı
 * kararı: tek yerde sayılsın, rapor net kârından bir kez daha düşülmesin). Kart bu yüzden
 * "gider ekleme" değil, "kâr hesabına giren oran" olarak anlatılır.
 *
 * Dağıtım ciroya orantılıdır: günlük tutarı gün içi sipariş sayısına bölmek ölçüldüğünde
 * aynı ürüne 15 kat farklı pay bindiriyordu (bkz. `core/ad-cost.ts`).
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { trTutarOku } from "@/core/tr-sayi";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Megaphone, TriangleAlert, Loader2, RefreshCw } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

/**
 * "all" en üstte: marka reklamı tek kanala yüklenemez — reklamı görüp mağazaya giren müşteri
 * Trendyol'dan da alabilir (kullanıcı kararı). Paydası TOPLAM ciro.
 * Platform satırları isteğe bağlı: bir kanala AYRICA reklam verilirse üstüne eklenir.
 */
const PLATFORMLAR = [
  { id: "all", ad: "Tüm platformlar", renk: "text-primary" },
  { id: "trendyol", ad: "Trendyol", renk: "text-[#F27A1A]" },
  { id: "shopify", ad: "Shopify", renk: "text-emerald-500" },
  { id: "hepsiburada", ad: "Hepsiburada", renk: "text-[#4F8CFF]" },
] as const;

interface Butce {
  id: string;
  platform: string;
  dailyAmount: number;
  validFrom: string;
  validTo: string | null;
  isActive: boolean;
}
interface Oran {
  oran: number;
  yuzde: number;
  toplamHarcama: number;
  guvenilir: boolean;
  cirodanBuyuk: boolean;
}
interface Yanit {
  butceler: Butce[];
  oranlar: Record<string, Oran>;
  pencereGun: number;
}
/** Kayıt yanıtı: kaç siparişin kârı arkada yeniden hesaplanacak. */
interface KayitYaniti {
  yenidenHesap?: number;
}
/** `/api/finance/monthly?recalc=status` yanıtı (yalnız kullanılan alanlar). */
interface HesapDurumu {
  recalc: {
    phase: "reading" | "calculating" | "writing" | "done" | "error";
    processed: number;
    total: number;
    startedAt: string;
    finishedAt: string | null;
    error: string | null;
  } | null;
}
/** Raporlar güncellemesini izleme süresi üst sınırı — takılı bir turda kart sonsuza dek beklemesin. */
const IZLEME_UST_SINIR_MS = 4 * 60_000;

/** "2026-08-01" — Türkiye saatiyle bugünün input biçimi. */
function bugunInput(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * Kayıtlı başlangıç → tarih kutusu biçimi ("2026-09-01"), TÜRKİYE takvimine göre.
 *
 * ⚠️ `toISOString().slice(0,10)` KULLANILMAZ: başlangıç Türkiye gece yarısı olarak kaydediliyor
 * (`…T00:00:00+03:00` = önceki gün 21:00 UTC). UTC tarihini almak kutuyu BİR GÜN GERİ
 * dolduruyordu; "Değiştir" deyip olduğu gibi kaydetmek de "bu tarihte bütçe zaten var"
 * hatasına düşüyordu.
 */
export function tarihKutusu(iso: string): string {
  // "sv-SE" biçimi YYYY-MM-DD verir.
  return new Date(iso).toLocaleDateString("sv-SE", { timeZone: "Europe/Istanbul" });
}
const kisaTarih = (iso: string) =>
  new Date(iso).toLocaleDateString("tr-TR", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/Istanbul" });

export function AdBudgetCard({ buAyReklamGideri = 0 }: { buAyReklamGideri?: number }) {
  const queryClient = useQueryClient();
  const { data, isLoading, isError, isFetching, refetch } = useQuery<Yanit>({
    queryKey: ["ad-budgets"],
    queryFn: () => fetchJson("/api/ad-budgets"),
    staleTime: 60_000,
  });

  const [acikPlatform, setAcikPlatform] = useState<string | null>(null);
  const [tutar, setTutar] = useState("");
  const [baslangic, setBaslangic] = useState(bugunInput);
  /** Kaldırma onayı bekleyen bütçe (pencere açık). */
  const [kaldirilacak, setKaldirilacak] = useState<{ id: string; ad: string } | null>(null);
  /**
   * Raporlar arkada yeniden hesaplanırken izlenen tur: istek anı (bu andan önce başlamış tur
   * bizim değil) ve sipariş sayısı. Bitince Raporlar'ın aylık rakamları tazelenir.
   */
  const [izlenen, setIzlenen] = useState<{ istekAni: number; siparis: number } | null>(null);
  /** Türkçe tutar ("1.500" = bin beş yüz); geçersiz → null, kayıt düğmesi kilitli. */
  const tutarSayi = trTutarOku(tutar);
  const tutarHatasi = tutar.trim() && (tutarSayi == null || tutarSayi < 0) ? "Geçersiz tutar" : null;
  /** Raporlar'ın aylık rakamları (donmuş kârlar) tazelensin. */
  const raporlariTazele = () => {
    void queryClient.invalidateQueries({ queryKey: ["finance-monthly"] });
    void queryClient.invalidateQueries({ queryKey: ["finance-dokum"] });
  };
  /** Bütçe değişince: liste + kâr önbellekleri hemen; Raporlar yeniden hesap bitince bir kez daha. */
  const tazele = (yanit: KayitYaniti | undefined, istekAni: number) => {
    void queryClient.invalidateQueries({ queryKey: ["ad-budgets"] });
    raporlariTazele();
    clearPricingQueryCache(queryClient);
    const siparis = yanit?.yenidenHesap ?? 0;
    if (siparis > 0) setIzlenen({ istekAni, siparis });
  };

  /**
   * YENİDEN HESAP İLERLEMESİ — bütçe kaydı Raporlar'daki donmuş kârları arkada yeniden yazdırır.
   * Eskiden Raporlar sorgusu kayıt ANINDA tazeleniyor, hesap ise sonra bitiyordu: ekran eski
   * rakamda kalıyordu. Tur bitene kadar yoklanır; bitince Raporlar tazelenir.
   * Yan etkiler sorgu işlevinin içinde (etki kancası yok): tur bitince izleme kapanır.
   */
  const hesapDurumu = useQuery({
    queryKey: ["ad-budget-recalc", izlenen?.istekAni ?? 0],
    enabled: izlenen != null,
    refetchInterval: 1_000,
    gcTime: 0,
    queryFn: async () => {
      const yanit = await fetchJson<HesapDurumu>("/api/finance/monthly?recalc=status");
      const tur = yanit.recalc;
      const izlenenTur = izlenen;
      if (!izlenenTur) return null;
      const bizimTur = tur != null && Date.parse(tur.startedAt) >= izlenenTur.istekAni - 2_000;
      if (bizimTur && tur.finishedAt) {
        setIzlenen(null);
        raporlariTazele();
        if (tur.phase === "error") toast.error(tur.error || "Raporlar güncellenemedi");
      } else if (Date.now() - izlenenTur.istekAni > IZLEME_UST_SINIR_MS) {
        setIzlenen(null);
        raporlariTazele();
      }
      return bizimTur ? tur : null;
    },
  });
  const ilerleme = hesapDurumu.data;
  const ilerlemeYuzde =
    ilerleme && ilerleme.total > 0 ? Math.round((ilerleme.processed / ilerleme.total) * 100) : 0;

  /** Mevcut dönemi YERİNDE düzelt — "yanlış girdim" durumu. Geçmişe de işler. */
  const duzelt = useMutation({
    mutationFn: ({ id }: { id: string; istekAni: number }) =>
      fetchJson<KayitYaniti>(`/api/ad-budgets/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dailyAmount: tutarSayi ?? 0,
          startsAt: `${baslangic}T00:00:00.000+03:00`,
        }),
      }),
    onSuccess: (yanit, { istekAni }) => {
      tazele(yanit, istekAni);
      toast.success("Reklam bütçesi güncellendi");
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Güncellenemedi"),
  });

  const kaldir = useMutation({
    mutationFn: ({ id }: { id: string; istekAni: number }) =>
      fetchJson<KayitYaniti>(`/api/ad-budgets/${id}`, { method: "DELETE" }),
    onSuccess: (yanit, { istekAni }) => {
      tazele(yanit, istekAni);
      toast.success("Reklam bütçesi kaldırıldı");
      setKaldirilacak(null);
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Kaldırılamadı"),
  });

  const kaydet = useMutation({
    mutationFn: ({ platform }: { platform: string; istekAni: number }) =>
      fetchJson<KayitYaniti>("/api/ad-budgets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform,
          dailyAmount: tutarSayi ?? 0,
          startsAt: `${baslangic}T00:00:00.000+03:00`,
        }),
      }),
    onSuccess: (yanit, { istekAni }) => {
      // Kâr rakamı değişti → ürün/sipariş/rapor önbelleklerinin hepsi tazelensin.
      tazele(yanit, istekAni);
      toast.success("Reklam bütçesi kaydedildi");
      setAcikPlatform(null);
      setTutar("");
    },
    onError: (e: Error) => toast.error(e.message || "Kaydedilemedi"),
  });

  const yururlukte = (p: string) =>
    data?.butceler.find((b) => b.platform === p && !b.validTo && b.isActive) ?? null;

  return (
    <Card className="rounded-2xl border-0 ring-1 ring-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 duration-500 motion-reduce:animate-none">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start gap-2.5">
          <Megaphone className="h-4 w-4 text-[#A9AEFF] mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold leading-tight">Reklam Bütçesi</h2>
            <p className="text-[11px] text-muted-foreground mt-0.5 leading-relaxed">
              Günlük reklam harcaman ürün kârlarına dağıtılır; marka reklamı için &quot;Tüm platformlar&quot;.
            </p>
          </div>
        </div>

        {/* Reklam GİDER olarak girilmiş ama bütçe yok: tutar aylık net kâra giriyor, ürün kârlarına
            dağıtılmıyor. Otomatik taşıma YOK — ikisini birden tutmak aynı parayı iki kez sayar. */}
        {/* İki durum: bütçe yokken reklam gideri → ürün kârlarına dağıtılmıyor; bütçe VARKEN reklam
            gideri → aynı para iki kez düşülüyor (eskiden bu durumda uyarı kayboluyordu). */}
        {!isLoading && data && buAyReklamGideri > 0 && (
          <div className="rounded-xl bg-[#7A7EFF]/[0.07] px-3 py-2 text-[11px] leading-relaxed ring-1 ring-[#7A7EFF]/30 text-[#E4E7FF]">
            {PLATFORMLAR.every((p) => !yururlukte(p.id)) ? (
              <>
                Bu ay Giderler&apos;de <strong className="tabular-nums">{formatCurrency(buAyReklamGideri)}</strong> reklam
                ödemesi var — ürün kârlarına dağıtılmıyor. Bütçe girersen o ödemeyi giderden çıkar.
              </>
            ) : (
              <>
                Bütçe varken Giderler&apos;de de <strong className="tabular-nums">{formatCurrency(buAyReklamGideri)}</strong>{" "}
                reklam ödemesi var — reklam iki kez düşülüyor olabilir.
              </>
            )}
          </div>
        )}

        {/* Raporlar arkada güncellenirken: belirli ilerleme (X/Y) — ekran donmuş görünmesin. */}
        {izlenen && (
          <div
            className="rounded-xl bg-[#7A7EFF]/[0.07] px-3 py-2 ring-1 ring-[#7A7EFF]/25 animate-in fade-in slide-in-from-top-1 duration-300 motion-reduce:animate-none"
            role="status"
            aria-live="polite"
          >
            <div className="flex items-center gap-2 text-[11px] text-[#E4E7FF]">
              <RefreshCw className="h-3 w-3 animate-spin motion-reduce:animate-none text-[#A9AEFF]" />
              <span>Raporlar güncelleniyor</span>
              <span className="ml-auto tabular-nums text-[#C9D2F2]">
                {ilerleme && ilerleme.total > 0
                  ? `${ilerleme.processed}/${ilerleme.total}`
                  : `${izlenen.siparis} sipariş`}
              </span>
            </div>
            <Progress
              value={ilerlemeYuzde}
              className="mt-1.5 h-1 bg-white/[0.06] [&>[data-slot=progress-indicator]]:bg-[#7A7EFF] [&>[data-slot=progress-indicator]]:duration-500"
            />
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground py-3">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> yükleniyor…
          </div>
        ) : isError && !data ? (
          // Okunamadı ≠ bütçe yok: "Bütçe gir" denince mükerrer dönem açılabiliyordu.
          <div className="flex items-center gap-3 py-2 text-sm">
            <span className="text-rose-300">Reklam bütçeleri yüklenemedi.</span>
            <Button variant="outline" size="sm" className="h-7 rounded-lg text-xs" disabled={isFetching} onClick={() => void refetch()}>
              Tekrar dene
            </Button>
          </div>
        ) : (
          <div className="space-y-2">
            {PLATFORMLAR.map((p) => {
              const b = yururlukte(p.id);
              const o = data?.oranlar[p.id];
              const acik = acikPlatform === p.id;
              return (
                <div key={p.id} className="rounded-xl bg-white/[0.02] ring-1 ring-white/[0.06] overflow-hidden transition-colors hover:bg-white/[0.03]">
                  <div className="flex items-center gap-2 px-3 py-2">
                    <span className={cn("text-xs font-medium w-24 shrink-0", p.renk)}>{p.ad}</span>

                    {b && b.dailyAmount > 0 ? (
                      <span className="text-xs tabular-nums">
                        {formatCurrency(b.dailyAmount)} <span className="text-muted-foreground">/ gün</span>
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">bütçe yok</span>
                    )}

                    {o && o.guvenilir && o.oran > 0 && (
                      <span
                        className={cn(
                          "text-[11px] tabular-nums px-1.5 py-0.5 rounded",
                          o.cirodanBuyuk ? "bg-rose-500/15 text-rose-300" : "bg-[#7A7EFF]/12 text-[#C9D2F2]"
                        )}
                        title={p.id === "all" ? "Toplam ciroya oranlandı" : `Yalnız ${p.ad} cirosuna oranlandı`}
                      >
                        ciro payı %{o.yuzde.toFixed(1)}
                      </span>
                    )}
                    {o && !o.guvenilir && b && b.dailyAmount > 0 && (
                      <span className="text-[11px] text-[#C9D2F2] flex items-center gap-1">
                        <TriangleAlert className="h-3 w-3" /> ciro yok, oran hesaplanamadı
                      </span>
                    )}

                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 text-[11px] ml-auto"
                      onClick={() => {
                        setAcikPlatform(acik ? null : p.id);
                        setTutar(b ? String(b.dailyAmount) : "");
                        // Mevcut dönemin tarihi forma gelsin — kullanıcı onu düzeltmek istiyor.
                        if (b?.validFrom) {
                          setBaslangic(tarihKutusu(b.validFrom));
                        }
                      }}
                    >
                      {acik ? "Vazgeç" : b ? "Değiştir" : "Bütçe gir"}
                    </Button>
                  </div>

                  {b?.validFrom && (
                    <div className="px-3 pb-1.5 text-[10px] text-muted-foreground">
                      {kisaTarih(b.validFrom)} tarihinden beri geçerli
                    </div>
                  )}

                  {acik && (
                    <div className="px-3 pb-3 pt-1 border-t bg-background/40 animate-in fade-in slide-in-from-top-1 duration-200">
                      <div className="grid grid-cols-2 gap-2 mt-2">
                        <div>
                          <Label className="text-[11px]">Günlük tutar (₺)</Label>
                          <Input
                            inputMode="decimal"
                            className="h-8 text-sm"
                            placeholder="800"
                            value={tutar}
                            onChange={(e) => setTutar(e.target.value)}
                          />
                          {tutarHatasi && <p className="mt-1 text-[10px] font-medium text-rose-300">{tutarHatasi}</p>}
                        </div>
                        <div>
                          <Label className="text-[11px]">Şu tarihten itibaren</Label>
                          <Input
                            type="date"
                            className="h-8 text-sm"
                            value={baslangic}
                            onChange={(e) => setBaslangic(e.target.value)}
                          />
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2 leading-relaxed">
                        {b
                          ? "Düzelt: geçmiş siparişler de yeni tutarla hesaplanır. Yeni dönem: bu tarihten sonrası için."
                          : "Bu tarihten sonraki siparişlerin kârı reklam payını içerir."}
                      </p>
                      <div className="flex items-center gap-1.5 mt-2">
                        {b && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 text-xs mr-auto text-rose-300/80 hover:bg-rose-500/10 hover:text-rose-200 active:scale-95 transition-transform"
                            disabled={kaldir.isPending}
                            // Onay penceresi açılır (eskiden onaysızdı).
                            onClick={() => setKaldirilacak({ id: b.id, ad: p.ad })}
                          >
                            Kaldır
                          </Button>
                        )}
                        {b ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 text-xs"
                              disabled={duzelt.isPending || tutarSayi == null || tutarSayi < 0}
                              onClick={() => duzelt.mutate({ id: b.id, istekAni: Date.now() })}
                            >
                              {duzelt.isPending ? "…" : "Düzelt"}
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={kaydet.isPending || tutarSayi == null || tutarSayi < 0}
                              onClick={() => kaydet.mutate({ platform: p.id, istekAni: Date.now() })}
                            >
                              {kaydet.isPending ? "…" : "Yeni dönem başlat"}
                            </Button>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            className="h-7 text-xs ml-auto"
                            disabled={kaydet.isPending || tutarSayi == null || tutarSayi < 0}
                            onClick={() => kaydet.mutate({ platform: p.id, istekAni: Date.now() })}
                          >
                            {kaydet.isPending ? "Kaydediliyor…" : "Kaydet"}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>

      {/* Kaldırma onayı — kâr rakamını geriye dönük değiştirir. */}
      <Dialog
        open={kaldirilacak != null}
        onOpenChange={(o) => !o && !kaldir.isPending && setKaldirilacak(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base text-rose-300">Reklam bütçesi kaldırılsın mı?</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium">{kaldirilacak?.ad}</p>
          <p className="text-xs text-muted-foreground">
            Bu dönemdeki siparişlerin kârı reklam payı olmadan yeniden hesaplanır. Geri alınamaz.
          </p>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={kaldir.isPending}
              onClick={() => setKaldirilacak(null)}
            >
              Vazgeç
            </Button>
            <Button
              size="sm"
              className="bg-rose-500 text-white hover:bg-rose-500/90"
              disabled={kaldir.isPending}
              onClick={() => kaldirilacak && kaldir.mutate({ id: kaldirilacak.id, istekAni: Date.now() })}
            >
              {kaldir.isPending ? "Kaldırılıyor…" : "Kaldır"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
