"use client";

import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CheckCheck,
  Loader2,
  Printer,
  RotateCcw,
  X,
} from "lucide-react";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { AnimatedNumber } from "@/components/ui/animated-number";
import {
  bekleyenEtiket,
  etiketAnahtari,
  etiketBasilabilir,
  etiketIstegi,
  type EtiketSiparisi,
} from "./etiket-uygunluk";

/**
 * Trendyol kargo etiketi — Siparişler ekranı.
 *
 * • Her uygun siparişin açılır panelinde "Etiketi yazdır".
 * • Üstteki "Etiket yazdır" düğmesi seçim modunu açar: uygun siparişlerde kutu çıkar, altta
 *   seçim çubuğu belirir (bekleyenleri seç, yazıcı, yazdır, X/Y ilerleme).
 * Etiketler sırayla, tek tek basılır (her biri Trendyol'dan alınıp yazıcıya gider); bir yazıcı
 * ya da bağlantı hatasında kuyruk durur — kalan etiketler boşa denenmez.
 */

interface EtiketDurumYaniti {
  yazicilar: string[];
  secili: string | null;
  elleSecildi: boolean;
  basilanlar: Record<string, string>;
}

type KalemDurumu = "sirada" | "basiliyor" | "basildi" | "hata";

interface IsDurumu {
  toplam: number;
  bitti: number;
  basarili: number;
  calisiyor: boolean;
  suAn: string | null;
  hatalar: Array<{ takipNo: string; siparisNo: string; mesaj: string }>;
  durduruldu: boolean;
}

interface EtiketBaglami {
  durum: EtiketDurumYaniti | undefined;
  durumYukleniyor: boolean;
  secimModu: boolean;
  setSecimModu: (v: boolean) => void;
  secililer: ReadonlySet<string>;
  secimDegistir: (takipNo: string, secili: boolean) => void;
  secimiTemizle: () => void;
  bekleyenleriSec: () => void;
  bekleyenSayisi: number;
  uygunSayisi: number;
  kalemler: Readonly<Record<string, KalemDurumu>>;
  is: IsDurumu | null;
  isiKapat: () => void;
  yazdir: (siparisler: EtiketSiparisi[]) => Promise<void>;
  yaziciSec: (ad: string) => Promise<void>;
}

const Baglam = createContext<EtiketBaglami | null>(null);

export function useEtiket(): EtiketBaglami | null {
  return useContext(Baglam);
}

const DURUM_ANAHTARI = ["etiket-durumu"] as const;

/** Kuyruğu durduran hatalar: yazıcı ya da Trendyol bağlantısı — sonraki etiketler de düşer. */
function kuyruguDurdurur(mesaj: string): boolean {
  return /yazıcı|bağlantı|çok sık|açmamış/i.test(mesaj);
}

