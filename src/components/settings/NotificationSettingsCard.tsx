"use client";

import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  Bell,
  BellOff,
  Check,
  CheckCircle2,
  Disc3,
  Monitor,
  Package,
  PauseCircle,
  Pencil,
  Send,
  ShoppingBag,
  Smartphone,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchJson } from "@/lib/fetch-json";
import { formatRelativeTime } from "@/lib/format";
import { usePrefersReducedMotion } from "@/lib/client-state";
import { cn } from "@/lib/utils";
import {
  MASAUSTU_BILDIRIM_TURLERI,
  TELEFON_BILDIRIM_TURLERI,
  type BildirimTuru,
  type BildirimTuruBilgisi,
} from "@/core/bildirim-turleri";

interface Telefon {
  id: string;
  platform: string;
  cihazAdi: string | null;
  kapali: BildirimTuru[];
  sonAcilis: string | null;
  ilkKayit: string | null;
}
interface TestSonucu {
  durum: "basarili" | "kismi" | "basarisiz" | "cihaz-yok";
  mesaj: string;
  sebepler?: string[];
}

const TELEFON_ANAHTAR = ["push-cihazlar"] as const;
const MASAUSTU_ANAHTAR = ["bildirim-tercihleri"] as const;
/** Test gönderimi sunucuda teslim makbuzunu da bekliyor (~8 sn + gidiş-dönüş). */
const TEST_TAHMINI_MS = 10_000;
/** Bu kadar süredir açılmamış telefon büyük olasılıkla artık kullanılmıyor. */
const ESKI_TELEFON_MS = 30 * 24 * 60 * 60_000;

const TUR_IKON: Record<BildirimTuru, ComponentType<{ className?: string }>> = {
  siparis: ShoppingBag,
  "baski-bitti": CheckCircle2,
  "baski-sorun": PauseCircle,
  stok: Package,
  filament: Disc3,
};
const TUR_RENK: Record<BildirimTuru, string> = {
  siparis: "text-emerald-500",
  "baski-bitti": "text-sky-500",
  "baski-sorun": "text-amber-500",
  stok: "text-rose-500",
  filament: "text-violet-500",
};

/**
 * Bildirim tercihleri — her cihaz kendi seçimini yapar.
 *   - Bu bilgisayar: ekrana düşen bildirimler + zil (yerel dosya).
 *   - Telefonlar: push (kayıt başına, veritabanında) — telefonun güncellenmesini beklemez,
 *     çünkü gönderimi masaüstü yapıyor.
 */
export function NotificationSettingsCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bell className="h-4 w-4" />
          Bildirimler
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Her cihazda hangi bildirimlerin geleceğini seç. Kapalı olanlar o cihazda görünmez.
        </p>
        <BuBilgisayar />
        <Telefonlar />
      </CardContent>
    </Card>
  );
}

/** Aç/kapa çipleri — kapalı tür soluk ve kesik kenarlı, simgesi zile döner. */
function TurCipleri({
  turler,
  kapali,
  onDegis,
}: {
  turler: readonly BildirimTuruBilgisi[];
  kapali: readonly BildirimTuru[];
  onDegis: (tur: BildirimTuru, acik: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {turler.map((t, i) => {
        const acik = !kapali.includes(t.anahtar);
        const Ikon = TUR_IKON[t.anahtar];
        return (
          <button
            key={t.anahtar}
            type="button"
            role="switch"
            aria-checked={acik}
            title={t.aciklama}
            onClick={() => onDegis(t.anahtar, !acik)}
            style={{ animationDelay: `${i * 45}ms` }}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium select-none",
              "transition-[background-color,border-color,color,transform,box-shadow] duration-200 active:scale-95",
              "animate-in fade-in zoom-in-95 fill-mode-both duration-300",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              acik
                ? "border-primary/35 bg-primary/10 text-foreground shadow-sm hover:bg-primary/15"
                : "border-dashed border-border bg-transparent text-muted-foreground hover:border-foreground/30 hover:text-foreground"
            )}
          >
            <span className="relative inline-flex h-3.5 w-3.5 items-center justify-center">
              <Ikon
                className={cn(
                  "absolute h-3.5 w-3.5 transition-all duration-200",
                  TUR_RENK[t.anahtar],
                  acik ? "scale-100 opacity-100" : "scale-50 opacity-0"
                )}
              />
              <BellOff
                className={cn(
                  "absolute h-3.5 w-3.5 transition-all duration-200",
                  acik ? "scale-50 opacity-0" : "scale-100 opacity-100"
                )}
              />
            </span>
            <span className={cn("transition-opacity duration-200", !acik && "opacity-70")}>{t.ad}</span>
          </button>
        );
      })}
    </div>
  );
}

