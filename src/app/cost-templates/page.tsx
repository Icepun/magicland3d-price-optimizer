"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KaydetCubuguSaglayici, useKayitBolumu } from "./kaydet-cubugu";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Settings, Coins, Boxes, Calculator, Zap, Package, AlertTriangle, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { AnimatedNumber } from "@/components/ui/animated-number";
import { parsePackagingSettings } from "@/core/packaging";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { useForm, type UseFormReturn } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { formatCurrency } from "@/lib/utils";
import { PackagingSettings } from "./PackagingSettings";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

interface FilamentType {
  id: string;
  name: string;
  costPerGram: number;
  isActive: boolean;
}

const FilamentSchema = z.object({
  name: z.string().trim().min(1, "Filament adı boş olamaz").max(80, "Ad en çok 80 karakter olabilir"),
  costPerGram: z.coerce
    .number({ message: "Gram fiyatı bir sayı olmalı" })
    .positive("Gram fiyatı sıfırdan büyük olmalı")
    .max(20, "Gram fiyatı çok yüksek — kg fiyatı mı girdin? (1 kg = 1000 g)"),
  isActive: z.boolean().default(true),
});
/** Bundan yüksek gram fiyatında uyarı çıkar (kg fiyatı yanlışlıkla gram alanına yazılmasın). */
const YUKSEK_GRAM_FIYATI = 3;

type FilamentFormData = z.infer<typeof FilamentSchema>;