export function EtiketSaglayici({
  siparisler,
  gorunenler,
  children,
}: {
  /** Tüm siparişler — seçili takip numarasını siparişe çevirmek için. */
  siparisler: readonly EtiketSiparisi[];
  /** Şu an listede görünenler (filtre/arama sonrası) — "bekleyenleri seç" bunlardan seçer. */
  gorunenler: readonly EtiketSiparisi[];
  children: ReactNode;
}) {
  const qc = useQueryClient();
  const durumSorgusu = useQuery<EtiketDurumYaniti>({
    queryKey: DURUM_ANAHTARI,
    queryFn: () => fetchJson<EtiketDurumYaniti>("/api/etiket"),
    staleTime: 60_000,
  });
  const [secimModu, setSecimModuHam] = useState(false);
  const [secililer, setSecililer] = useState<Set<string>>(() => new Set());
  const [kalemler, setKalemler] = useState<Record<string, KalemDurumu>>({});
  const [is, setIs] = useState<IsDurumu | null>(null);
  const calisiyor = useRef(false);

  const uygunlar = useMemo(() => gorunenler.filter(etiketBasilabilir), [gorunenler]);
  const bekleyenler = useMemo(() => {
    const basilan = durumSorgusu.data?.basilanlar ?? {};
    return uygunlar.filter((s) => bekleyenEtiket(s) && !basilan[etiketAnahtari(s) ?? ""]);
  }, [uygunlar, durumSorgusu.data?.basilanlar]);

  const setSecimModu = useCallback((v: boolean) => {
    setSecimModuHam(v);
    if (!v) setSecililer(new Set());
  }, []);

  const secimDegistir = useCallback((takipNo: string, secili: boolean) => {
    setSecililer((onceki) => {
      const yeni = new Set(onceki);
      if (secili) yeni.add(takipNo);
      else yeni.delete(takipNo);
      return yeni;
    });
  }, []);

  const secimiTemizle = useCallback(() => setSecililer(new Set()), []);
  const bekleyenleriSec = useCallback(() => {
    setSecililer(new Set(bekleyenler.map((s) => etiketAnahtari(s) as string)));
  }, [bekleyenler]);

  const basildiYaz = useCallback(
    (takipNo: string, an: string) => {
      qc.setQueryData<EtiketDurumYaniti>(DURUM_ANAHTARI, (eski) =>
        eski ? { ...eski, basilanlar: { ...eski.basilanlar, [takipNo]: an } } : eski
      );
    },
    [qc]
  );

  const yazdir = useCallback(
    async (liste: EtiketSiparisi[]) => {
      const kuyruk = liste.filter(etiketBasilabilir);
      if (!kuyruk.length) return;
      if (calisiyor.current) {
        toast.info("Etiketler basılıyor, bitmesini bekle.");
        return;
      }
      calisiyor.current = true;
      setKalemler((k) => {
        const yeni = { ...k };
        for (const s of kuyruk) yeni[etiketAnahtari(s) as string] = "sirada";
        return yeni;
      });
      const hatalar: IsDurumu["hatalar"] = [];
      let basarili = 0;
      let durduruldu = false;
      setIs({ toplam: kuyruk.length, bitti: 0, basarili: 0, calisiyor: true, suAn: kuyruk[0].orderNumber, hatalar: [], durduruldu: false });

      for (let i = 0; i < kuyruk.length; i++) {
        const s = kuyruk[i];
        const takipNo = etiketAnahtari(s) as string;
        const istek = etiketIstegi(s);
        if (durduruldu) {
          setKalemler((k) => ({ ...k, [takipNo]: "hata" }));
          hatalar.push({ takipNo, siparisNo: s.orderNumber, mesaj: "Basılmadı" });
          continue;
        }
        setIs((o) => (o ? { ...o, suAn: s.orderNumber } : o));
        setKalemler((k) => ({ ...k, [takipNo]: "basiliyor" }));
        try {
          if (!istek) throw new Error("Bu siparişin etiketi basılamaz.");
          const yanit = await fetchJson<{ basildi: string }>(istek.url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(istek.govde),
          });
          basarili++;
          basildiYaz(takipNo, yanit.basildi);
          setKalemler((k) => ({ ...k, [takipNo]: "basildi" }));
          setSecililer((onceki) => {
            if (!onceki.has(takipNo)) return onceki;
            const yeni = new Set(onceki);
            yeni.delete(takipNo);
            return yeni;
          });
        } catch (hata) {
          const mesaj = hata instanceof Error ? hata.message : "Etiket basılamadı.";
          hatalar.push({ takipNo, siparisNo: s.orderNumber, mesaj });
          setKalemler((k) => ({ ...k, [takipNo]: "hata" }));
          if (kuyruguDurdurur(mesaj)) durduruldu = true;
        }
        setIs((o) => (o ? { ...o, bitti: i + 1, basarili, hatalar: [...hatalar], durduruldu } : o));
      }

      calisiyor.current = false;
      setIs((o) => (o ? { ...o, calisiyor: false, suAn: null, bitti: kuyruk.length } : o));
      if (!hatalar.length) {
        toast.success(basarili === 1 ? "Etiket basıldı" : `${basarili} etiket basıldı`);
      } else if (kuyruk.length === 1) {
        toast.error(hatalar[0].mesaj);
      } else {
        toast.error(`${hatalar.length} etiket basılamadı`, { description: hatalar[0].mesaj });
      }
    },
    [basildiYaz]
  );

  const yaziciSec = useCallback(
    async (ad: string) => {
      try {
        const yeni = await fetchJson<EtiketDurumYaniti>("/api/etiket", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ yazici: ad }),
        });
        qc.setQueryData(DURUM_ANAHTARI, yeni);
        toast.success("Etiket yazıcısı seçildi");
      } catch (hata) {
        toast.error(hata instanceof Error ? hata.message : "Yazıcı seçilemedi");
      }
    },
    [qc]
  );

  const isiKapat = useCallback(() => {
    if (!calisiyor.current) setIs(null);
  }, []);

  // Seçili takip numaraları listeden düşerse (filtre değişti) yine de basılabilsin diye
  // tüm siparişlerden çözülür.
  const deger = useMemo<EtiketBaglami>(
    () => ({
      durum: durumSorgusu.data,
      durumYukleniyor: durumSorgusu.isLoading,
      secimModu,
      setSecimModu,
      secililer,
      secimDegistir,
      secimiTemizle,
      bekleyenleriSec,
      bekleyenSayisi: bekleyenler.length,
      uygunSayisi: uygunlar.length,
      kalemler,
      is,
      isiKapat,
      yazdir,
      yaziciSec,
    }),
    [durumSorgusu.data, durumSorgusu.isLoading, secimModu, setSecimModu, secililer, secimDegistir, secimiTemizle, bekleyenleriSec, bekleyenler.length, uygunlar.length, kalemler, is, isiKapat, yazdir, yaziciSec]
  );

  return (
    <Baglam.Provider value={deger}>
      {children}
      <EtiketCubugu siparisler={siparisler} />
    </Baglam.Provider>
  );
}