function acikOzeti(toplam: number, kapaliSayisi: number): string {
  const acik = toplam - kapaliSayisi;
  if (acik <= 0) return "Tüm bildirimler kapalı";
  if (kapaliSayisi === 0) return "Tüm bildirimler açık";
  return `${acik}/${toplam} bildirim açık`;
}

function BuBilgisayar() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ kapali: BildirimTuru[] }>({
    queryKey: MASAUSTU_ANAHTAR,
    queryFn: () => fetchJson("/api/notifications/tercihler"),
    staleTime: 60_000,
    refetchOnMount: true,
  });
  const kapali = data?.kapali ?? [];

  const kaydet = useMutation({
    mutationKey: ["bildirim-tercihleri-kaydet"],
    mutationFn: (yeni: BildirimTuru[]) =>
      fetchJson<{ kapali: BildirimTuru[] }>("/api/notifications/tercihler", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kapali: yeni }),
      }),
    onMutate: async (yeni) => {
      await qc.cancelQueries({ queryKey: MASAUSTU_ANAHTAR });
      const onceki = qc.getQueryData<{ kapali: BildirimTuru[] }>(MASAUSTU_ANAHTAR);
      qc.setQueryData(MASAUSTU_ANAHTAR, { kapali: yeni });
      return { onceki };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.onceki) qc.setQueryData(MASAUSTU_ANAHTAR, ctx.onceki);
      toast.error("Bildirim tercihi kaydedilemedi");
    },
    onSettled: () => {
      // Art arda tıklamada yalnız SONUNCU tazelesin — ara yanıt ekranı geri sardırmasın.
      if (qc.isMutating({ mutationKey: ["bildirim-tercihleri-kaydet"] }) <= 1) {
        void qc.invalidateQueries({ queryKey: MASAUSTU_ANAHTAR });
        void qc.invalidateQueries({ queryKey: ["notifications"] });
      }
    },
  });

  return (
    <CihazKutusu
      ikon={<Monitor className="h-4 w-4" />}
      baslik={<span className="font-medium">Bu bilgisayar</span>}
      altYazi={isLoading ? "…" : acikOzeti(MASAUSTU_BILDIRIM_TURLERI.length, kapali.length)}
      sira={0}
    >
      {isLoading ? (
        <Skeleton className="h-7 w-full rounded-full" />
      ) : (
        <TurCipleri
          turler={MASAUSTU_BILDIRIM_TURLERI}
          kapali={kapali}
          onDegis={(tur, acik) =>
            kaydet.mutate(acik ? kapali.filter((t) => t !== tur) : [...kapali, tur])
          }
        />
      )}
    </CihazKutusu>
  );
}

