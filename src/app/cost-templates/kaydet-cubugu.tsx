"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Save, Undo2, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { gezinmeKorumasiKur } from "@/lib/gezinme-korumasi";
import { fetchJson } from "@/lib/fetch-json";
import { formatCurrency } from "@/lib/format";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";
import { maliyetEtkisi, type EtkiOzeti, type EtkiUrunu } from "@/lib/maliyet-etki";
import { cn } from "@/lib/utils";

/**
 * TEK KAYDET ÇUBUĞU — Maliyet & Paketleme.
 *
 * 9 Eki 2026 denetimi: sayfada 4 ayrı "Kaydet" düğmesi vardı (ikisi aynı işi yapıyordu) ve
 * birini atlamak kolaydı — değişiklik kaydedilmeden sayfadan çıkılıyordu. Artık her bölüm
 * değişikliğini buraya bildirir; çubuk hangi bölümün değiştiğini söyler, hepsini TEK istekte
 * kaydeder ve kaydetmeden önce "kaç ürünün kârı ne kadar değişir?" önizlemesini gösterir.
 */
export interface KayitBolumu {
  etiket: string;
  kirli: boolean;
  /** Kaydedilecek AppSetting anahtarları — YALNIZ DEĞİŞENLER (tamamı string). */
  degisiklikler: () => Record<string, string>;
  vazgec: () => void;
  /**
   * Kayıt başarılı oldu — bölüm GÖNDERİLEN değerleri "kayıtlı" saysın. Kayıt sürerken yazılan yeni
   * değer gönderilmediği için kirli kalır (eskiden o da kaydedilmiş sayılıp siliniyordu).
   */
  kaydedildi: (gonderilen: Record<string, string>) => void;
}

type DepoKaydi = KayitBolumu & { imza: string };

interface Depo {
  ayarla: (id: string, b: DepoKaydi) => void;
  sil: (id: string) => void;
  al: (id: string) => DepoKaydi | undefined;
  bolumler: () => [string, DepoKaydi][];
  abone: (f: () => void) => () => void;
  surum: () => number;
}

function depoKur(): Depo {
  const harita = new Map<string, DepoKaydi>();
  const dinleyiciler = new Set<() => void>();
  let surum = 0;
  const bildir = () => {
    surum++;
    for (const f of dinleyiciler) f();
  };
  return {
    ayarla: (id, b) => {
      const eski = harita.get(id);
      harita.set(id, b);
      // Yalnız çubuğun gösterdiği şey ya da kaydedilecek değerler değişince bildir.
      if (!eski || eski.kirli !== b.kirli || eski.etiket !== b.etiket || eski.imza !== b.imza) bildir();
    },
    sil: (id) => {
      if (harita.delete(id)) bildir();
    },
    al: (id) => harita.get(id),
    bolumler: () => [...harita.entries()],
    abone: (f) => {
      dinleyiciler.add(f);
      return () => dinleyiciler.delete(f);
    },
    surum: () => surum,
  };
}

const Baglam = createContext<Depo | null>(null);

export function KaydetCubuguSaglayici({ children }: { children: ReactNode }) {
  const [depo] = useState(depoKur);
  return (
    <Baglam.Provider value={depo}>
      {children}
      <KaydetCubugu depo={depo} />
    </Baglam.Provider>
  );
}

/** Bölüm her çizimde güncel hâlini bildirir; sökülünce kaydı silinir. */
export function useKayitBolumu(id: string, bolum: KayitBolumu): void {
  const depo = useContext(Baglam);
  const son = useRef(bolum);
  useEffect(() => {
    son.current = bolum;
    depo?.ayarla(id, {
      etiket: bolum.etiket,
      kirli: bolum.kirli,
      imza: bolum.kirli ? JSON.stringify(bolum.degisiklikler()) : "",
      degisiklikler: () => son.current.degisiklikler(),
      vazgec: () => son.current.vazgec(),
      kaydedildi: (gonderilen) => son.current.kaydedildi(gonderilen),
    });
  });
  useEffect(() => () => depo?.sil(id), [depo, id]);
}