// ── Üst çubuktaki düğme ───────────────────────────────────────────────────────

export function EtiketModuDugmesi() {
  const e = useEtiket();
  if (!e || (e.uygunSayisi === 0 && !e.secimModu)) return null;
  return (
    <button
      type="button"
      onClick={() => e.setSecimModu(!e.secimModu)}
      aria-pressed={e.secimModu}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-all duration-200 active:scale-95",
        e.secimModu
          ? "border-primary/50 bg-primary/15 text-primary shadow-sm"
          : "border-border bg-muted/30 text-muted-foreground hover:text-foreground hover:border-primary/30"
      )}
    >
      <Printer className="h-3.5 w-3.5" />
      Etiket yazdır
      {e.bekleyenSayisi > 0 && (
        <span className="rounded-full bg-primary/15 px-1.5 py-px text-[10px] font-semibold tabular-nums text-primary animate-in zoom-in-75 duration-200">
          {e.bekleyenSayisi}
        </span>
      )}
    </button>
  );
}

// ── Sipariş satırındaki seçim kutusu ─────────────────────────────────────────

export function EtiketSecimKutusu({ siparis }: { siparis: EtiketSiparisi }) {
  const e = useEtiket();
  if (!e?.secimModu || !etiketBasilabilir(siparis)) return null;
  const takipNo = etiketAnahtari(siparis) as string;
  const secili = e.secililer.has(takipNo);
  const kalem = e.kalemler[takipNo];
  return (
    <label
      className={cn(
        "flex shrink-0 cursor-pointer items-center self-stretch border-r border-border/50 px-3 transition-colors animate-in fade-in slide-in-from-left-2 duration-200 motion-reduce:animate-none",
        secili ? "bg-primary/10" : "hover:bg-muted/50"
      )}
      title="Etiket için seç"
      onClick={(ev) => ev.stopPropagation()}
    >
      {kalem === "basiliyor" ? (
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
      ) : (
        <Checkbox checked={secili} onCheckedChange={(v) => e.secimDegistir(takipNo, v === true)} aria-label={`${siparis.orderNumber} etiketini seç`} />
      )}
    </label>
  );
}

// ── Satır başlığındaki "basıldı" işareti ─────────────────────────────────────

export function EtiketBasildiIsareti({ siparis }: { siparis: EtiketSiparisi }) {
  const e = useEtiket();
  const takipNo = etiketAnahtari(siparis) ?? "";
  if (!e || (siparis.platform !== "trendyol" && siparis.platform !== "hepsiburada") || !takipNo || !e.durum?.basilanlar[takipNo]) return null;
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full bg-emerald-500/12 px-1.5 py-px text-[9px] font-semibold text-emerald-500 animate-in fade-in zoom-in-95 duration-300"
      title={`Etiket basıldı · ${saatYaz(e.durum.basilanlar[takipNo])}`}
    >
      <Printer className="h-2.5 w-2.5" />
      Etiket
    </span>
  );
}

// ── Açılır paneldeki düğme ───────────────────────────────────────────────────

