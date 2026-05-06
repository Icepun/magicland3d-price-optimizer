"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
import { Plus, Pencil, Trash2, Settings, Coins } from "lucide-react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { formatCurrency } from "@/lib/utils";

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
    queryFn: () => fetch("/api/filament-types").then((r) => r.json()),
  });

  // Load global app settings
  const { data: globalSettings = {}, isLoading: isSettingsLoading } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });

  // Global settings mutation
  const saveSettingsMutation = useMutation({
    mutationFn: (data: Record<string, string>) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["app-settings"] });
      toast.success("Genel maliyet oranları kaydedildi");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  // Filament mutations
  const createFilamentMutation = useMutation({
    mutationFn: (data: FilamentFormData) =>
      fetch("/api/filament-types", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      toast.success("Filament tipi eklendi");
      setFilamentOpen(false);
    },
  });

  const updateFilamentMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FilamentFormData }) =>
      fetch(`/api/filament-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      toast.success("Filament tipi güncellendi");
      setEditingFilament(null);
    },
  });

  const deleteFilamentMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/filament-types/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filament-types"] });
      toast.success("Filament tipi silindi");
    },
  });

  const filamentForm = useForm<FilamentFormData>({
    resolver: zodResolver(FilamentSchema),
    defaultValues: { name: "", costPerGram: 0.5, isActive: true },
  });

  const handleSettingsSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    const data = {
      costElectricityPerHour: formData.get("costElectricityPerHour") as string,
      costMachineWearPerHour: formData.get("costMachineWearPerHour") as string,
      costLaborPerHour: formData.get("costLaborPerHour") as string,
    };
    saveSettingsMutation.mutate(data);
  };

  return (
    <div className="p-6 space-y-6">
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
              <p className="text-sm text-muted-foreground">Yükleniyor...</p>
            ) : filaments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                Henüz filament tipi eklenmemiş.
              </p>
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
                  {filaments.map((f: FilamentType) => (
                    <TableRow key={f.id}>
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
              <p className="text-sm text-muted-foreground">Yükleniyor...</p>
            ) : (
              <form onSubmit={handleSettingsSubmit} className="space-y-4">
                <div className="space-y-1">
                  <Label htmlFor="costElectricityPerHour">Elektrik Maliyeti (TL/saat)</Label>
                  <Input
                    id="costElectricityPerHour"
                    name="costElectricityPerHour"
                    type="number"
                    step="0.01"
                    defaultValue={globalSettings.costElectricityPerHour || "0.00"}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="costMachineWearPerHour">Makine Aşınması (TL/saat)</Label>
                  <Input
                    id="costMachineWearPerHour"
                    name="costMachineWearPerHour"
                    type="number"
                    step="0.01"
                    defaultValue={globalSettings.costMachineWearPerHour || "0.00"}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="costLaborPerHour">İşçilik Maliyeti (TL/saat)</Label>
                  <Input
                    id="costLaborPerHour"
                    name="costLaborPerHour"
                    type="number"
                    step="0.01"
                    defaultValue={globalSettings.costLaborPerHour || "0.00"}
                  />
                </div>
                <Button type="submit" className="w-full" disabled={saveSettingsMutation.isPending}>
                  {saveSettingsMutation.isPending ? "Kaydediliyor..." : "Ayarları Kaydet"}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
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
  );
}