function CihazKutusu({
  ikon,
  baslik,
  altYazi,
  eylemler,
  children,
  sira,
  soluk,
  className,
}: {
  ikon: ReactNode;
  baslik: ReactNode;
  altYazi: ReactNode;
  eylemler?: ReactNode;
  children: ReactNode;
  sira: number;
  soluk?: boolean;
  className?: string;
}) {
  return (
    <div
      style={{ animationDelay: `${sira * 60}ms` }}
      className={cn(
        "rounded-lg border bg-card/50 p-3 space-y-2.5 transition-[opacity,transform,border-color] duration-200",
        "animate-in fade-in slide-in-from-bottom-1 fill-mode-both duration-400",
        "hover:border-foreground/15",
        soluk && "opacity-80",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {ikon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm leading-tight">{baslik}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{altYazi}</div>
        </div>
        {eylemler && <div className="flex shrink-0 items-center gap-1">{eylemler}</div>}
      </div>
      {children}
    </div>
  );
}

/** Adı verilmemiş telefonlara okunur ad: "iPhone", ikiden fazlaysa "iPhone 2". */
function varsayilanAdlar(telefonlar: readonly Telefon[]): Map<string, string> {
  const taban = (p: string) => (p === "ios" ? "iPhone" : p === "android" ? "Android telefon" : "Telefon");
  const gruplar = new Map<string, Telefon[]>();
  for (const t of telefonlar) {
    if (t.cihazAdi) continue; // adı verilmiş telefon numaralandırmaya girmez
    const k = taban(t.platform);
    gruplar.set(k, [...(gruplar.get(k) ?? []), t]);
  }
  const out = new Map<string, string>();
  for (const [ad, liste] of gruplar) {
    const sirali = [...liste].sort((a, b) => (a.ilkKayit ?? "").localeCompare(b.ilkKayit ?? ""));
    sirali.forEach((t, i) => out.set(t.id, sirali.length > 1 ? `${ad} ${i + 1}` : ad));
  }
  return out;
}

function Telefonlar() {
  const { data, isLoading, isError, refetch } = useQuery<{ telefonlar: Telefon[] }>({
    queryKey: TELEFON_ANAHTAR,
    queryFn: () => fetchJson("/api/push/cihazlar"),
    staleTime: 30_000,
    refetchOnMount: true,
  });
  const telefonlar = data?.telefonlar ?? [];
  const adlar = varsayilanAdlar(telefonlar);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-[92px] w-full rounded-lg" />
      </div>
    );
  }
  if (isError) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm animate-in fade-in duration-300">
        <span>Telefon listesi alınamadı.</span>
        <Button size="sm" variant="outline" onClick={() => void refetch()}>
          Tekrar dene
        </Button>
      </div>
    );
  }
  if (telefonlar.length === 0) {
    return (
      <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 animate-in fade-in slide-in-from-bottom-1 duration-400">
        <p className="text-sm font-medium flex items-center gap-2">
          <Smartphone className="h-4 w-4 text-amber-500" />
          Kayıtlı telefon yok
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Telefondaki uygulamayı aç ve bildirim izni ver.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {telefonlar.map((t, i) => (
        <TelefonSatiri key={t.id} telefon={t} varsayilanAd={adlar.get(t.id) ?? "Telefon"} sira={i + 1} />
      ))}
    </div>
  );
}

