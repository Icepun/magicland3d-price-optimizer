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
import { Plus, Pencil, Trash2, Settings, Coins, Boxes } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
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
  name: z.string().min(1, "Ad zorunlu"),
  costPerGram: z.coerce.number().positive("Pozitif bir değer olmalı"),
  isActive: z.boolean().default(true),
});

type FilamentFormData = z.infer<typeof FilamentSchema>;

export default function CostSettingsPage() {
  const [filamentOpen, setFilamentOpen] = useState(false);
  const [editingFilament, setEditingFilament] = useState<FilamentType | null>(null);
  const queryClient = useQueryClient();

  // Load filament types
  const { data: filaments = [], isLoading: isFilamentsLoading } = useQuery<FilamentType[]>({
    queryKey: ["filament-types"],
    queryFn: () => fetchJson("/api/filament-types"),
  });

  // Load global app settings
  const { data: globalSettings = {}, isLoading: isSettingsLoading } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetchJson("/api/settings"),
  });

  // Filament mutations
  const createFilamentMutation = useMutation({
    mutationFn: (data: FilamentFormData) =>
      fetchJson("/api/filament-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      clearPricingQueryCache(queryClient);
      toast.success("Filament tipi eklendi");
      setFilamentOpen(false);
    },
  });

  const updateFilamentMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FilamentFormData }) =>
      fetchJson(`/api/filament-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      clearPricingQueryCache(queryClient);
      toast.success("Filament tipi güncellendi");
      setEditingFilament(null);
    },
  });

  const deleteFilamentMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/filament-types/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      clearPricingQueryCache(queryClient);
      toast.success("Filament tipi silindi");
    },
  });

  const filamentForm = useForm<FilamentFormData>({
    resolver: zodResolver(FilamentSchema),
    defaultValues: { name: "", costPerGram: 0.5, isActive: true },
  });

  return (
    <KaydetCubuguSaglayici>
    <div className="p-6 space-y-6 mx-auto w-full max-w-[1400px]">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Maliyet Ayarları</h1>
          <p className="text-sm text-muted-foreground">
            Filament tiplerini ve 3D baskı için ortak elektrik, aşınma ve işçilik giderlerini yönetin.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Filament Types Table */}
        <Card className="lg:col-span-2">
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
            }} size="sm">
              <Plus className="h-4 w-4 mr-1" /> Ekle
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
                  <TableRow>
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
                      className="animate-in fade-in slide-in-from-bottom-1 duration-300"
                      style={{ animationDelay: `${index * 30}ms`, animationFillMode: "both" }}
                    >
                      <TableCell className="font-medium">{f.name}</TableCell>
                      <TableCell>{formatCurrency(f.costPerGram)}/g</TableCell>
                      <TableCell>
                        {f.isActive ? (
                          <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">Aktif</Badge>
                        ) : (
                          <Badge variant="secondary">Pasif</Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
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
                            className="h-8 w-8 text-destructive"
                            title="Sil"
                            onClick={() => deleteFilamentMutation.mutate(f.id)}
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
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Settings className="h-5 w-5 text-primary" /> Genel Maliyet Oranları
            </CardTitle>
            <CardDescription>
              Tüm ürünlerde ortak kullanılan saatlik 3D baskı giderleri.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isSettingsLoading ? (
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
              <GenelOranlarFormu key={JSON.stringify(globalSettings)} ayarlar={globalSettings} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Paketleme & Sabit Ek Maliyetler */}
      <div className="pt-2">
        <h2 className="text-lg font-semibold mb-1">Paketleme & Ek Maliyetler</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Buradaki fiyatlar tüm ürünlere otomatik uygulanır. Zam geldiğinde tek yerden
          güncellersin, tüm kâr hesapları anında değişir.
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
            <div className="space-y-1">
              <Label>Filament Adı</Label>
              <Input {...filamentForm.register("name")} placeholder="Porima Eco PLA" />
            </div>
            <div className="space-y-1">
              <Label>Gram Fiyatı (TL)</Label>
              <Input type="number" step="0.001" {...filamentForm.register("costPerGram")} />
            </div>
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
              updateFilamentMutation.mutate({ id: editingFilament!.id, data: d })
            )}
            className="space-y-4"
          >
            <div className="space-y-1">
              <Label>Filament Adı</Label>
              <Input {...filamentForm.register("name")} />
            </div>
            <div className="space-y-1">
              <Label>Gram Fiyatı (TL)</Label>
              <Input type="number" step="0.001" {...filamentForm.register("costPerGram")} />
            </div>
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
    </div>
    </KaydetCubuguSaglayici>
  );
}

/**
 * Genel maliyet oranları — KONTROLLÜ form, sayfanın tek kaydet çubuğuna bağlı.
 * Ayarlar tazelenince (key) yeni değerlerle baştan kurulur.
 */
function GenelOranlarFormu({ ayarlar }: { ayarlar: Record<string, string> }) {
  const ilk = {
    costElectricityPerHour: ayarlar.costElectricityPerHour || "0.00",
    costElectricityIncluded: ayarlar.costElectricityIncluded === "true" ? "true" : "false",
    costMachineWearPerHour: ayarlar.costMachineWearPerHour || "0.00",
    costLaborPerHour: ayarlar.costLaborPerHour || "0.00",
  };
  const [baz] = useState(ilk);
  const [d, setD] = useState(ilk);
  const [kaydedilen, setKaydedilen] = useState<string | null>(null);
  const imza = JSON.stringify(d);
  useKayitBolumu("genel-oranlar", {
    etiket: "Genel maliyet oranları",
    kirli: imza !== JSON.stringify(baz) && imza !== kaydedilen,
    degisiklikler: () => ({ ...d }),
    vazgec: () => setD(baz),
    kaydedildi: () => setKaydedilen(imza),
  });
  const alan = (ad: keyof typeof ilk, etiket: string) => (
    <div className="space-y-1">
      <Label htmlFor={ad}>{etiket}</Label>
      <Input
        id={ad}
        type="number"
        step="0.01"
        value={d[ad]}
        onChange={(e) => setD((o) => ({ ...o, [ad]: e.target.value }))}
      />
    </div>
  );
  return (
    <div className="space-y-4">
      {alan("costElectricityPerHour", "Elektrik Maliyeti (TL/saat)")}
      <label className="flex items-start gap-2 rounded-md border p-3 text-sm">
        <input
          type="checkbox"
          checked={d.costElectricityIncluded === "true"}
          onChange={(e) => setD((o) => ({ ...o, costElectricityIncluded: e.target.checked ? "true" : "false" }))}
          className="mt-0.5 h-4 w-4 accent-primary"
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
