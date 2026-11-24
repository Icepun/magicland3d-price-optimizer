"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  Copy,
  Loader2,
  MapPin,
  Package,
  Printer,
  RotateCcw,
  Truck,
  User,
} from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";
import type { KargoGonderiOzeti } from "@/core/kargo-gonderisi";

interface Hazirlik {
  siparis: { id: string; no: string; iptal: boolean; shopifydaGonderildi: boolean };
  musteri: { ad: string; soyad: string; telefon: string; address1: string; address2: string; city: string; province: string; zip: string };
  oneri: {
    ad: string; soyad: string; telefon: string; il: string; ilce: string; mahalle: string; acikAdres: string;
    kontrol: Partial<Record<"il" | "ilce" | "telefon" | "adres" | "ad", string>>;
  };
  iller: { ad: string; ilceler: string[] }[];
  mahalleler: string[];
  icerik: { ad: string; adet: number }[];
  ortam: "test" | "prod";
  hesapHazir: boolean;
  acikGonderi: KargoGonderiOzeti | null;
}

type Form = { ad: string; soyad: string; telefon: string; il: string; ilce: string; mahalle: string; adres: string };
type Asama = "form" | "aciliyor" | "basiliyor" | "bitti";

const sade = (s: string) => s.toLocaleUpperCase("tr-TR").replace(/\s+/g, " ").trim();

/**
 * KARGO OLUŞTUR — solda müşterinin Shopify'a yazdığı, sağda HepsiJet'e gidecek alanlar
 * (otomatik dolu, elle düzeltilir). Emin olunamayan alan sarı çerçeveyle işaretlenir.
 * Onaylanınca: gönderi açılır → etiket basılır (iki adım, ilerleme gösterilir).
 */