function KaydetCubugu({ depo }: { depo: Depo }) {
  useSyncExternalStore(depo.abone, depo.surum, () => 0);
  const qc = useQueryClient();
  const router = useRouter();
  const kirliler = depo.bolumler().filter(([, b]) => b.kirli);
  const [etki, setEtki] = useState<{ ozet: EtkiOzeti; anahtar: string; kapsam: boolean } | null>(null);
  const [etkiYukleniyor, setEtkiYukleniyor] = useState(false);
  /** Kaydedilmemiş değişiklik varken başka sayfaya gidilmek istendi — soru penceresi. */
  const [bekleyenHedef, setBekleyenHedef] = useState<string | null>(null);
  const birlesik = () => Object.assign({}, ...kirliler.map(([, b]) => b.degisiklikler())) as Record<string, string>;
  const anahtar = kirliler.map(([id, b]) => `${id}:${b.imza}`).join("|");
  const kirliVar = kirliler.length > 0;

  const kaydet = useMutation({
    mutationFn: (veri: Record<string, string>) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(veri),
      }),
    onError: (e) =>
      toast.error(e instanceof Error && e.message ? e.message : "Kaydedilemedi — değişiklikler ekranda duruyor, tekrar dene."),
  });

  /** GÖNDERİLEN değişiklikleri kaydet; başarıda yalnız onlar "kayıtlı" sayılır. */
  const kaydetVeSonra = (sonra?: () => void) => {
    const gonderim = kirliler.map(([id, b]) => [id, b.degisiklikler()] as const);
    const veri = Object.assign({}, ...gonderim.map(([, v]) => v)) as Record<string, string>;
    kaydet.mutate(veri, {
      onSuccess: () => {
        for (const [id, v] of gonderim) depo.al(id)?.kaydedildi(v);
        setEtki(null);
        clearPricingQueryCache(qc); // ayarları da tazeler (silmez)
        toast.success("Kaydedildi — detaylı maliyetli ürünlere ve yeni siparişlere uygulandı");
        sonra?.();
      },
    });
  };

  /**
   * SAYFADAN ÇIKARKEN SOR — kenar menü/bağlantı tıklamaları burada, hızlı arama (Ctrl+K) gibi
   * kodla gezinmeler `gezinme-korumasi` üzerinden yakalanır. Eskiden değişiklikler sessizce gidiyordu.
   */
  useEffect(() => {
    if (!kirliVar) return;
    const kaldir = gezinmeKorumasiKur((hedef) => {
      setBekleyenHedef(hedef);
      return false;
    });
    const tikla = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a || a.target === "_blank") return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setBekleyenHedef(url.pathname + url.search);
    };
    document.addEventListener("click", tikla, true);
    return () => {
      kaldir();
      document.removeEventListener("click", tikla, true);
    };
  }, [kirliVar]);

  async function etkiyiGor() {
    setEtkiYukleniyor(true);
    const hesaplananAnahtar = anahtar;
    try {
      const veri = birlesik();
      // "Önce" de önbelleksiz, aynı yoldan hesaplanır (`ayarOnizleme={}`): önbellekteki liste bayat
      // olabiliyor ve ayarla ilgisiz farklar etkiye karışıyordu.
      const [once, sonra] = await Promise.all([
        fetchJson<EtkiUrunu[]>(`/api/products?filter=active&ayarOnizleme=${encodeURIComponent("{}")}`),
        fetchJson<EtkiUrunu[]>(`/api/products?filter=active&ayarOnizleme=${encodeURIComponent(JSON.stringify(veri))}`),
      ]);
      setEtki({ ozet: maliyetEtkisi(once, sonra), anahtar: hesaplananAnahtar, kapsam: "packagingScopes" in veri });
    } catch {
      toast.error("Etki hesaplanamadı");
    } finally {
      setEtkiYukleniyor(false);
    }
  }

  const gezinmePenceresi = (
    <Dialog open={bekleyenHedef != null} onOpenChange={(o) => !o && !kaydet.isPending && setBekleyenHedef(null)}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base">Kaydedilmemiş değişiklik var</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">Çıkmadan önce kaydetmek ister misin?</p>
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" disabled={kaydet.isPending} onClick={() => setBekleyenHedef(null)}>
            Kal
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={kaydet.isPending}
            onClick={() => {
              const hedef = bekleyenHedef;
              for (const [, b] of kirliler) b.vazgec();
              setBekleyenHedef(null);
              if (hedef) router.push(hedef);
            }}
          >
            Kaydetmeden git
          </Button>
          <Button
            size="sm"
            className="gap-1.5 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] text-white"
            disabled={kaydet.isPending}
            onClick={() => {
              const hedef = bekleyenHedef;
              kaydetVeSonra(() => {
                setBekleyenHedef(null);
                if (hedef) router.push(hedef);
              });
            }}
          >
            {kaydet.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Kaydet ve git
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );

  if (!kirliVar) return gezinmePenceresi;
  // Önizleme yalnız hesaplandığı değişikliklerle aynıysa gösterilir (sonradan yazılan rakam bayatlatır).
  const gecerliEtki = etki && etki.anahtar === anahtar ? etki.ozet : null;

  return (
    <div className="sticky bottom-4 z-30 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-2xl bg-card/95 p-3 shadow-[0_24px_60px_-30px_rgba(0,0,0,0.9)] ring-1 ring-[#7A7EFF]/35 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Kaydedilmemiş değişiklik</p>
            <p className="truncate text-xs text-muted-foreground">{kirliler.map(([, b]) => b.etiket).join(" · ")}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5 rounded-xl border-white/[0.1] bg-white/[0.03] active:scale-[0.97]" onClick={() => void etkiyiGor()} disabled={etkiYukleniyor}>
            {etkiYukleniyor ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Gauge className="h-3.5 w-3.5" />}
            Etkiyi gör
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5"
            onClick={() => {
              for (const [, b] of kirliler) b.vazgec();
              setEtki(null);
            }}
            disabled={kaydet.isPending}
          >
            <Undo2 className="h-3.5 w-3.5" />
            Vazgeç
          </Button>
          <Button
            size="sm"
            className="gap-1.5 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:brightness-110 active:scale-[0.97]"
            onClick={() => kaydetVeSonra()}
            disabled={kaydet.isPending}
          >
            {kaydet.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Kaydet
          </Button>
        </div>
        {gecerliEtki && <EtkiSatiri ozet={gecerliEtki} />}
        {gecerliEtki && etki?.kapsam && (
          <p className="mt-1 text-xs text-[#C9D2F2]">Kapsam değişikliği çok adetli siparişleri etkiler; tek adetli ilan kârı aynı kalır.</p>
        )}
      </div>
      {gezinmePenceresi}
    </div>
  );
}

function EtkiSatiri({ ozet }: { ozet: EtkiOzeti }) {
  if (ozet.etkilenenIlan === 0) {
    return <p className="mt-2 border-t border-white/[0.06] pt-2 text-xs text-muted-foreground animate-in fade-in duration-300">Bu değişiklik hiçbir ürünün kârını değiştirmiyor.</p>;
  }
  const fark = ozet.ortalamaFark ?? 0;
  return (
    <div className="mt-2 space-y-1 border-t border-white/[0.06] pt-2 text-xs animate-in fade-in slide-in-from-bottom-1 duration-300">
      <p>
        Kaydedersen <strong>{ozet.etkilenenUrun}</strong>{" "}ürünün ({ozet.etkilenenIlan} ilan) kârı değişir · satış başına ortalama{" "}
        <strong className={cn("tabular-nums", fark < 0 ? "text-rose-400" : "text-emerald-400")}>
          {fark > 0 ? "+" : ""}
          {formatCurrency(fark)}
        </strong>
        {ozet.zarargaGecen > 0 && (
          <>
            {" "}· <strong className="text-rose-400">{ozet.zarargaGecen} ilan zarara geçer</strong>
          </>
        )}
        {ozet.karaGecen > 0 && <> · {ozet.karaGecen} ilan kâra geçer</>}
      </p>
      <p className="truncate text-muted-foreground">
        En çok etkilenen:{" "}
        {ozet.enCok
          .map((s) => `${s.name} (${s.fark > 0 ? "+" : ""}${formatCurrency(s.fark)})`)
          .join(" · ")}
      </p>
    </div>
  );
}
