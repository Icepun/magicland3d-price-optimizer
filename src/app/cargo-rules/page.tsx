"use client";

/* eslint-disable react/no-unescaped-entities */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { formatCurrency } from "@/lib/utils";

interface CargoRule {
  id: string;
  name: string;
  cargoProvider: string | null;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  minDesi: number;
  maxDesi: number;
  cargoCost: number;
  priority: number;
  isActive: boolean;
}

const Schema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  cargoProvider: z.string().optional(),
  categoryName: z.string().optional(),
  minPrice: z.coerce.number().min(0).default(0),
  maxPrice: z.coerce.number().min(0).default(999999),
  minDesi: z.coerce.number().min(0).default(0),
  maxDesi: z.coerce.number().min(0).default(999),
  cargoCost: z.coerce.number().min(0),
  priority: z.coerce.number().int().default(10),
  isActive: z.boolean().default(true),
});

type FormData = z.infer<typeof Schema>;

function RuleForm({
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
      minPrice: 0,
      maxPrice: 999999,
      minDesi: 0,
      maxDesi: 999,
      priority: 10,
      isActive: true,
      ...defaultValues,
    },
  });
  const isActive = useWatch({ control: form.control, name: "isActive" });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <div>
        <Label>Kural Adı *</Label>
        <Input {...form.register("name")} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kargo Firması</Label>
          <Input {...form.register("cargoProvider")} placeholder="Yurtiçi" />
        </div>
        <div>
          <Label>Kategori (opsiyonel)</Label>
          <Input {...form.register("categoryName")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Min. Fiyat (TL)</Label>
          <Input type="number" step="0.01" {...form.register("minPrice")} />
        </div>
        <div>
          <Label>Max. Fiyat (TL)</Label>
          <Input type="number" step="0.01" {...form.register("maxPrice")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Min. Desi</Label>
          <Input type="number" step="0.1" {...form.register("minDesi")} />
        </div>
        <div>
          <Label>Max. Desi</Label>
          <Input type="number" step="0.1" {...form.register("maxDesi")} />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Kargo Maliyeti (TL) *</Label>
          <Input type="number" step="0.01" {...form.register("cargoCost")} />
        </div>
        <div>
          <Label>Öncelik</Label>
          <Input type="number" {...form.register("priority")} />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch
          checked={isActive}
          onCheckedChange={(v) => form.setValue("isActive", v)}
        />
        <Label>Aktif</Label>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Kaydediliyor..." : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function CargoRulesPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CargoRule | null>(null);
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery<CargoRule[]>({
    queryKey: ["cargo-rules"],
    queryFn: () => fetch("/api/cargo-rules").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetch("/api/cargo-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      toast.success("Kural eklendi");
      setOpen(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      fetch(`/api/cargo-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      toast.success("Kural güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/cargo-rules/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cargo-rules"] });
      toast.success("Kural silindi");
    },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Kargo Kuralları</h1>
        <Button onClick={() => setOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" /> Kural Ekle
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Fiyat aralığı ve desi'ye göre kargo maliyeti tanımlayın. Kargo baremi değişimi kâra doğrudan yansır.
      </p>

      {isLoading ? (
        <p className="text-muted-foreground">Yükleniyor...</p>
      ) : rules.length === 0 ? (
        <Card className="py-12 text-center">
          <CardContent>
            <p className="text-muted-foreground">Henüz kargo kuralı yok.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {rules.map((rule) => (
            <Card key={rule.id} className={!rule.isActive ? "opacity-50" : ""}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold">{rule.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">Öncelik: {rule.priority}</Badge>
                    {!rule.isActive && <Badge variant="secondary" className="text-xs">Pasif</Badge>}
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setEditing(rule)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => deleteMutation.mutate(rule.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-3 text-sm">
                  {rule.cargoProvider && (
                    <span><span className="text-muted-foreground">Firma:</span> {rule.cargoProvider}</span>
                  )}
                  <span>
                    <span className="text-muted-foreground">Fiyat:</span>{" "}
                    {rule.minPrice} — {rule.maxPrice === 999999 ? "∞" : rule.maxPrice} TL
                  </span>
                  <span>
                    <span className="text-muted-foreground">Desi:</span>{" "}
                    {rule.minDesi} — {rule.maxDesi === 999 ? "∞" : rule.maxDesi}
                  </span>
                  <span className="font-semibold text-primary">
                    {formatCurrency(rule.cargoCost)} kargo
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kargo Kuralı Ekle</DialogTitle>
          </DialogHeader>
          <RuleForm onSubmit={(d) => createMutation.mutate(d)} isPending={createMutation.isPending} />
        </DialogContent>
      </Dialog>

      <Dialog open={!!editing} onOpenChange={() => setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Kuralı Düzenle</DialogTitle>
          </DialogHeader>
          {editing && (
            <RuleForm
              defaultValues={{
                ...editing,
                cargoProvider: editing.cargoProvider ?? undefined,
                categoryName: editing.categoryName ?? undefined,
              }}
              onSubmit={(d) => updateMutation.mutate({ id: editing.id, data: d })}
              isPending={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