function TelefonSatiri({
  telefon,
  varsayilanAd,
  sira,
}: {
  telefon: Telefon;
  varsayilanAd: string;
  sira: number;
}) {
  const qc = useQueryClient();
  const reduceMotion = usePrefersReducedMotion();
  const [adDuzenle, setAdDuzenle] = useState(false);
  const [adTaslak, setAdTaslak] = useState("");
  const [silSor, setSilSor] = useState(false);
  const [cikiyor, setCikiyor] = useState(false);
  const [ilerleme, setIlerleme] = useState(0);
  const [testSonucu, setTestSonucu] = useState<TestSonucu | null>(null);
  const zamanlayici = useRef<number | null>(null);
  const [simdiMs] = useState(() => Date.now());

  const ad = telefon.cihazAdi || varsayilanAd;
  const sonAcilisMs = telefon.sonAcilis ? new Date(telefon.sonAcilis).getTime() : NaN;
  const eski = Number.isFinite(sonAcilisMs) && simdiMs - sonAcilisMs > ESKI_TELEFON_MS;

  /** Listeyi yerinde güncelle (sunucu yanıtını beklemeden). */
  function yerindeGuncelle(degis: (t: Telefon) => Telefon | null) {
    qc.setQueryData<{ telefonlar: Telefon[] }>(TELEFON_ANAHTAR, (eskiVeri) =>
      eskiVeri
        ? {
            telefonlar: eskiVeri.telefonlar
              .map((t) => (t.id === telefon.id ? degis(t) : t))
              .filter((t): t is Telefon => t !== null),
          }
        : eskiVeri
    );
  }

  const guncelle = useMutation({
    mutationKey: ["push-cihaz-guncelle", telefon.id],
    mutationFn: (degisiklik: { kapali?: BildirimTuru[]; cihazAdi?: string }) =>
      fetchJson("/api/push/cihazlar", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: telefon.id, ...degisiklik }),
      }),
    onMutate: async (degisiklik) => {
      await qc.cancelQueries({ queryKey: TELEFON_ANAHTAR });
      const onceki = qc.getQueryData<{ telefonlar: Telefon[] }>(TELEFON_ANAHTAR);
      yerindeGuncelle((t) => ({
        ...t,
        ...(degisiklik.kapali ? { kapali: degisiklik.kapali } : {}),
        ...(degisiklik.cihazAdi !== undefined ? { cihazAdi: degisiklik.cihazAdi.trim() || null } : {}),
      }));
      return { onceki };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.onceki) qc.setQueryData(TELEFON_ANAHTAR, ctx.onceki);
      toast.error("Telefon tercihi kaydedilemedi");
    },
    onSettled: () => {
      if (qc.isMutating({ mutationKey: ["push-cihaz-guncelle", telefon.id] }) <= 1) {
        void qc.invalidateQueries({ queryKey: TELEFON_ANAHTAR });
      }
    },
  });

  const sil = useMutation({
    mutationFn: () =>
      fetchJson("/api/push/cihazlar", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: telefon.id }),
      }),
    onMutate: () => setCikiyor(true),
    onSuccess: () => {
      // Satır önce kayarak kaybolsun, sonra listeden düşsün.
      window.setTimeout(() => yerindeGuncelle(() => null), reduceMotion ? 0 : 220);
      toast.success(`${ad} kaldırıldı`);
    },
    onError: () => {
      setCikiyor(false);
      toast.error("Telefon kaldırılamadı");
    },
  });

  const test = useMutation({
    mutationFn: () =>
      fetchJson<TestSonucu>("/api/push/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cihaz: telefon.id }),
      }),
    onMutate: () => {
      setTestSonucu(null);
      setIlerleme(0);
    },
    onSuccess: (r) => {
      setTestSonucu(r);
      if (r.durum === "cihaz-yok") void qc.invalidateQueries({ queryKey: TELEFON_ANAHTAR });
    },
    onError: () =>
      setTestSonucu({ durum: "basarisiz", mesaj: "Test gönderilemedi. İnternet bağlantını kontrol et." }),
    onSettled: () => setIlerleme(100),
  });

  // Çubuk tahmini süreye göre dolar, %95'te bekler; gerçek yanıt gelince tamamlanır.
  useEffect(() => {
    if (!test.isPending) return;
    const basla = performance.now();
    const adim = () => {
      setIlerleme(Math.min(0.95, (performance.now() - basla) / TEST_TAHMINI_MS) * 100);
      zamanlayici.current = window.setTimeout(adim, reduceMotion ? 400 : 80);
    };
    adim();
    return () => {
      if (zamanlayici.current) window.clearTimeout(zamanlayici.current);
    };
  }, [test.isPending, reduceMotion]);

  function adKaydet() {
    const yeni = adTaslak.trim();
    setAdDuzenle(false);
    if (yeni === (telefon.cihazAdi ?? "")) return;
    guncelle.mutate({ cihazAdi: yeni });
  }

  const baslik = adDuzenle ? (
    <Input
      autoFocus
      value={adTaslak}
      maxLength={40}
      placeholder={varsayilanAd}
      onChange={(e) => setAdTaslak(e.target.value)}
      onBlur={adKaydet}
      onKeyDown={(e) => {
        if (e.key === "Enter") adKaydet();
        if (e.key === "Escape") setAdDuzenle(false);
      }}
      className="h-7 max-w-[240px] text-sm animate-in fade-in zoom-in-95 duration-150"
    />
  ) : (
    <button
      type="button"
      onClick={() => {
        setAdTaslak(telefon.cihazAdi ?? "");
        setAdDuzenle(true);
      }}
      className="group inline-flex max-w-full items-center gap-1.5 rounded font-medium text-left transition-colors hover:text-primary"
      title="Adını değiştir"
    >
      <span className="truncate">{ad}</span>
      <Pencil className="h-3 w-3 shrink-0 opacity-0 transition-opacity duration-150 group-hover:opacity-70" />
    </button>
  );

  const altYazi = eski ? (
    <span className="text-amber-500">Uzun süredir açılmadı · {formatRelativeTime(telefon.sonAcilis)}</span>
  ) : telefon.sonAcilis ? (
    <>Son açılış {formatRelativeTime(telefon.sonAcilis)}</>
  ) : (
    <>Kayıtlı</>
  );

  const eylemler = silSor ? (
    <div className="flex items-center gap-1 animate-in fade-in slide-in-from-right-1 duration-200">
      <span className="text-xs text-muted-foreground mr-1 hidden sm:inline">Kaldırılsın mı?</span>
      <Button size="sm" variant="destructive" className="h-7 px-2" disabled={sil.isPending} onClick={() => sil.mutate()}>
        Kaldır
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setSilSor(false)}>
        Vazgeç
      </Button>
    </div>
  ) : (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        disabled={test.isPending}
        onClick={() => test.mutate()}
        title="Bu telefona test bildirimi gönder"
      >
        <Send className={cn("h-3.5 w-3.5 mr-1", test.isPending && "animate-pulse")} />
        {test.isPending ? "Gönderiliyor" : "Test"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
        onClick={() => setSilSor(true)}
        title="Bu telefonu kaldır"
        aria-label="Bu telefonu kaldır"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </>
  );

  return (
    <CihazKutusu
      ikon={<Smartphone className="h-4 w-4" />}
      baslik={baslik}
      altYazi={altYazi}
      eylemler={eylemler}
      sira={sira}
      soluk={eski}
      className={cn(cikiyor && "pointer-events-none -translate-x-2 scale-[0.98] opacity-0")}
    >
      <TurCipleri
        turler={TELEFON_BILDIRIM_TURLERI}
        kapali={telefon.kapali}
        onDegis={(tur, acik) =>
          guncelle.mutate({
            kapali: acik ? telefon.kapali.filter((t) => t !== tur) : [...telefon.kapali, tur],
          })
        }
      />

      {silSor && (
        <p className="text-[11px] text-muted-foreground animate-in fade-in duration-200">
          Uygulama o telefonda yeniden açılırsa tekrar eklenir.
        </p>
      )}

      {test.isPending && (
        <div className="space-y-1 animate-in fade-in duration-200">
          <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-100 ease-linear"
              style={{ width: `${ilerleme}%` }}
            />
          </div>
          <p className="text-[11px] text-muted-foreground tabular-nums">
            Telefona ulaşması bekleniyor · %{Math.round(ilerleme)}
          </p>
        </div>
      )}

      {testSonucu && !test.isPending && (
        <div
          className={cn(
            "flex items-start gap-2 rounded-md border px-2.5 py-2 text-xs animate-in fade-in zoom-in-95 duration-300",
            testSonucu.durum === "basarili"
              ? "border-emerald-500/30 bg-emerald-500/5"
              : "border-amber-500/40 bg-amber-500/5"
          )}
        >
          {testSonucu.durum === "basarili" ? (
            <Check className="h-3.5 w-3.5 shrink-0 mt-px text-emerald-500" />
          ) : (
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-px text-amber-500" />
          )}
          <div>
            <p className="font-medium">{testSonucu.mesaj}</p>
            {!!testSonucu.sebepler?.length && testSonucu.durum !== "basarili" && (
              <p className="text-muted-foreground mt-0.5">{testSonucu.sebepler.slice(0, 2).join(" · ")}</p>
            )}
          </div>
        </div>
      )}
    </CihazKutusu>
  );
}