export function EtiketYazdirDugmesi({ siparis }: { siparis: EtiketSiparisi }) {
  const e = useEtiket();
  if (!e || !etiketBasilabilir(siparis)) return null;
  const takipNo = etiketAnahtari(siparis) as string;
  const kalem = e.kalemler[takipNo];
  const basildi = e.durum?.basilanlar[takipNo];
  const yaziciYok = !e.durumYukleniyor && !e.durum?.secili;
  const mesgul = kalem === "basiliyor" || kalem === "sirada";

  return (
    <div className="space-y-1.5 pt-1">
      <button
        type="button"
        disabled={mesgul || yaziciYok}
        onClick={() => void e.yazdir([siparis])}
        className={cn(
          "group inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-all duration-200 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60",
          kalem === "hata"
            ? "bg-destructive/12 text-destructive hover:bg-destructive/20"
            : basildi
              ? "bg-muted/60 text-foreground/80 hover:bg-muted"
              : "bg-primary/15 text-primary hover:bg-primary/25"
        )}
      >
        {mesgul ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : kalem === "basildi" ? (
          <Check className="h-3.5 w-3.5 animate-in zoom-in-50 duration-300" />
        ) : kalem === "hata" ? (
          <RotateCcw className="h-3.5 w-3.5 transition-transform group-hover:-rotate-45" />
        ) : (
          <Printer className="h-3.5 w-3.5 transition-transform group-hover:-translate-y-px" />
        )}
        {mesgul
          ? kalem === "sirada"
            ? "Sırada…"
            : "Basılıyor…"
          : kalem === "hata"
            ? "Tekrar dene"
            : basildi
              ? "Etiketi tekrar yazdır"
              : "Etiketi yazdır"}
      </button>
      {basildi && !mesgul && (
        <p className="text-center text-[10px] text-muted-foreground animate-in fade-in duration-300">
          Basıldı · {saatYaz(basildi)}
        </p>
      )}
      {yaziciYok && <YaziciSecici kucuk />}
    </div>
  );
}

// ── Yazıcı seçici ────────────────────────────────────────────────────────────

function YaziciSecici({ kucuk = false }: { kucuk?: boolean }) {
  const e = useEtiket();
  if (!e) return null;
  const liste = e.durum?.yazicilar ?? [];
  const secili = e.durum?.secili ?? "";
  return (
    <label className={cn("flex min-w-0 items-center gap-1.5", kucuk ? "text-[10px]" : "text-xs")}>
      <Printer className={cn("shrink-0", kucuk ? "h-3 w-3 text-amber-500" : "h-3.5 w-3.5 text-muted-foreground")} />
      <select
        value={secili}
        onChange={(ev) => ev.target.value && void e.yaziciSec(ev.target.value)}
        className={cn(
          "min-w-0 flex-1 truncate rounded-md border bg-background px-1.5 transition-colors hover:border-primary/40 focus:border-primary focus:outline-none",
          kucuk ? "h-6" : "h-8",
          !secili && "border-amber-500/50 text-amber-500"
        )}
        title="Etiket yazıcısı"
      >
        {!secili && <option value="">Yazıcı seç…</option>}
        {liste.map((ad) => (
          <option key={ad} value={ad}>
            {ad}
          </option>
        ))}
      </select>
    </label>
  );
}

// ── Alt seçim / ilerleme çubuğu ──────────────────────────────────────────────