export function KargoOlusturDialog({
  siparisId,
  siparisNo,
  onClose,
}: {
  siparisId: string;
  siparisNo: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const hazirlik = useQuery<Hazirlik>({
    queryKey: ["kargo-hazirlik", siparisId],
    queryFn: () => fetchJson(`/api/kargo/hazirlik?siparisId=${encodeURIComponent(siparisId)}`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // Kullanıcı dokunana kadar form öneriden türetilir; ilk değişiklikte taslağa kopyalanır.
  const [taslak, setTaslak] = useState<Form | null>(null);
  const [dokunulan, setDokunulan] = useState<Set<keyof Form>>(() => new Set());
  const [asama, setAsama] = useState<Asama>("form");
  const [hata, setHata] = useState<string | null>(null);
  const [sonuc, setSonuc] = useState<{ gonderi: KargoGonderiOzeti; baski: { ok: boolean; mesaj?: string } | null } | null>(null);

  const h = hazirlik.data;
  const form: Form | null = taslak ?? (h ? oneridenForm(h) : null);

  const ilceler = useMemo(() => h?.iller.find((x) => sade(x.ad) === sade(form?.il ?? ""))?.ilceler ?? [], [h, form?.il]);
  const ilceDegisti = form != null && h != null && (form.il !== h.oneri.il || form.ilce !== h.oneri.ilce);
  const mahalleSorgusu = useQuery<{ mahalleler: string[] }>({
    queryKey: ["kargo-mahalleler", form?.il, form?.ilce],
    queryFn: () => fetchJson(`/api/kargo/mahalleler?il=${encodeURIComponent(form!.il)}&ilce=${encodeURIComponent(form!.ilce)}`),
    enabled: Boolean(form?.il && form?.ilce && ilceDegisti),
    staleTime: 24 * 60 * 60_000,
  });
  const mahalleler = ilceDegisti ? mahalleSorgusu.data?.mahalleler ?? [] : h?.mahalleler ?? [];

  const degistir = (alan: keyof Form, deger: string) => {
    setTaslak((onceki) => {
      const f = onceki ?? (h ? oneridenForm(h) : null);
      if (!f) return onceki;
      const yeni = { ...f, [alan]: deger };
      if (alan === "il") {
        yeni.ilce = "";
        yeni.mahalle = "";
      }
      if (alan === "ilce") yeni.mahalle = "";
      return yeni;
    });
    setDokunulan((d) => new Set(d).add(alan));
    setHata(null);
  };

  const uyari = (alan: "il" | "ilce" | "telefon" | "adres" | "ad"): string | null => {
    if (!h) return null;
    const ilgili: (keyof Form)[] = alan === "ad" ? ["ad", "soyad"] : alan === "adres" ? ["adres"] : [alan];
    if (ilgili.some((x) => dokunulan.has(x))) return null; // kullanıcı düzelttiyse uyarı kalkar
    return h.oneri.kontrol[alan] ?? null;
  };
  const eksik = !form || !form.ad.trim() || !form.soyad.trim() || !form.telefon.trim() || !form.il || !form.ilce || form.adres.trim().length < 10;
  const engel = !h ? null : h.siparis.iptal ? "Sipariş iptal edilmiş." : !h.hesapHazir ? "hesap" : h.acikGonderi ? "acik" : null;
  const mesgul = asama === "aciliyor" || asama === "basiliyor";

  const [tekrarBasiliyor, setTekrarBasiliyor] = useState(false);
  const etiketBas = async (barkod: string, ilk = true) => {
    if (ilk) setAsama("basiliyor");
    try {
      const r = await fetchJson<{ basildi: string }>("/api/kargo/etiket", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ barkod, siparisNo }),
      });
      qc.setQueryData<{ basilanlar: Record<string, string> }>(["etiket-durumu"], (eski) =>
        eski ? { ...eski, basilanlar: { ...eski.basilanlar, [barkod]: r.basildi } } : eski
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, mesaj: e instanceof Error ? e.message : "Etiket basılamadı." };
    }
  };

  const olustur = async () => {
    if (!form || eksik || engel) return;
    setHata(null);
    setAsama("aciliyor");
    try {
      const r = await fetchJson<{ gonderi: KargoGonderiOzeti }>("/api/kargo/gonderi", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          siparisId,
          bas: false,
          alici: { ...form, mahalle: form.mahalle || null },
        }),
      });
      void qc.invalidateQueries({ queryKey: ["kargo-gonderileri"] });
      const baski = await etiketBas(r.gonderi.barkod);
      setSonuc({ gonderi: r.gonderi, baski });
      setAsama("bitti");
      if (baski.ok) toast.success("Kargo oluşturuldu, etiket basıldı");
      else toast.success("Kargo oluşturuldu");
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Kargo oluşturulamadı.");
      setAsama("form");
    }
  };

  const tekrarBas = async () => {
    if (!sonuc || tekrarBasiliyor) return;
    setTekrarBasiliyor(true);
    const baski = await etiketBas(sonuc.gonderi.barkod, false);
    setTekrarBasiliyor(false);
    setSonuc({ ...sonuc, baski });
    if (baski.ok) toast.success("Etiket basıldı");
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !mesgul && onClose()}>
      <DialogContent className="sm:max-w-4xl max-h-[92vh] overflow-hidden flex flex-col gap-4 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle className="flex items-center gap-2.5">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.9)]">
              <Truck className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-base">Kargo oluştur</span>
              <span className="block text-xs font-normal text-muted-foreground">
                {siparisNo} · HepsiJet
              </span>
            </span>
            {h?.ortam === "test" && (
              <span className="ml-auto mr-6 rounded-full bg-amber-500/12 px-2 py-0.5 text-[10px] font-semibold text-amber-400 ring-1 ring-amber-500/25 animate-in fade-in zoom-in-95 duration-300">
                Test ortamı
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {hazirlik.isLoading || (!form && !hazirlik.error) ? (
            <YukleniyorIskeleti />
          ) : hazirlik.error ? (
            <HataKutusu mesaj={hazirlik.error instanceof Error ? hazirlik.error.message : "Sipariş okunamadı."} onRetry={() => void hazirlik.refetch()} />
          ) : asama === "bitti" && sonuc ? (
            <Basarili sonuc={sonuc} basiliyor={tekrarBasiliyor} onTekrarBas={() => void tekrarBas()} onClose={onClose} />
          ) : h && form ? (
            <div className="space-y-4">
              {engel === "hesap" && (
                <Bilgi ton="uyari">
                  Önce gönderici bilgilerini gir.{" "}
                  <Link href="/api-settings" className="font-semibold underline underline-offset-2" onClick={onClose}>
                    Entegrasyonlar → HepsiJet
                  </Link>
                </Bilgi>
              )}
              {engel === "acik" && <Bilgi ton="bilgi">Bu siparişin kargosu zaten oluşturuldu ({h.acikGonderi?.barkod}).</Bilgi>}
              {engel && engel !== "hesap" && engel !== "acik" && <Bilgi ton="hata">{engel}</Bilgi>}
              {!engel && h.siparis.shopifydaGonderildi && (
                <Bilgi ton="uyari">Bu sipariş Shopify&apos;da zaten gönderildi olarak işaretli.</Bilgi>
              )}

              <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_auto_minmax(0,1.1fr)]">
                {/* Sol: müşterinin yazdığı */}
                <section className="rounded-2xl border border-white/[0.06] bg-muted/25 p-4 animate-in fade-in slide-in-from-left-2 duration-300 motion-reduce:animate-none">
                  <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    <User className="h-3.5 w-3.5" /> Müşterinin yazdığı
                  </p>
                  <dl className="space-y-2.5 text-sm">
                    <Ham etiket="Ad soyad" deger={`${h.musteri.ad} ${h.musteri.soyad}`.trim()} />
                    <Ham etiket="Telefon" deger={h.musteri.telefon} mono />
                    <Ham etiket="Adres 1" deger={h.musteri.address1} />
                    <Ham etiket="Adres 2" deger={h.musteri.address2} />
                    <Ham etiket="Şehir" deger={h.musteri.city} />
                    <Ham etiket="İl" deger={h.musteri.province} />
                    <Ham etiket="Posta kodu" deger={h.musteri.zip} mono />
                  </dl>
                </section>

                <div className="hidden md:flex items-center">
                  <span className="grid size-8 place-items-center rounded-full bg-primary/10 text-primary animate-in zoom-in-50 duration-500">
                    <ArrowRight className="h-4 w-4" />
                  </span>
                </div>

                {/* Sağ: HepsiJet'e gidecek */}
                <section className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-4 animate-in fade-in slide-in-from-right-2 duration-300 motion-reduce:animate-none">
                  <p className="mb-3 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary">
                    <MapPin className="h-3.5 w-3.5" /> HepsiJet&apos;e gidecek
                  </p>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
                    <Alan etiket="Ad" uyari={uyari("ad")} sira={0}>
                      <input className={girdiSinifi(uyari("ad"))} value={form.ad} onChange={(e) => degistir("ad", e.target.value)} disabled={mesgul} />
                    </Alan>
                    <Alan etiket="Soyad" sira={1}>
                      <input className={girdiSinifi(uyari("ad"))} value={form.soyad} onChange={(e) => degistir("soyad", e.target.value)} disabled={mesgul} />
                    </Alan>
                    <Alan etiket="Telefon" uyari={uyari("telefon")} genis sira={2}>
                      <input
                        className={cn(girdiSinifi(uyari("telefon")), "font-mono")}
                        value={form.telefon}
                        onChange={(e) => degistir("telefon", e.target.value)}
                        placeholder="05xx xxx xx xx"
                        inputMode="tel"
                        disabled={mesgul}
                      />
                    </Alan>
                    <Alan etiket="İl" uyari={uyari("il")} sira={3}>
                      <select className={girdiSinifi(uyari("il"))} value={form.il} onChange={(e) => degistir("il", e.target.value)} disabled={mesgul}>
                        <option value="">Seç…</option>
                        {h.iller.map((il) => (
                          <option key={il.ad} value={il.ad}>{il.ad}</option>
                        ))}
                      </select>
                    </Alan>
                    <Alan etiket="İlçe" uyari={uyari("ilce")} sira={4}>
                      <select className={girdiSinifi(uyari("ilce") ?? (!form.ilce ? "seç" : null))} value={form.ilce} onChange={(e) => degistir("ilce", e.target.value)} disabled={mesgul || !form.il}>
                        <option value="">Seç…</option>
                        {ilceler.map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    </Alan>
                    <Alan etiket="Mahalle" genis sira={5} ek={mahalleSorgusu.isFetching ? <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" /> : null}>
                      <select className={girdiSinifi(null)} value={form.mahalle} onChange={(e) => degistir("mahalle", e.target.value)} disabled={mesgul || !form.ilce}>
                        <option value="">Seçme (adreste yazıyor)</option>
                        {mahalleler.map((x) => (
                          <option key={x} value={x}>{x}</option>
                        ))}
                      </select>
                    </Alan>
                    <Alan etiket="Açık adres" uyari={uyari("adres")} genis sira={6}>
                      <textarea
                        className={cn(girdiSinifi(uyari("adres")), "min-h-[72px] resize-y leading-snug")}
                        value={form.adres}
                        onChange={(e) => degistir("adres", e.target.value)}
                        disabled={mesgul}
                      />
                    </Alan>
                  </div>
                </section>
              </div>

              {/* İçerik + sabitler */}
              <div className="flex flex-wrap items-center gap-1.5 text-xs animate-in fade-in duration-500">
                <Package className="h-3.5 w-3.5 text-muted-foreground" />
                {h.icerik.length ? (
                  h.icerik.map((k, i) => (
                    <span key={i} className="max-w-[260px] truncate rounded-full bg-muted/50 px-2 py-0.5 text-foreground/85" title={k.ad}>
                      {k.adet > 1 && <span className="font-semibold tabular-nums">{k.adet}× </span>}
                      {k.ad}
                    </span>
                  ))
                ) : (
                  <span className="text-muted-foreground">Ürün</span>
                )}
                <span className="ml-auto text-muted-foreground">1 koli · 1 desi</span>
              </div>

              {hata && <Bilgi ton="hata">{hata}</Bilgi>}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end">
                <Button variant="ghost" onClick={onClose} disabled={mesgul}>
                  Vazgeç
                </Button>
                <Button
                  onClick={() => void olustur()}
                  disabled={mesgul || eksik || Boolean(engel)}
                  className="relative min-w-[220px] overflow-hidden bg-gradient-to-r from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_10px_28px_-14px_rgba(122,126,255,0.95)] transition-transform active:scale-[0.98] disabled:opacity-60"
                >
                  {mesgul ? (
                    <Adimlar asama={asama} />
                  ) : (
                    <>
                      <Printer className="mr-1.5 h-4 w-4" /> Oluştur ve etiketi bas
                    </>
                  )}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function oneridenForm(h: Hazirlik): Form {
  return {
    ad: h.oneri.ad, soyad: h.oneri.soyad, telefon: h.oneri.telefon, il: h.oneri.il,
    ilce: h.oneri.ilce, mahalle: h.oneri.mahalle, adres: h.oneri.acikAdres,
  };
}

function girdiSinifi(uyari: string | null) {
  return cn(
    "w-full rounded-lg border bg-background/60 px-2.5 py-1.5 text-sm outline-none transition-[border-color,box-shadow] duration-200",
    "focus:border-primary/60 focus:shadow-[0_0_0_3px_rgba(155,92,255,0.18)] disabled:opacity-60",
    uyari ? "border-amber-400/70 shadow-[0_0_0_3px_rgba(251,191,36,0.12)]" : "border-border"
  );
}

function Alan({
  etiket,
  uyari,
  genis,
  sira,
  ek,
  children,
}: {
  etiket: string;
  uyari?: string | null;
  genis?: boolean;
  sira: number;
  ek?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label
      className={cn("block min-w-0 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none", genis && "col-span-2")}
      style={{ animationDelay: `${60 + sira * 40}ms`, animationFillMode: "both" }}
    >
      <span className="mb-1 flex items-center gap-1 text-[11px] text-muted-foreground">
        {etiket}
        {ek}
      </span>
      {children}
      {uyari && uyari !== "seç" && (
        <span className="mt-1 flex items-center gap-1 text-[10px] text-amber-400 animate-in fade-in duration-300">
          <AlertTriangle className="h-3 w-3 shrink-0" /> {uyari}
        </span>
      )}
    </label>
  );
}

function Ham({ etiket, deger, mono }: { etiket: string; deger: string; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[84px_minmax(0,1fr)] gap-2">
      <dt className="text-[11px] text-muted-foreground pt-0.5">{etiket}</dt>
      <dd className={cn("min-w-0 break-words", mono && "font-mono text-xs pt-0.5", !deger && "text-muted-foreground/60")}>{deger || "—"}</dd>
    </div>
  );
}

function Adimlar({ asama }: { asama: Asama }) {
  const adim = asama === "aciliyor" ? 1 : 2;
  return (
    <span className="flex items-center gap-2">
      <Loader2 className="h-4 w-4 animate-spin" />
      <span className="tabular-nums">{adim}/2</span>
      <span>{asama === "aciliyor" ? "Gönderi açılıyor…" : "Etiket basılıyor…"}</span>
      <span
        className="absolute bottom-0 left-0 h-0.5 bg-white/70 transition-[width] duration-700 ease-out"
        style={{ width: adim === 1 ? "45%" : "90%" }}
      />
    </span>
  );
}

function Bilgi({ ton, children }: { ton: "bilgi" | "uyari" | "hata"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl px-3 py-2 text-xs animate-in fade-in slide-in-from-top-1 duration-300",
        ton === "hata" && "bg-destructive/10 text-destructive",
        ton === "uyari" && "bg-amber-500/10 text-amber-300",
        ton === "bilgi" && "bg-primary/10 text-primary"
      )}
    >
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function HataKutusu({ mesaj, onRetry }: { mesaj: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 py-10 text-center animate-in fade-in duration-300">
      <span className="grid size-11 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="h-5 w-5" />
      </span>
      <p className="text-sm">{mesaj}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RotateCcw className="mr-1.5 h-3.5 w-3.5" /> Tekrar dene
      </Button>
    </div>
  );
}

function YukleniyorIskeleti() {
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-xs text-muted-foreground animate-in fade-in duration-300">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Sipariş ve adres hazırlanıyor…
      </p>
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1].map((k) => (
          <div key={k} className="space-y-2.5 rounded-2xl border border-white/[0.06] p-4">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="h-7 animate-pulse rounded-md bg-muted/40" style={{ animationDelay: `${(k * 5 + i) * 70}ms` }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Basarili({
  sonuc,
  basiliyor,
  onTekrarBas,
  onClose,
}: {
  sonuc: { gonderi: KargoGonderiOzeti; baski: { ok: boolean; mesaj?: string } | null };
  basiliyor: boolean;
  onTekrarBas: () => void;
  onClose: () => void;
}) {
  const [kopyalandi, setKopyalandi] = useState(false);
  const zamanlayici = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(zamanlayici.current), []);
  const kopyala = async () => {
    try {
      await navigator.clipboard.writeText(sonuc.gonderi.barkod);
      setKopyalandi(true);
      clearTimeout(zamanlayici.current);
      zamanlayici.current = setTimeout(() => setKopyalandi(false), 1600);
    } catch {
      toast.error("Kopyalanamadı");
    }
  };
  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <span className="relative grid size-16 place-items-center rounded-full bg-emerald-500/15 text-emerald-400 animate-in zoom-in-50 duration-500">
        <span className="absolute inset-0 rounded-full bg-emerald-500/20 animate-ping [animation-iteration-count:2] motion-reduce:animate-none" />
        <Check className="relative h-8 w-8" />
      </span>
      <div className="animate-in fade-in slide-in-from-bottom-2 duration-500">
        <p className="text-lg font-semibold">Kargo oluşturuldu</p>
        <p className="text-xs text-muted-foreground">
          {sonuc.gonderi.ortam === "test" ? "Test gönderisi · Shopify'a yazılmaz" : "Kurye paketi alınca Shopify'da gönderildi işaretlenecek"}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void kopyala()}
        className="group inline-flex items-center gap-2 rounded-xl border border-white/[0.08] bg-muted/30 px-4 py-2 font-mono text-base tracking-wider transition-all hover:border-primary/40 hover:bg-muted/50 active:scale-[0.98] animate-in fade-in zoom-in-95 duration-500"
        title="Barkodu kopyala"
      >
        {sonuc.gonderi.barkod}
        {kopyalandi ? <Check className="h-4 w-4 text-emerald-400 animate-in zoom-in-50" /> : <Copy className="h-4 w-4 text-muted-foreground transition-transform group-hover:scale-110" />}
      </button>
      {sonuc.baski?.ok ? (
        <p className="flex items-center gap-1.5 text-sm text-emerald-400 animate-in fade-in duration-500">
          <Printer className="h-4 w-4" /> Etiket basıldı
        </p>
      ) : sonuc.baski ? (
        <div className="space-y-2 animate-in fade-in duration-500">
          <p className="text-sm text-amber-300">{sonuc.baski.mesaj}</p>
          <Button size="sm" variant="outline" onClick={onTekrarBas} disabled={basiliyor}>
            {basiliyor ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Printer className="mr-1.5 h-3.5 w-3.5" />}
            {basiliyor ? "Basılıyor…" : "Etiketi bas"}
          </Button>
        </div>
      ) : null}
      <Button onClick={onClose} className="mt-2 min-w-[140px]">
        Kapat
      </Button>
    </div>
  );
}