export default function CostSettingsPage() {
  const [filamentOpen, setFilamentOpen] = useState(false);
  const [editingFilament, setEditingFilament] = useState<FilamentType | null>(null);
  /** Silme onayı bekleyen filament — kaç ürünün kullandığı gösterilir, pasifleştirme önerilir. */
  const [silinecekFilament, setSilinecekFilament] = useState<FilamentType | null>(null);
  // Ayrı açık/kapalı: kapanış animasyonu boyunca içerik boşalmasın.
  const [silmeAcik, setSilmeAcik] = useState(false);
  const queryClient = useQueryClient();

  // Load filament types
  const {
    data: filaments = [], isLoading: isFilamentsLoading, isError: filamentHata, isFetching: filamentYenileniyor, refetch: filamentYenile,
  } = useQuery<FilamentType[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetchJson("/api/filament-types"),
  });
  const { data: filamentKullanim } = useQuery<Record<string, number>>({
    queryKey: ["filament-kullanim"],
    queryFn: () => fetchJson("/api/filament-types/kullanim"),
    staleTime: 60_000,
  });

  // Load global app settings
  const {
    data: globalSettings, isLoading: isSettingsLoading, isError: ayarHata, isFetching: ayarYenileniyor, refetch: ayarYenile,
  } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });

  const hataGoster = (e: unknown, varsayilan: string) => toast.error(e instanceof Error && e.message ? e.message : varsayilan);

  // Filament mutations — ayarlar sorgusuna DOKUNMAZ: eskiden filament eklemek ayarları siliyor,
  // kaydedilmemiş paketleme/oran değişiklikleri gidiyordu (denetim, 23 Kas 2026).
  const createFilamentMutation = useMutation({
    mutationFn: (data: FilamentFormData) =>
      fetchJson("/api/filament-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      // Yeni filament henüz hiçbir üründe yok → kâr önbelleklerine dokunulmaz.
      void queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      toast.success("Filament tipi eklendi");
      setFilamentOpen(false);
    },
    onError: (e) => hataGoster(e, "Filament eklenemedi"),
  });

  const updateFilamentMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<FilamentFormData>; fiyatDegisti: boolean }) =>
      fetchJson(`/api/filament-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: (_r, v) => {
      void queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      // Yalnız FİYAT değişince kâr önbellekleri temizlenir (ad/durum kârı etkilemez).
      if (v.fiyatDegisti) clearPricingQueryCache(queryClient, { ayarlarDokunma: true });
      toast.success(v.data.isActive === false && Object.keys(v.data).length === 1 ? "Filament pasifleştirildi" : "Filament tipi güncellendi");
      setEditingFilament(null);
      setSilmeAcik(false);
    },
    onError: (e) => hataGoster(e, "Güncellenemedi"),
  });

  const deleteFilamentMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/filament-types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      void queryClient.invalidateQueries({ queryKey: ["filament-kullanim"] });
      clearPricingQueryCache(queryClient, { ayarlarDokunma: true });
      toast.success("Filament tipi silindi");
      setSilmeAcik(false);
    },
    onError: (e) => hataGoster(e, "Silinemedi"),
  });

  const filamentForm = useForm<FilamentFormData>({
    resolver: zodResolver(FilamentSchema),
    defaultValues: { name: "", costPerGram: 0.5, isActive: true },
  });

  return (
    <KaydetCubuguSaglayici>
    <div className="detay-kart p-6 space-y-6 mx-auto w-full max-w-[1400px]">
      <header className="flex flex-wrap items-center justify-between gap-4 animate-in fade-in slide-in-from-top-2 duration-500 motion-reduce:animate-none">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#9B5CFF] to-[#4F8CFF] text-white shadow-[0_12px_30px_-12px_rgba(122,126,255,0.9)]">
            <Calculator className="size-5" />
          </span>
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Maliyet & Paketleme</h1>
            <p className="text-xs text-muted-foreground">
              Filament, baskı saati ve paketleme fiyatları — tüm ürünlerin maliyeti buradan hesaplanır.
            </p>
          </div>
        </div>
      </header>

      {/* Özet — şu anki girdilerin tek bakışta görünümü (yalnız gösterim, hesaba dokunmaz). */}
      <MaliyetOzeti filamentler={filaments} ayarlar={globalSettings ?? {}} hazir={!isFilamentsLoading && !!globalSettings} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Filament Types Table */}
        <Card className="rounded-2xl border-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none lg:col-span-2">
          <CardHeader className="flex flex-row items-center justify-between">
            <div>
              <CardTitle className="text-lg flex items-center gap-2">
                <Coins className="h-5 w-5 text-primary" /> Filament Türleri
              </CardTitle>
              <CardDescription>
                Malzeme gram fiyatlarını tanımlayın. Ürün kartlarında bu fiyatlar kullanılır.
              </CardDescription>
            </div>
            <Button onClick={() => {
              filamentForm.reset({ name: "", costPerGram: 0.5, isActive: true });
              setFilamentOpen(true);
            }} size="sm" className="h-8 gap-1 rounded-xl border-0 bg-gradient-to-br from-[#8B6CFF] to-[#5B8CFF] px-3 text-white shadow-[0_10px_24px_-12px_rgba(122,126,255,0.95)] transition hover:-translate-y-px hover:brightness-110 active:scale-[0.97] motion-reduce:hover:translate-y-0">
              <Plus className="h-4 w-4" /> Ekle
            </Button>
          </CardHeader>
          <CardContent>
            {isFilamentsLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex gap-3 items-center">
                    <Skeleton className="h-8 w-1/3" />
                    <Skeleton className="h-8 w-24" />
                    <Skeleton className="h-8 w-16" />
                    <Skeleton className="h-8 w-20 ml-auto" />
                  </div>
                ))}
              </div>
            ) : filamentHata && filaments.length === 0 ? (
              // Okunamadı ≠ filament yok: "İlk filamenti ekle" deyince filamentler yeniden eklenip çift kayıt doğuyordu.
              <HataKarti baslik="Filamentler yüklenemedi" yenileniyor={filamentYenileniyor} onYenile={() => void filamentYenile()} />
            ) : filaments.length === 0 ? (
              <EmptyState
                icon={Boxes}
                title="Henüz filament tipi yok"
                description="3D baskıda kullandığın filamentleri (PLA, PETG, ABS vs.) ekle. Maliyet hesabında otomatik kullanılır."
                action={
                  <Button
                    size="sm"
                    onClick={() => {
                      filamentForm.reset({ name: "", costPerGram: 0.5, isActive: true });
                      setFilamentOpen(true);
                    }}
                  >
                    <Plus className="h-4 w-4 mr-2" /> İlk Filamenti Ekle
                  </Button>
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="border-white/[0.06] hover:bg-transparent">
                    <TableHead>Filament Adı</TableHead>
                    <TableHead>Gram Fiyatı</TableHead>
                    <TableHead>Durum</TableHead>
                    <TableHead className="text-right">Aksiyon</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filaments.map((f: FilamentType, index) => (
                    <TableRow
                      key={f.id}
                      className="border-white/[0.05] transition-colors hover:bg-white/[0.03] animate-in fade-in slide-in-from-bottom-1 duration-300"
                      style={{ animationDelay: `${index * 30}ms`, animationFillMode: "both" }}
                    >
                      <TableCell className="font-medium">{f.name}</TableCell>
                      <TableCell className="font-medium tabular-nums">{formatCurrency(f.costPerGram)}<span className="text-muted-foreground">/g</span></TableCell>
                      <TableCell>
                        {f.isActive ? (
                          <Badge variant="outline" className="rounded-full border-emerald-400/25 bg-emerald-500/10 text-emerald-300">Aktif</Badge>
                        ) : (
                          <Badge variant="secondary">Pasif</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg text-muted-foreground transition hover:bg-white/[0.06] hover:text-foreground active:scale-95"
                            title="Düzenle"
                            onClick={() => {
                              setEditingFilament(f);
                              filamentForm.reset(f);
                            }}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 rounded-lg text-rose-400 transition hover:bg-rose-500/10 hover:text-rose-300 active:scale-95"
                            title="Sil"
                            onClick={() => {
                              setSilinecekFilament(f);
                              setSilmeAcik(true);
                            }}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Global Cost Rates */}
        <Card className="rounded-2xl border-white/[0.07] shadow-[0_1px_0_0_rgba(255,255,255,0.04)_inset,0_18px_40px_-28px_rgba(0,0,0,0.8)] animate-in fade-in slide-in-from-bottom-2 fill-mode-both duration-500 motion-reduce:animate-none" style={{ animationDelay: "80ms" }}>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" /> Genel Maliyet Oranları
            </CardTitle>
            <CardDescription>
              Tüm ürünlerde ortak kullanılan saatlik 3D baskı giderleri.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isSettingsLoading && !globalSettings ? (
              <div className="space-y-3">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="space-y-1">
                    <Skeleton className="h-3 w-32" />
                    <Skeleton className="h-9 w-full" />
                  </div>
                ))}
                <Skeleton className="h-9 w-24" />
              </div>
            ) : (
              !globalSettings ? (
                // Veri GELMEDEN form açılmaz — sıfırlarla açılan form kaydedilince gerçek oranları eziyordu.
                <HataKarti baslik="Maliyet oranları yüklenemedi" yenileniyor={ayarYenileniyor} onYenile={() => void ayarYenile()} />
              ) : (
                <GenelOranlarFormu ayarlar={globalSettings} yenilenemedi={ayarHata} />
              )
            )}
          </CardContent>
        </Card>
      </div>

      {/* Paketleme & Sabit Ek Maliyetler */}
      <div className="pt-2">
        <h2 className="mb-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-gradient-to-br from-[#9B5CFF]/25 to-[#4F8CFF]/20 text-[#C9D2F2] ring-1 ring-white/10">
            <Package className="h-3.5 w-3.5" />
          </span>
          Paketleme & Ek Maliyetler
        </h2>
        <p className="text-sm text-muted-foreground mb-4">
          Detaylı maliyetli ürünlere ve yeni siparişlere otomatik uygulanır — zam geldiğinde tek yerden güncellersin.
        </p>
        <PackagingSettings />
      </div>

      {/* Filament Create Dialog */}
      <Dialog open={filamentOpen} onOpenChange={setFilamentOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Yeni Filament Ekle</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={filamentForm.handleSubmit((d) => createFilamentMutation.mutate(d))}
            className="space-y-4"
          >
            <FilamentAlanlari form={filamentForm} />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setFilamentOpen(false)}>
                İptal
              </Button>
              <Button type="submit" disabled={createFilamentMutation.isPending}>
                Ekle
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Filament Edit Dialog */}
      <Dialog open={!!editingFilament} onOpenChange={() => setEditingFilament(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Filament Türünü Düzenle</DialogTitle>
          </DialogHeader>
          <form
            onSubmit={filamentForm.handleSubmit((d) =>
              updateFilamentMutation.mutate({
                id: editingFilament!.id,
                data: d,
                fiyatDegisti: d.costPerGram !== editingFilament!.costPerGram,
              })
            )}
            className="space-y-4"
          >
            <FilamentAlanlari form={filamentForm} durumGoster />
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingFilament(null)}>
                İptal
              </Button>
              <Button type="submit" disabled={updateFilamentMutation.isPending}>
                Güncelle
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Filament silme onayı — kaç ürünün kullandığını söyler; kullanılıyorsa pasifleştirme önerilir. */}
      <Dialog open={silmeAcik} onOpenChange={(o) => !o && setSilmeAcik(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-base text-rose-400">Filament silinsin mi?</DialogTitle>
          </DialogHeader>
          {silinecekFilament && (() => {
            const kullanan = filamentKullanim?.[silinecekFilament.id] ?? 0;
            const mesgul = deleteFilamentMutation.isPending || updateFilamentMutation.isPending;
            return (
              <>
                <p className="text-sm font-medium">{silinecekFilament.name}</p>
                {kullanan > 0 ? (
                  <p className="rounded-xl bg-rose-500/[0.07] p-2.5 text-xs text-foreground/85 ring-1 ring-rose-400/25">
                    Bu filamenti <strong>{kullanan} ürün</strong>{" "}kullanıyor. Silersen bu ürünlerin kârı &quot;bilinmiyor&quot; olur.
                    Listeden kaldırmak için pasifleştirmek daha güvenli.
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Hiçbir ürün bu filamenti kullanmıyor. Bu işlem geri alınamaz.</p>
                )}
                <DialogFooter className="gap-2">
                  <Button variant="outline" size="sm" disabled={mesgul} onClick={() => setSilmeAcik(false)}>
                    Vazgeç
                  </Button>
                  {kullanan > 0 && silinecekFilament.isActive && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={mesgul}
                      onClick={() => updateFilamentMutation.mutate({ id: silinecekFilament.id, data: { isActive: false }, fiyatDegisti: false })}
                    >
                      Pasifleştir
                    </Button>
                  )}
                  <Button
                    size="sm"
                    className="bg-rose-500 text-white hover:bg-rose-500/90"
                    disabled={mesgul}
                    onClick={() => deleteFilamentMutation.mutate(silinecekFilament.id)}
                  >
                    {kullanan > 0 ? "Yine de sil" : "Sil"}
                  </Button>
                </DialogFooter>
              </>
            );
          })()}
        </DialogContent>
      </Dialog>
    </div>
    </KaydetCubuguSaglayici>
  );
}

/** Kısa hata kartı + tekrar dene (okunamadı ≠ boş). */
function HataKarti({ baslik, yenileniyor, onYenile }: { baslik: string; yenileniyor: boolean; onYenile: () => void }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl bg-rose-500/[0.05] px-4 py-8 text-center ring-1 ring-rose-400/25 animate-in fade-in duration-300">
      <AlertTriangle className="h-7 w-7 text-rose-300/80" />
      <p className="text-sm font-medium">{baslik}</p>
      <Button variant="outline" size="sm" className="gap-1.5" disabled={yenileniyor} onClick={onYenile}>
        <RefreshCw className={cn("h-3.5 w-3.5", yenileniyor && "animate-spin")} /> Tekrar dene
      </Button>
    </div>
  );
}

/**
 * Filament formu alanları — hata metinleri görünür, gram fiyatı yüksekse uyarır, kg fiyatından
 * gram fiyatı hesaplanabilir. Eskiden geçersiz girişte "Ekle" hiçbir şey yapmıyordu; kg fiyatı gram
 * alanına yazılınca (650 TL/g) o arada gelen siparişlerin kârı kalıcı olarak yanlış yazılıyordu.
 */
function FilamentAlanlari({ form, durumGoster }: { form: UseFormReturn<FilamentFormData>; durumGoster?: boolean }) {
  const hatalar = form.formState.errors;
  const fiyat = Number(form.watch("costPerGram"));
  const [kg, setKg] = useState("");
  return (
    <>
      <div className="space-y-1">
        <Label>Filament Adı</Label>
        <Input className="rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25" maxLength={80} {...form.register("name")} placeholder="Porima Eco PLA" />
        {hatalar.name?.message && <p className="text-xs text-rose-400">{hatalar.name.message}</p>}
      </div>
      <div className="space-y-1">
        <Label>Gram Fiyatı (TL)</Label>
        <Input type="number" step="0.001" className="rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25" {...form.register("costPerGram")} />
        {hatalar.costPerGram?.message ? (
          <p className="text-xs text-rose-400">{hatalar.costPerGram.message}</p>
        ) : Number.isFinite(fiyat) && fiyat > YUKSEK_GRAM_FIYATI ? (
          <p className="flex items-center gap-1 text-xs text-[#C9D2F2] animate-in fade-in duration-200">
            <AlertTriangle className="h-3 w-3 text-[#A9AEFF]" /> Gram fiyatı yüksek görünüyor — kg fiyatı mı girdin?
          </p>
        ) : null}
        {/* kg fiyatından çevir */}
        <div className="flex items-center gap-2 pt-1">
          <Input
            type="text"
            inputMode="decimal"
            value={kg}
            onChange={(e) => setKg(e.target.value)}
            placeholder="kg fiyatı (TL)"
            className="rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25 h-8 text-xs"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 shrink-0 rounded-xl text-xs"
            disabled={!(Number(kg.replace(",", ".")) > 0)}
            onClick={() => {
              const n = Number(kg.replace(",", "."));
              if (n > 0) form.setValue("costPerGram", Math.round((n / 1000) * 10000) / 10000, { shouldValidate: true, shouldDirty: true });
            }}
          >
            Gram fiyatına çevir
          </Button>
        </div>
      </div>
      {durumGoster && (
        <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-2.5 text-sm">
          <input type="checkbox" className="h-4 w-4 accent-[#7A7EFF]" {...form.register("isActive")} />
          Aktif <span className="text-xs text-muted-foreground">(ürün maliyetinde seçilebilir)</span>
        </label>
      )}
    </>
  );
}

/** Panel / Siparişler ile aynı özet kutusu. */
function OzetKutusu({ sira, ikon, baslik, children }: { sira: number; ikon: React.ReactNode; baslik: string; children: React.ReactNode }) {
  return (
    <div
      className="group relative flex min-w-0 flex-col justify-between overflow-hidden rounded-2xl bg-card p-4 ring-1 ring-white/[0.07] transition-[transform,box-shadow] duration-300 hover:-translate-y-0.5 hover:ring-white/[0.12] hover:shadow-[0_20px_40px_-30px_rgba(122,126,255,0.55)] animate-in fade-in slide-in-from-bottom-3 fill-mode-both duration-500 motion-reduce:animate-none motion-reduce:hover:translate-y-0"
      style={{ animationDelay: `${sira * 60}ms` }}
    >
      <span className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
        <span className="grid size-7 place-items-center rounded-lg bg-white/[0.05] text-[#C9D2F2] ring-1 ring-white/[0.08] transition-colors group-hover:bg-[#7A7EFF]/15">
          {ikon}
        </span>
        {baslik}
      </span>
      <div className="mt-3 min-w-0">{children}</div>
    </div>
  );
}

/**
 * Şu anki maliyet girdilerinin özeti — YALNIZ GÖSTERİM (hiçbir hesaba girmez): kayıtlı değerlerden
 * okunur, kaydedilmemiş değişiklik çubuktan kaydedilince yansır.
 */
function MaliyetOzeti({ filamentler, ayarlar, hazir }: { filamentler: FilamentType[]; ayarlar: Record<string, string>; hazir: boolean }) {
  if (!hazir) {
    return (
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[112px] w-full rounded-2xl" />)}
      </div>
    );
  }
  const aktif = filamentler.filter((f) => f.isActive);
  const fiyatlar = aktif.map((f) => f.costPerGram).filter((n) => Number.isFinite(n) && n > 0);
  const enDusuk = fiyatlar.length ? Math.min(...fiyatlar) : null;
  const enYuksek = fiyatlar.length ? Math.max(...fiyatlar) : null;
  const sayi = (v: string | undefined) => {
    const n = Number.parseFloat(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : 0;
  };
  const elektrik = ayarlar.costElectricityIncluded === "true" ? sayi(ayarlar.costElectricityPerHour) : 0;
  const saatlik = elektrik + sayi(ayarlar.costMachineWearPerHour) + sayi(ayarlar.costLaborPerHour);
  const paket = parsePackagingSettings(ayarlar);
  const birim = (adet: number, fiyat: number) => (adet > 0 ? fiyat / adet : 0);
  const ekler = birim(paket.cardQty, paket.cardPrice) + birim(paket.stickerQty, paket.stickerPrice) + birim(paket.sakizQty, paket.sakizPrice);
  return (
    <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      <OzetKutusu sira={0} ikon={<Coins className="size-3.5" />} baslik="Filament">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          <AnimatedNumber value={aktif.length} /> <span className="text-base font-medium text-muted-foreground">tür</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {filamentler.length > aktif.length ? `${filamentler.length - aktif.length} pasif` : "hepsi aktif"}
        </p>
      </OzetKutusu>
      <OzetKutusu sira={1} ikon={<Boxes className="size-3.5" />} baslik="Gram fiyatı">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          {enDusuk == null ? "—" : enDusuk === enYuksek ? formatCurrency(enDusuk) : `${formatCurrency(enDusuk)}–${formatCurrency(enYuksek!)}`}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">aktif filamentler, gram başına</p>
      </OzetKutusu>
      <OzetKutusu sira={2} ikon={<Zap className="size-3.5" />} baslik="Baskı saati gideri">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          <AnimatedNumber value={saatlik} format={(n) => formatCurrency(n)} />
          <span className="text-base font-medium text-muted-foreground">/sa</span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {ayarlar.costElectricityIncluded === "true" ? "elektrik + aşınma + işçilik" : "aşınma + işçilik (elektrik hariç)"}
        </p>
      </OzetKutusu>
      <OzetKutusu sira={3} ikon={<Package className="size-3.5" />} baslik="Kart · sticker · sakız">
        <p className="text-2xl font-semibold tracking-tight tabular-nums">
          <AnimatedNumber value={ekler} format={(n) => formatCurrency(n)} />
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">birim maliyet toplamı</p>
      </OzetKutusu>
    </div>
  );
}

/**
 * Genel maliyet oranları — KONTROLLÜ form, sayfanın tek kaydet çubuğuna bağlı.
 *
 * - Yalnız DEĞİŞEN anahtarlar gönderilir (eskiden dört anahtar hep birlikte yazılıyordu).
 * - Sunucudan yeni değer gelince form yeniden KURULMAZ: kaydedilmemiş değişiklik korunur.
 * - Kayıt sürerken yazılan değer gönderilmediği için kirli kalır.
 */
function GenelOranlarFormu({ ayarlar, yenilenemedi }: { ayarlar: Record<string, string>; yenilenemedi: boolean }) {
  const sunucu = {
    costElectricityPerHour: ayarlar.costElectricityPerHour || "0",
    costElectricityIncluded: ayarlar.costElectricityIncluded === "true" ? "true" : "false",
    costMachineWearPerHour: ayarlar.costMachineWearPerHour || "0",
    costLaborPerHour: ayarlar.costLaborPerHour || "0",
  };
  type Oranlar = typeof sunucu;
  const sunucuImza = JSON.stringify(sunucu);
  const [baz, setBaz] = useState<Oranlar>(sunucu);
  const [d, setD] = useState<Oranlar>(sunucu);
  /** "1,5" → "1.5"; boş → "0". */
  const kayit = (k: keyof Oranlar, v: string) => {
    if (k === "costElectricityIncluded") return v;
    const t = v.trim().replace(",", ".");
    return t === "" ? "0" : t;
  };
  const degisen: Record<string, string> = {};
  for (const k of Object.keys(d) as (keyof Oranlar)[]) {
    const yeni = kayit(k, d[k]);
    const eski = kayit(k, baz[k]);
    // Onay kutusu metin olarak karşılaştırılır (Number("false") = NaN, NaN !== NaN → hep "değişti" sanılıyordu).
    const ayni = yeni === eski || (k !== "costElectricityIncluded" && Number(yeni) === Number(eski));
    if (!ayni) degisen[k] = yeni;
  }
  const kirli = Object.keys(degisen).length > 0;
  const [izlenen, setIzlenen] = useState(sunucuImza);
  if (izlenen !== sunucuImza) {
    setIzlenen(sunucuImza);
    setBaz(sunucu);
    if (!kirli) setD(sunucu);
  }
  useKayitBolumu("genel-oranlar", {
    etiket: "Genel maliyet oranları",
    kirli,
    degisiklikler: () => degisen,
    vazgec: () => setD(baz),
    kaydedildi: (gonderilen) => setBaz((b) => ({ ...b, ...(gonderilen as Partial<Oranlar>) })),
  });
  const alan = (ad: Exclude<keyof Oranlar, "costElectricityIncluded">, etiket: string) => (
    <div className="space-y-1">
      <Label htmlFor={ad}>{etiket}</Label>
      <Input
        id={ad}
        type="text"
        inputMode="decimal"
        className="rounded-xl border-white/[0.08] bg-white/[0.03] dark:bg-white/[0.03] tabular-nums transition-colors focus-visible:border-[#7A7EFF]/50 focus-visible:ring-[#7A7EFF]/25"
        value={d[ad]}
        onChange={(e) => setD((o) => ({ ...o, [ad]: e.target.value }))}
      />
    </div>
  );
  return (
    <div className="space-y-4">
      {yenilenemedi && (
        <p className="flex items-center gap-1.5 text-xs font-medium text-[#C9D2F2]">
          <AlertTriangle className="h-3.5 w-3.5 text-[#A9AEFF]" /> Güncellenemedi — son alınan gösteriliyor.
        </p>
      )}
      {alan("costElectricityPerHour", "Elektrik Maliyeti (TL/saat)")}
      <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-white/[0.08] bg-white/[0.02] p-3 text-sm transition-colors hover:bg-white/[0.04]">
        <input
          type="checkbox"
          checked={d.costElectricityIncluded === "true"}
          onChange={(e) => setD((o) => ({ ...o, costElectricityIncluded: e.target.checked ? "true" : "false" }))}
          className="mt-0.5 h-4 w-4 accent-[#7A7EFF]"
        />
        <span>
          <span className="font-medium">Elektriği net kârdan düş</span>
          <span className="block text-xs text-muted-foreground mt-0.5">
            Kapalıysa saatlik değer kayıtlı kalır fakat maliyete eklenmez.
          </span>
        </span>
      </label>
      {alan("costMachineWearPerHour", "Makine Aşınması (TL/saat)")}
      {alan("costLaborPerHour", "İşçilik Maliyeti (TL/saat)")}
      <p className="text-[11px] text-muted-foreground">Değişiklikler sayfanın altındaki çubuktan kaydedilir.</p>
    </div>
  );
}

