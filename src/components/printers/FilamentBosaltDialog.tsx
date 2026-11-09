"use client";
/**
 * FİLAMENT BOŞALT (Snapmaker U1) — yazıcı başında beklemeden, bilgisayardan.
 *
 * İki adım: kafaları seç → canlı ilerleme. Her kafa için yazıcı önce ısınır (ilerleme gerçek
 * sıcaklıktan), sonra filamenti geri çeker. İşlem yazıcıda yürür; pencere kapansa da biter.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ArrowUpFromLine, Check, Loader2, Thermometer } from "lucide-react";
import { cn } from "@/lib/utils";

interface Slot { slot: number; color: string; type: string; empty?: boolean }
type KafaDurumu =
  | { tur: "bekliyor" }
  | { tur: "isiniyor"; sicaklik: number | null; hedef: number | null }
  | { tur: "cekiliyor" }
  | { tur: "bitti" };

export function FilamentBosaltDialog({ printerId, printerName, onClose }: {
  printerId: string;
  printerName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const slotsQ = useQuery<{ slots: Slot[] }>({
    queryKey: ["printer-slots", printerId],
    queryFn: async () => {
      const r = await fetch(`/api/printers/${printerId}/slots`);
      if (!r.ok) throw new Error("Kafalar okunamadı");
      return r.json();
    },
    staleTime: 0,
  });
  const slots = useMemo(() => slotsQ.data?.slots ?? [], [slotsQ.data]);
  const [secili, setSecili] = useState<number[]>([]);
  const [adim, setAdim] = useState<"sec" | "calisiyor" | "tamam" | "hata">("sec");
  const [durumlar, setDurumlar] = useState<Record<number, KafaDurumu>>({});
  const [hata, setHata] = useState<string | null>(null);
  const calisiyorRef = useRef(false);

  const dolu = slots.filter((s) => !s.empty);
  const degistir = (k: number) =>
    setSecili((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k].sort((a, b) => a - b)));

  const baslat = useCallback(async () => {
    if (!secili.length || calisiyorRef.current) return;
    calisiyorRef.current = true;
    setAdim("calisiyor");
    setHata(null);
    setDurumlar(Object.fromEntries(secili.map((k) => [k, { tur: "bekliyor" } as KafaDurumu])));
    try {
      const res = await fetch(`/api/printers/${printerId}/filament`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kafalar: secili }),
      });
      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({}) as { error?: string });
        throw new Error((j as { error?: string }).error || "Filament boşaltılamadı.");
      }
      const okuyucu = res.body.getReader();
      const dec = new TextDecoder();
      let tampon = "";
      let sonuc: "tamam" | "hata" | null = null;
      for (;;) {
        const { value, done } = await okuyucu.read();
        if (done) break;
        tampon += dec.decode(value, { stream: true });
        let nl: number;
        while ((nl = tampon.indexOf("\n")) >= 0) {
          const satir = tampon.slice(0, nl).trim();
          tampon = tampon.slice(nl + 1);
          if (!satir) continue;
          let o: { asama: string; kafa?: number; sicaklik?: number | null; hedef?: number | null; mesaj?: string };
          try { o = JSON.parse(satir); } catch { continue; }
          const k = o.kafa;
          if (o.asama === "isiniyor" && typeof k === "number") {
            setDurumlar((d) => ({ ...d, [k]: { tur: "isiniyor", sicaklik: o.sicaklik ?? null, hedef: o.hedef ?? null } }));
          } else if (o.asama === "cekiliyor" && typeof k === "number") {
            setDurumlar((d) => ({ ...d, [k]: { tur: "cekiliyor" } }));
          } else if (o.asama === "bitti" && typeof k === "number") {
            setDurumlar((d) => ({ ...d, [k]: { tur: "bitti" } }));
          } else if (o.asama === "tamam") {
            sonuc = "tamam";
          } else if (o.asama === "hata") {
            sonuc = "hata";
            setHata(o.mesaj || "Filament boşaltılamadı.");
          }
        }
      }
      setAdim(sonuc === "tamam" ? "tamam" : "hata");
      if (sonuc === null) setHata("Bağlantı koptu — yazıcının ekranından kontrol et.");
    } catch (e) {
      setHata(e instanceof Error ? e.message : "Filament boşaltılamadı.");
      setAdim("hata");
    } finally {
      calisiyorRef.current = false;
      void qc.invalidateQueries({ queryKey: ["printer-slots", printerId] });
      void qc.invalidateQueries({ queryKey: ["printers"] });
    }
  }, [secili, printerId, qc]);

  const bitenSayisi = Object.values(durumlar).filter((d) => d.tur === "bitti").length;
  const renk = (k: number) => slots.find((s) => s.slot === k)?.color ?? "#9ca3af";

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <ArrowUpFromLine className="h-4 w-4 text-primary" /> Filament boşalt — {printerName}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {adim === "sec" ? "Boşaltılacak kafaları seç." : adim === "calisiyor" ? "Pencereyi kapatsan da yazıcıda devam eder." : ""}
          </p>
        </DialogHeader>

        {adim === "sec" && (
          slotsQ.isLoading ? (
            <div className="py-10 text-center"><Loader2 className="h-5 w-5 mx-auto animate-spin text-muted-foreground" /></div>
          ) : slots.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Kafalar okunamadı. Yazıcı açık mı?</p>
          ) : (
            <div className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                {slots.map((s, i) => {
                  const sec = secili.includes(s.slot);
                  return (
                    <button
                      key={s.slot}
                      disabled={!!s.empty}
                      onClick={() => degistir(s.slot)}
                      style={{ animationDelay: `${i * 45}ms` }}
                      className={cn(
                        "relative flex items-center gap-2.5 rounded-xl border p-2.5 text-left transition-all duration-200",
                        "motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1 active:scale-[0.98]",
                        s.empty ? "opacity-40 cursor-not-allowed" : "hover:border-primary/50",
                        sec && "border-primary bg-primary/10 ring-1 ring-primary/30",
                      )}
                    >
                      <span className="h-9 w-9 rounded-full border border-black/20 shadow-inner shrink-0" style={{ background: s.empty ? "transparent" : s.color }} />
                      <span className="min-w-0">
                        <span className="block text-sm font-semibold tabular-nums">{s.slot + 1}. kafa</span>
                        <span className="block text-[11px] text-muted-foreground truncate">{s.empty ? "boş" : s.type || "—"}</span>
                      </span>
                      <span className={cn(
                        "absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border transition-all duration-200",
                        sec ? "bg-primary border-primary scale-100" : "border-border scale-90",
                      )}>
                        {sec && <Check className="h-3 w-3 text-primary-foreground" />}
                      </span>
                    </button>
                  );
                })}
              </div>
              {dolu.length > 1 && (
                <button
                  onClick={() => setSecili(secili.length === dolu.length ? [] : dolu.map((s) => s.slot))}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {secili.length === dolu.length ? "Seçimi temizle" : "Hepsini seç"}
                </button>
              )}
            </div>
          )
        )}

        {adim !== "sec" && (
          <div className="space-y-2">
            {adim === "calisiyor" && (
              <div className="flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
                <span>Boşaltılıyor…</span>
                <span>{bitenSayisi} / {secili.length} kafa</span>
              </div>
            )}
            {secili.map((k, i) => {
              const d = durumlar[k] ?? { tur: "bekliyor" };
              const yuzde = d.tur === "isiniyor" && d.sicaklik != null && d.hedef
                ? Math.max(4, Math.min(100, Math.round((d.sicaklik / d.hedef) * 100)))
                : null;
              return (
                <div
                  key={k}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="rounded-xl border p-2.5 space-y-2 motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-1"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="h-7 w-7 rounded-full border border-black/20 shrink-0" style={{ background: renk(k) }} />
                    <span className="text-sm font-semibold tabular-nums">{k + 1}. kafa</span>
                    <span className="ml-auto flex items-center gap-1.5 text-xs">
                      {d.tur === "bekliyor" && <span className="text-muted-foreground">Sırada</span>}
                      {d.tur === "isiniyor" && (
                        <span className="flex items-center gap-1 text-amber-500 tabular-nums">
                          <Thermometer className="h-3.5 w-3.5" />
                          {d.sicaklik != null ? `${d.sicaklik}°` : "Isınıyor"}{d.hedef ? ` / ${d.hedef}°` : ""}
                        </span>
                      )}
                      {d.tur === "cekiliyor" && (
                        <span className="flex items-center gap-1 text-primary">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Geri çekiliyor
                        </span>
                      )}
                      {d.tur === "bitti" && (
                        <span className="flex items-center gap-1 text-emerald-500 motion-safe:animate-in motion-safe:zoom-in-75">
                          <Check className="h-3.5 w-3.5" /> Bitti
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="relative h-1.5 overflow-hidden rounded-full bg-muted">
                    {d.tur === "bitti" ? (
                      <div className="absolute inset-0 rounded-full bg-emerald-500 transition-all duration-500" />
                    ) : d.tur === "cekiliyor" ? (
                      <div className="absolute inset-y-0 w-1/3 rounded-full bg-primary motion-safe:[animation:indeterminate-bar_1.4s_ease-in-out_infinite]" />
                    ) : d.tur === "isiniyor" ? (
                      yuzde != null
                        ? <div className="absolute inset-y-0 left-0 rounded-full bg-amber-500 transition-[width] duration-700" style={{ width: `${yuzde}%` }} />
                        : <div className="absolute inset-y-0 w-1/4 rounded-full bg-amber-500/70 motion-safe:[animation:indeterminate-bar_1.6s_ease-in-out_infinite]" />
                    ) : null}
                  </div>
                </div>
              );
            })}

            {adim === "tamam" && (
              <div className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-2.5 text-sm motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95">
                <Check className="h-4 w-4 text-emerald-500 shrink-0" />
                Filament boşaltıldı — makarayı çıkarabilirsin.
              </div>
            )}
            {adim === "hata" && hata && (
              <div className="flex items-start gap-2 rounded-xl border border-destructive/45 bg-destructive/10 p-2.5 text-sm text-destructive motion-safe:animate-in motion-safe:fade-in">
                <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" /> {hata}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {adim === "sec" ? (
            <>
              <Button variant="outline" size="sm" onClick={onClose}>Vazgeç</Button>
              <Button size="sm" disabled={!secili.length} onClick={baslat}>
                <ArrowUpFromLine className="h-3.5 w-3.5 mr-1" />
                {secili.length ? `Boşalt (${secili.length} kafa)` : "Boşalt"}
              </Button>
            </>
          ) : (
            <Button size="sm" variant={adim === "calisiyor" ? "outline" : "default"} onClick={onClose}>
              {adim === "calisiyor" ? "Arka planda devam etsin" : "Kapat"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
