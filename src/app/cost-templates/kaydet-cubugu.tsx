"use client";

import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2, Save, Undo2, Gauge } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /** Kaydedilecek AppSetting anahtarları (tamamı string). */
  degisiklikler: () => Record<string, string>;
  vazgec: () => void;
  /** Kayıt başarılı oldu — bölüm yeni değerleri "kayıtlı" saysın. */
  kaydedildi: () => void;
}

type DepoKaydi = KayitBolumu & { imza: string };

interface Depo {
  ayarla: (id: string, b: DepoKaydi) => void;
  sil: (id: string) => void;
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
      kaydedildi: () => son.current.kaydedildi(),
    });
  });
  useEffect(() => () => depo?.sil(id), [depo, id]);
}

function KaydetCubugu({ depo }: { depo: Depo }) {
  useSyncExternalStore(depo.abone, depo.surum, () => 0);
  const qc = useQueryClient();
  const kirliler = depo.bolumler().filter(([, b]) => b.kirli);
  const [etki, setEtki] = useState<{ ozet: EtkiOzeti; anahtar: string } | null>(null);
  const [etkiYukleniyor, setEtkiYukleniyor] = useState(false);
  const birlesik = () => Object.assign({}, ...kirliler.map(([, b]) => b.degisiklikler())) as Record<string, string>;
  const anahtar = kirliler.map(([id, b]) => `${id}:${b.imza}`).join("|");

  const kaydet = useMutation({
    mutationFn: (veri: Record<string, string>) =>
      fetchJson("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(veri),
      }),
    onSuccess: () => {
      for (const [, b] of kirliler) b.kaydedildi();
      setEtki(null);
      void qc.invalidateQueries({ queryKey: ["app-settings"] });
      clearPricingQueryCache(qc);
      toast.success("Maliyet ayarları kaydedildi — tüm ürünlere uygulandı");
    },
    onError: () => toast.error("Kaydedilemedi — değişiklikler ekranda duruyor, tekrar dene."),
  });

  async function etkiyiGor() {
    setEtkiYukleniyor(true);
    const hesaplananAnahtar = anahtar;
    try {
      const veri = birlesik();
      const [once, sonra] = await Promise.all([
        fetchJson<EtkiUrunu[]>("/api/products?filter=active"),
        fetchJson<EtkiUrunu[]>(`/api/products?filter=active&ayarOnizleme=${encodeURIComponent(JSON.stringify(veri))}`),
      ]);
      setEtki({ ozet: maliyetEtkisi(once, sonra), anahtar: hesaplananAnahtar });
    } catch {
      toast.error("Etki hesaplanamadı");
    } finally {
      setEtkiYukleniyor(false);
    }
  }

  if (kirliler.length === 0) return null;
  // Önizleme yalnız hesaplandığı değişikliklerle aynıysa gösterilir (sonradan yazılan rakam bayatlatır).
  const gecerliEtki = etki && etki.anahtar === anahtar ? etki.ozet : null;

  return (
    <div className="sticky bottom-4 z-30 animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="rounded-xl border border-primary/30 bg-card/95 p-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Kaydedilmemiş değişiklik</p>
            <p className="truncate text-xs text-muted-foreground">{kirliler.map(([, b]) => b.etiket).join(" · ")}</p>
          </div>
          <Button variant="outline" size="sm" className="gap-1.5" onClick={() => void etkiyiGor()} disabled={etkiYukleniyor}>
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
          <Button size="sm" className="gap-1.5" onClick={() => kaydet.mutate(birlesik())} disabled={kaydet.isPending}>
            {kaydet.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            Kaydet
          </Button>
        </div>
        {gecerliEtki && <EtkiSatiri ozet={gecerliEtki} />}
      </div>
    </div>
  );
}

function EtkiSatiri({ ozet }: { ozet: EtkiOzeti }) {
  if (ozet.etkilenenIlan === 0) {
    return <p className="mt-2 border-t pt-2 text-xs text-muted-foreground">Bu değişiklik hiçbir ürünün kârını değiştirmiyor.</p>;
  }
  const fark = ozet.ortalamaFark ?? 0;
  return (
    <div className="mt-2 space-y-1 border-t pt-2 text-xs">
      <p>
        Kaydedersen <strong>{ozet.etkilenenUrun}</strong> ürünün ({ozet.etkilenenIlan} ilan) kârı değişir · satış başına ortalama{" "}
        <strong className={cn("tabular-nums", fark < 0 ? "text-destructive" : "text-emerald-500")}>
          {fark > 0 ? "+" : ""}
          {formatCurrency(fark)}
        </strong>
        {ozet.zarargaGecen > 0 && (
          <>
            {" "}· <strong className="text-destructive">{ozet.zarargaGecen} ilan zarara geçer</strong>
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
