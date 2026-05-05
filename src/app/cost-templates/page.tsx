"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Calculator } from "lucide-react";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { calculateTemplateCost } from "@/core/cost-calculator";
import { formatCurrency } from "@/lib/utils";

interface CostTemplate {
  id: string;
  name: string;
  materialCostPerGram: number;
  electricityCostPerHour: number;
  machineWearCostPerHour: number;
  defaultPackagingCost: number;
  defaultLaborCost: number;
  defaultOtherCost: number;
  defaultWasteRate: number;
  isActive: boolean;
}

const Schema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  materialCostPerGram: z.coerce.number().min(0).default(0),
  electricityCostPerHour: z.coerce.number().min(0).default(0),
  machineWearCostPerHour: z.coerce.number().min(0).default(0),
  defaultPackagingCost: z.coerce.number().min(0).default(0),
  defaultLaborCost: z.coerce.number().min(0).default(0),
  defaultOtherCost: z.coerce.number().min(0).default(0),
  defaultWasteRate: z.coerce.number().min(0).max(100).default(0),
  isActive: z.boolean().default(true),
});

type FormData = z.infer<typeof Schema>;

function TemplateForm({
  defaultValues,
  onSubmit,
  isPending,
}: {
  defaultValues?: Partial<FormData>;
  onSubmit: (d: FormData) => void;
  isPending: boolean;
}) {
  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: {
      materialCostPerGram: 0,
      electricityCostPerHour: 0,
      machineWearCostPerHour: 0,
      defaultPackagingCost: 0,
      defaultLaborCost: 0,
      defaultOtherCost: 0,
      defaultWasteRate: 0,
      isActive: true,
      ...defaultValues,
    },
  });

  const [previewWeight, setPreviewWeight] = useState("100");
  const [previewHours, setPreviewHours] = useState("2");

  const values = useWatch({ control: form.control });
  const previewCost = calculateTemplateCost({
    materialWeight: parseFloat(previewWeight) || 0,
    printTimeHours: parseFloat(previewHours) || 0,
    materialCostPerGram: values.materialCostPerGram ?? 0,
    electricityCostPerHour: values.electricityCostPerHour ?? 0,
    machineWearCostPerHour: values.machineWearCostPerHour ?? 0,
    packagingCost: values.defaultPackagingCost ?? 0,
    laborCost: values.defaultLaborCost ?? 0,
    otherCost: values.defaultOtherCost ?? 0,
    wasteRate: (values.defaultWasteRate ?? 0) / 100,
  });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <div>
        <Label>Şablon Adı *</Label>
        <Input {...form.register("name")} placeholder="Küçük PLA Ürün" />
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Malzeme (TL/g)</Label>
          <Input type="number" step="0.01" {...form.register("materialCostPerGram")} />
        </div>
        <div>
          <Label>Elektrik (TL/saat)</Label>
          <Input type="number" step="0.01" {...form.register("electricityCostPerHour")} />
        </div>
        <div>
          <Label>Makine Aşınma (TL/saat)</Label>
          <Input type="number" step="0.01" {...form.register("machineWearCostPerHour")} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div>
          <Label>Ambalaj (TL)</Label>
          <Input type="number" step="0.01" {...form.register("defaultPackagingCost")} />
        </div>
        <div>
          <Label>İşçilik (TL)</Label>
          <Input type="number" step="0.01" {...form.register("defaultLaborCost")} />
        </div>
        <div>
          <Label>Diğer (TL)</Label>
          <Input type="number" step="0.01" {...form.register("defaultOtherCost")} />
        </div>
      </div>
      <div>
        <Label>Fire Oranı (%)</Label>
        <Input type="number" step="0.1" {...form.register("defaultWasteRate")} />
      </div>

      <div className="p-3 bg-muted rounded space-y-2">
        <p className="text-xs font-medium flex items-center gap-1">
          <Calculator className="h-3.5 w-3.5" /> Ön İzleme
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <Label className="text-xs">Ağırlık (g)</Label>
            <Input
              type="number"
              value={previewWeight}
              onChange={(e) => setPreviewWeight(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
          <div>
            <Label className="text-xs">Baskı Süresi (saat)</Label>
            <Input
              type="number"
              value={previewHours}
              onChange={(e) => setPreviewHours(e.target.value)}
              className="h-7 text-xs"
            />
          </div>
        </div>
        <p className="text-sm font-semibold">
          Tahmini Maliyet: {formatCurrency(previewCost)}
        </p>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Kaydediliyor..." : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function CostTemplatesPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CostTemplate | null>(null);
  const queryClient = useQueryClient();

  const { data: templates = [], isLoading } = useQuery<CostTemplate[]>({
    queryKey: ["cost-templates"],
    queryFn: () => fetch("/api/cost-templates").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetch("/api/cost-templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, defaultWasteRate: data.defaultWasteRate / 100 }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-templates"] });
      toast.success("Şablon eklendi");
      setOpen(false);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      fetch(`/api/cost-templates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, defaultWasteRate: data.defaultWasteRate / 100 }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-templates"] });
      toast.success("Güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/cost-templates/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cost-templates"] });
      toast.success("Silindi");
    },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Maliyet Şablonları</h1>
        <Button onClick={() => setOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" /> Şablon Ekle
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        3D baskı ürünleri için malzeme, elektrik ve makine aşınma parametrelerini tanımlayın.
        Ürüne ağırlık ve baskı süresi girince maliyet otomatik hesaplanır.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Yükleniyor...</p>
      ) : templates.length === 0 ? (
        <Card className="py-12 text-center">
          <CardContent>
            <p className="text-muted-foreground">Henüz şablon yok.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {templates.map((t) => (
            <Card key={t.id}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm">{t.name}</CardTitle>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(t)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteMutation.mutate(t.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0 space-y-1 text-xs text-muted-foreground">
                <div className="grid grid-cols-2 gap-x-3">
                  <span>Malzeme: {t.materialCostPerGram} TL/g</span>
                  <span>Elektrik: {t.electricityCostPerHour} TL/saat</span>
                  <span>Makine: {t.machineWearCostPerHour} TL/saat</span>
                  <span>Ambalaj: {t.defaultPackagingCost} TL</span>
                  {t.defaultLaborCost > 0 && <span>İşçilik: {t.defaultLaborCost} TL</span>}
                  {t.defaultWasteRate > 0 && <span>Fire: %{(t.defaultWasteRate * 100).toFixed(1)}</span>}
                </div>
                {!t.isActive && <Badge variant="secondary" className="mt-1">Pasif</Badge>}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Maliyet Şablonu Ekle</DialogTitle>
          </DialogHeader>
          <TemplateForm onSubmit={(d) => createMutation.mutate(d)} isPending={createMutation.isPending} />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Şablonu Düzenle</DialogTitle>
          </DialogHeader>
          {editing && (
            <TemplateForm
              defaultValues={{ ...editing, defaultWasteRate: editing.defaultWasteRate * 100 }}
              onSubmit={(d) => updateMutation.mutate({ id: editing.id, data: d })}
              isPending={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
