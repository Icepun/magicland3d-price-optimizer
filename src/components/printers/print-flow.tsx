"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Layers, Loader2, AlertTriangle, Minus, Plus, ArrowRight, Check, Play } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Baskı akışının PAYLAŞILAN parçaları — hem Yazıcılar sayfası (StartModal/CustomPrint) hem de
 * Ürünler baskı modalı (ProductPrintModal) bunları kullanır. Renk eşleme (SlotStep) ve NDJSON
 * akışı (runPrintStream) tek yerde durur → Bambu/Snapmaker her iki girişten de basabilir.
 */

export interface PrintableModel {
  fileId: string;
  productId: string;
  productName: string;
  imageUrl: string | null;
  label: string | null;
  originalName: string;
  sizeBytes: number;
  gramaj: number | null;
  // Seçici drill-down için (opsiyonel — eski çağrılar etkilenmez):
  alias?: string | null;
  variantGroupId?: string | null;
  variantGroupName?: string | null;
  variantLabel?: string | null;
  /** storedPath dosya adı — "tüm varyantlara uygula" ile paylaşılan dosyada EŞİTTİR (dedup anahtarı). */
  shareKey?: string;
}
export interface PrinterSlot { slot: number; color: string; type: string; empty?: boolean }
export type PrintProg = { stage: "download" | "status" | "upload" | "start" | "confirm" | "done"; pct: number | null };
export type PrintPrefs = { timelapse: boolean; bedLeveling: boolean; flowCali: boolean };
interface FileColor { index: number; hex: string; type: string; grams: number | null }
interface ColorInfo { colors: FileColor[]; source: string; fileKind: "gcode" | "3mf" | "other"; originalName?: string; missing?: boolean }

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error(body?.error || `${url} ${r.status}`);
  }
  return r.json() as Promise<T>;
}

/**
 * Modeli yazıcıya yükle + baskıyı başlat (NDJSON akışını satır satır oku → ilerleme).
 * Başarıda çözülür, hata mesajıyla throw eder. Toast/kapatma/invalidate çağırana bırakılır.
 */