function EtiketCubugu({ siparisler }: { siparisler: readonly EtiketSiparisi[] }) {
  const e = useEtiket();
  if (!e) return null;
  const { is } = e;
  const gorunsun = e.secimModu || (is !== null && is.toplam > 1);
  if (!gorunsun) return null;

  const seciliSiparisler = siparisler.filter((s) => {
    const a = etiketAnahtari(s);
    return a !== null && e.secililer.has(a);
  });
  const yuzde = is ? Math.round((is.bitti / Math.max(1, is.toplam)) * 100) : 0;
  const yaziciVar = Boolean(e.durum?.secili);

  return (
    <div className="pointer-events-none sticky bottom-3 z-30 flex justify-center px-6 pt-2">
      <div className="pointer-events-auto w-full max-w-3xl overflow-hidden rounded-2xl border border-primary/25 bg-card/95 shadow-2xl shadow-black/30 backdrop-blur animate-in fade-in slide-in-from-bottom-4 duration-300 motion-reduce:animate-none">
        {is && (is.calisiyor || is.toplam > 1) ? (
          <div className="space-y-2 px-4 py-3">
            <div className="flex items-center gap-3">
              {is.calisiyor ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-primary" />
              ) : is.hatalar.length ? (
                <AlertTriangle className="h-4 w-4 shrink-0 text-amber-500" />
              ) : (
                <CheckCheck className="h-4 w-4 shrink-0 text-emerald-500 animate-in zoom-in-50 duration-300" />
              )}
              <div className="min-w-0 flex-1 text-sm">
                {is.calisiyor ? (
                  <span>
                    Etiketler basılıyor{" "}
                    <span className="font-semibold tabular-nums">
                      <AnimatedNumber value={is.bitti} durationMs={300} /> / {is.toplam}
                    </span>
                    {is.suAn && <span className="ml-2 text-xs text-muted-foreground">#{is.suAn}</span>}
                  </span>
                ) : is.hatalar.length ? (
                  <span>
                    <span className="font-semibold tabular-nums">{is.basarili}</span> etiket basıldı,{" "}
                    <span className="font-semibold tabular-nums text-amber-500">{is.hatalar.length}</span> basılamadı
                  </span>
                ) : (
                  <span>
                    <span className="font-semibold tabular-nums">{is.basarili}</span> etiket basıldı
                  </span>
                )}
              </div>
              <span className="text-xs font-semibold tabular-nums text-muted-foreground">{yuzde}%</span>
              {!is.calisiyor && (
                <button
                  type="button"
                  onClick={e.isiKapat}
                  className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  title="Kapat"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  "h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none",
                  !is.calisiyor && is.hatalar.length ? "bg-amber-500" : "bg-primary"
                )}
                style={{ width: `${yuzde}%` }}
              />
            </div>
            {!is.calisiyor && is.hatalar.length > 0 && (
              <div className="space-y-1 animate-in fade-in slide-in-from-bottom-1 duration-200">
                <p className="text-xs text-muted-foreground">{is.hatalar[0].mesaj}</p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {is.hatalar.slice(0, 6).map((h) => (
                    <span key={h.takipNo} className="rounded-md bg-amber-500/10 px-1.5 py-0.5 text-[10px] tabular-nums text-amber-500">
                      #{h.siparisNo}
                    </span>
                  ))}
                  {is.hatalar.length > 6 && (
                    <span className="text-[10px] text-muted-foreground">+{is.hatalar.length - 6}</span>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    className="ml-auto"
                    onClick={() => {
                      const takipler = new Set(is.hatalar.map((h) => h.takipNo));
                      void e.yazdir(siparisler.filter((s) => {
                        const a = etiketAnahtari(s);
                        return a !== null && takipler.has(a);
                      }));
                    }}
                  >
                    <RotateCcw className="h-3 w-3" />
                    Basılmayanları tekrar dene
                  </Button>
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <div className="flex items-baseline gap-1.5 text-sm">
              <span className="font-semibold tabular-nums">
                <AnimatedNumber value={e.secililer.size} durationMs={250} />
              </span>
              <span className="text-muted-foreground">sipariş seçildi</span>
            </div>
            {e.bekleyenSayisi > 0 && (
              <Button size="sm" variant="ghost" onClick={e.bekleyenleriSec} title="Etiketi basılmamış yeni siparişleri seç">
                <CheckCheck className="h-3.5 w-3.5" />
                Bekleyenleri seç ({e.bekleyenSayisi})
              </Button>
            )}
            {e.secililer.size > 0 && (
              <Button size="sm" variant="ghost" onClick={e.secimiTemizle}>
                Temizle
              </Button>
            )}
            <div className="ml-auto flex min-w-0 items-center gap-2">
              <div className="w-44 min-w-0">
                <YaziciSecici />
              </div>
              <Button
                size="sm"
                disabled={!seciliSiparisler.length || !yaziciVar}
                onClick={() => void e.yazdir(seciliSiparisler)}
                className="transition-transform active:scale-95"
              >
                <Printer className="h-3.5 w-3.5" />
                {seciliSiparisler.length > 1 ? `${seciliSiparisler.length} etiketi yazdır` : "Etiketi yazdır"}
              </Button>
              <button
                type="button"
                onClick={() => e.setSecimModu(false)}
                className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                title="Kapat"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function saatYaz(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const bugun = new Date();
  const saat = d.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === bugun.toDateString()) return saat;
  return `${d.toLocaleDateString("tr-TR", { day: "numeric", month: "short" })} ${saat}`;
}