export async function runPrintStream(
  fileId: string,
  opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs },
  onProgress: (p: PrintProg) => void,
): Promise<void> {
  const res = await fetch(`/api/models/${fileId}/print`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ amsMapping: opts.amsMapping, useAms: opts.useAms, prefs: opts.prefs }),
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}) as { error?: string });
    throw new Error((j as { error?: string }).error || `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let errMsg: string | null = null;
  let ok = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let ev: { stage: string; pct?: number | null; message?: string };
      try { ev = JSON.parse(line); } catch { continue; }
      if (ev.stage === "error") errMsg = ev.message || "Baskı başlatılamadı";
      else if (ev.stage === "done") ok = true;
      else if (ev.stage === "status" || ev.stage === "start" || ev.stage === "confirm") onProgress({ stage: ev.stage, pct: null });
      else if (ev.stage === "download") onProgress({ stage: "download", pct: ev.pct ?? null }); // R2 → sunucu (gerçek %)
      else onProgress({ stage: "upload", pct: ev.pct ?? null });
    }
  }
  if (errMsg) throw new Error(errMsg);
  if (!ok) throw new Error("Baskı tamamlanmadı (akış beklenmedik kapandı)");
  onProgress({ stage: "done", pct: 100 });
}

export function PrintProgress({ p }: { p: PrintProg }) {
  const label =
    p.stage === "download" ? "Buluttan indiriliyor…"
      : p.stage === "status" ? "Yazıcı kontrol ediliyor…"
        : p.stage === "start" ? "Baskı komutu gönderiliyor…"
          : p.stage === "confirm" ? "Yazıcı baskıya hazırlanıyor…"
            : p.stage === "done" ? "Başlatıldı 🎉"
              : "Yazıcıya yükleniyor…";
  const showPct = (p.stage === "upload" || p.stage === "download") && p.pct != null;
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground flex items-center gap-1.5">
          {p.stage !== "done" && <Loader2 className="h-3 w-3 animate-spin" />}{label}
        </span>
        {showPct && <span className="tabular-nums font-semibold">{p.pct}%</span>}
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        {showPct ? (
          <div className="h-full bg-primary rounded-full transition-all duration-200" style={{ width: `${p.pct}%` }} />
        ) : (
          <div className="h-full w-1/2 bg-primary/70 rounded-full animate-pulse" />
        )}
      </div>
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec((hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** Gözle uyumlu ağırlıklı renk mesafesi (düşük = benzer). */
function colorDistance(a: string, b: string): number {
  const ra = hexToRgb(a), rb = hexToRgb(b);
  if (!ra || !rb) return Number.MAX_SAFE_INTEGER;
  const rmean = (ra[0] + rb[0]) / 2;
  const dr = ra[0] - rb[0], dg = ra[1] - rb[1], db = ra[2] - rb[2];
  return Math.sqrt((2 + rmean / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rmean) / 256) * db * db);
}
function nearestSlotId(hex: string, slots: PrinterSlot[]): number | null {
  const usable = slots.filter((s) => !s.empty && hexToRgb(s.color));
  if (!usable.length) return null;
  let best = usable[0], bestD = colorDistance(hex, usable[0].color);
  for (const s of usable) { const d = colorDistance(hex, s.color); if (d < bestD) { bestD = d; best = s; } }
  return best.slot;
}

export function SlotStep({
  printerId, model, isBambu, isSnapmaker, printing, progress, onBack, onClose, onConfirm,
}: {
  printerId: string; model: PrintableModel; isBambu: boolean; isSnapmaker?: boolean; printing: boolean; progress: PrintProg | null;
  onBack: () => void; onClose: () => void;
  onConfirm: (opts: { amsMapping?: number[]; useAms?: boolean; prefs?: PrintPrefs }) => void;
}) {
  // Slotlar HER AÇILIŞTA makineden taze okunur + ekran açıkken 5sn'de bir yenilenir —
  // makinede filament/renk değiştirirsen buradaki çipler de canlı güncellenir.
  const slotsQ = useQuery<{ type: string; slots: PrinterSlot[]; error?: string }>({
    queryKey: ["printer-slots", printerId],
    queryFn: () => fetchJson(`/api/printers/${printerId}/slots`),
    staleTime: 0,
    refetchOnMount: "always",
    refetchInterval: 5000,
  });
  const colorsQ = useQuery<ColorInfo>({
    queryKey: ["model-colors", model.fileId],
    queryFn: () => fetchJson(`/api/models/${model.fileId}/colors`),
  });
  const isLoading = slotsQ.isLoading || colorsQ.isLoading;

  const slots = useMemo(() => slotsQ.data?.slots ?? [], [slotsQ.data]);
  // Slot okunamazsa numarayla yine de eşlemek için 4 jenerik slot
  const pickSlots: PrinterSlot[] = slots.length
    ? slots
    : [0, 1, 2, 3].map((n) => ({ slot: n, color: "#9ca3af", type: "", empty: false }));

  const fileColors = useMemo(() => colorsQ.data?.colors ?? [], [colorsQ.data]);
  const usingFile = fileColors.length > 0;
  const fileKind = colorsQ.data?.fileKind;
  // Ham .gcode'da (Bambu) AMS eşlemesi UYGULANMAZ (sıra dilimde sabit, .3mf'te uygulanır) → uyar.
  const rawGcodeBambu = isBambu && fileKind === "gcode";

  const [manualCount, setManualCount] = useState(1);
  const [useAms, setUseAms] = useState(true);
  const [prefs, setPrefs] = useState<PrintPrefs>({ timelapse: false, bedLeveling: false, flowCali: false });
  const [assign, setAssign] = useState<number[]>([]); // printColors sırasına paralel: seçilen slot id

  const printColors: FileColor[] = useMemo(
    () => (usingFile ? fileColors : Array.from({ length: manualCount }, (_, i) => ({ index: i, hex: "#9ca3af", type: "", grams: null }))),
    [usingFile, fileColors, manualCount]
  );

  // Otomatik eşleme.
  // ⚠️ Snapmaker (tool-changer): kafa↔slot↔renk eşlemesi dilimleyicide (Orca) gcode'a GÖMÜLÜ.
  //    Renge göre "en yakın yüklü slot"a remap YAPMA → yanlış kafaya gönderir, o kafa ısınmaz,
  //    filament hareket etmez → "Filament Anomaly / runout" hatası. Varsayılan = IDENTITY
  //    (dilimlendiği kafa). Kullanıcı isterse elle değiştirir.
  //    Bambu (AMS, flush): her renk herhangi bir slottan beslenebilir → renge göre en yakın slot.
  useEffect(() => {
    if (isLoading) return;
    setAssign((prev) => {
      if (prev.length === printColors.length && prev.every((v) => v != null)) return prev;
      return printColors.map((c, i) => {
        if (!isBambu) return c.index; // Snapmaker: dilimlendiği gibi (identity)
        const near = usingFile && slots.length ? nearestSlotId(c.hex, slots) : null;
        return near != null ? near : (pickSlots[i % pickSlots.length]?.slot ?? i);
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, printColors.length, usingFile, slots.length]);

  const setOne = (i: number, slot: number) => setAssign((prev) => { const n = [...prev]; n[i] = slot; return n; });
  const setCount = (n: number) => setManualCount(Math.max(1, Math.min(4, n)));

  // Atamalar dolmadan başlatma (eski `?? 0` sessizce kafa/slot 1'e düşüyordu); tool-changer'da
  // (Snapmaker) iki rengi AYNI kafaya atamak her zaman yanlış → engelle.
  const assignReady = assign.length === printColors.length && assign.every((v) => v != null);
  const dupHeads = !!isSnapmaker && printColors.length > 1 && assignReady && new Set(assign).size !== assign.length;

  const start = () => {
    // ams_mapping: dilimleyici filament index'ine göre yerleştir, boşlukları -1 ile doldur
    const maxIdx = printColors.reduce((m, c) => Math.max(m, c.index), 0);
    const map = Array.from({ length: maxIdx + 1 }, () => -1);
    printColors.forEach((c, i) => { map[c.index] = assign[i] ?? 0; });
    if (isBambu) onConfirm(useAms ? { useAms: true, amsMapping: map, prefs } : { useAms: false, prefs });
    else onConfirm({ amsMapping: map, prefs }); // Snapmaker: kafa eşlemesi → route'ta gcode tool remap
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !printing && onClose()}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Layers className="h-4 w-4 text-primary" /> Renk Eşleme — {model.productName}</DialogTitle>
          <p className="text-xs text-muted-foreground mt-1">
            {isBambu
              ? "Renkler baskı dosyasından okundu. Her rengi bir AMS slotuna ata."
              : "Renkler baskı dosyasından okundu. Her rengi bir kafaya (slot) ata — gcode bu seçime göre ayarlanır."}
          </p>
        </DialogHeader>

        {isLoading ? (
          <div className="py-10 text-center text-muted-foreground"><Loader2 className="h-4 w-4 mx-auto animate-spin" /></div>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-3">
            {slots.length > 0 ? (
              <div>
                <p className="text-[11px] text-muted-foreground mb-1.5">
                  Yazıcıdaki slotlar (canlı) — rengi değiştirmek için yazıcı ekranını kullan
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {slots.map((s) => (
                    <span key={s.slot} className="inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]">
                      <span className="font-bold tabular-nums">{s.slot + 1}</span>
                      <span className="h-4 w-4 rounded-full border border-black/20 shrink-0" style={{ background: s.color }} />
                      {s.empty ? "boş" : s.type || "—"}
                    </span>
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                Yazıcıdaki renkler okunamadı. Numarayla eşleyebilirsin.
              </p>
            )}

            {!usingFile && (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2.5 space-y-2">
                <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
                  {colorsQ.data?.missing ? "Dosya bu cihazda yok." : "Dosyadan renk okunamadı — renk sayısını elle seç."}
                </p>
                <div className="flex items-center gap-2">
                  <span className="text-xs">Renk sayısı</span>
                  <div className="flex items-center gap-1 ml-auto">
                    <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCount(manualCount - 1)} disabled={manualCount <= 1}><Minus className="h-3.5 w-3.5" /></Button>
                    <span className="w-6 text-center font-bold tabular-nums">{manualCount}</span>
                    <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => setCount(manualCount + 1)} disabled={manualCount >= 4}><Plus className="h-3.5 w-3.5" /></Button>
                  </div>
                </div>
              </div>
            )}

            <div className="space-y-1.5">
              {usingFile && (
                <p className="text-[11px] text-muted-foreground truncate">
                  Baskıda <b>{printColors.length}</b> renk · <span className="font-mono">{colorsQ.data?.originalName}</span>
                </p>
              )}
              {printColors.map((c, i) => {
                const chosen = assign[i];
                return (
                  <div key={i} className="flex items-center gap-2.5 rounded-lg border p-2">
                    <div className="flex items-center gap-2 w-[124px] shrink-0">
                      <span className="h-7 w-7 rounded-md border shadow-inner shrink-0" style={{ background: c.hex }} />
                      <div className="min-w-0">
                        <p className="text-xs font-medium truncate">Renk {i + 1}</p>
                        <p className="text-[10px] text-muted-foreground truncate font-mono">
                          {(c.type ? `${c.type} ` : "") + (usingFile ? c.hex : "")}{c.grams != null ? ` · ${c.grams}g` : ""}
                        </p>
                      </div>
                    </div>
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <div className="flex gap-1.5 flex-wrap flex-1">
                      {pickSlots.map((s) => {
                        const sel = chosen === s.slot;
                        return (
                          <button
                            key={s.slot}
                            onClick={() => setOne(i, s.slot)}
                            title={`${isBambu ? "Slot" : "Kafa"} ${s.slot + 1}${s.type ? ` · ${s.type}` : ""}`}
                            className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-[11px] transition-colors", sel ? "border-primary bg-primary/10 ring-1 ring-primary/30" : "border-border hover:bg-muted")}
                          >
                            <span className="font-bold tabular-nums">{s.slot + 1}</span>
                            <span className="h-3 w-3 rounded-full border border-black/10" style={{ background: s.color }} />
                            {sel && <Check className="h-3 w-3 text-primary" />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {rawGcodeBambu && printColors.length > 1 ? (
              <div className="rounded-lg border border-destructive/45 bg-destructive/10 px-3 py-2 text-[11px] text-destructive flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
                <span>
                  Çok renkli baskı için dosyayı Bambu Studio&apos;dan <strong>.3mf</strong> olarak dışa aktarıp yükle.
                </span>
              </div>
            ) : rawGcodeBambu ? (
              <p className="text-[11px] text-amber-700 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
                Filamenti yukarıdaki slot sırasına göre yükle.
              </p>
            ) : null}

            {!isBambu && (
              <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
                <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0 text-amber-500" />
                Filamentin seçtiğin kafada olduğundan emin ol.
              </p>
            )}

            {/* Baskı/calibration seçenekleri — Bambu (MQTT param) + Snapmaker U1 (native print_task_config
                tercihi: BED_LEVEL/FLOW_CALIBRATE/TIME_LAPSE_CAMERA; gcode'a DOKUNMAZ, priming'i bozmaz).
                Elegoo'da bu seçenekler yok. */}
            {(isBambu || isSnapmaker) && (
              <div className="space-y-1.5 pt-2 border-t border-border/50">
                <p className="text-[11px] text-muted-foreground">Baskı seçenekleri (varsayılan kapalı — istersen aç)</p>
                {([
                  { k: "bedLeveling" as const, label: "Otomatik tabla terazileme" },
                  { k: "flowCali" as const, label: "Akış kalibrasyonu" },
                  { k: "timelapse" as const, label: "Timelapse (hızlandırılmış video)" },
                ]).map((o) => (
                  <button key={o.k} onClick={() => setPrefs((p) => ({ ...p, [o.k]: !p[o.k] }))} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground w-full">
                    <span className={cn("h-4 w-4 rounded border flex items-center justify-center shrink-0", prefs[o.k] ? "bg-primary border-primary" : "border-border")}>
                      {prefs[o.k] && <Check className="h-3 w-3 text-primary-foreground" />}
                    </span>
                    {o.label}
                  </button>
                ))}
              </div>
            )}

            {isBambu && (
              <button onClick={() => setUseAms((v) => !v)} className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground">
                <span className={cn("h-4 w-4 rounded border flex items-center justify-center", useAms ? "bg-primary border-primary" : "border-border")}>
                  {useAms && <Check className="h-3 w-3 text-primary-foreground" />}
                </span>
                AMS kullan (kapalıysa harici makaradan basar)
              </button>
            )}
          </div>
        )}

        {dupHeads && (
          <p className="text-[11px] text-destructive flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0" />
            İki renk aynı kafaya atanamaz — her renge farklı bir kafa seç.
          </p>
        )}

        {progress && <div className="mt-1"><PrintProgress p={progress} /></div>}

        <DialogFooter>
          <Button variant="ghost" onClick={onBack} disabled={printing}>Geri</Button>
          <Button disabled={printing || !assignReady || dupHeads || (rawGcodeBambu && printColors.length > 1)} onClick={start}>
            {printing ? <><Loader2 className="h-4 w-4 mr-1.5 animate-spin" />Gönderiliyor…</> : <><Play className="h-4 w-4 mr-1.5" />Bas ({printColors.length} renk)</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
