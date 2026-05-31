"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Layers, Plus, Trash2, Pencil, X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrency, cn } from "@/lib/utils";

interface Variant {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  colorHex: string | null;
  stock: number;
  priceOverride: number | null;
  filamentWeightOverride: number | null;
}

interface FormState {
  name: string;
  colorHex: string;
  sku: string;
  stock: string;
  priceOverride: string;
  filamentWeightOverride: string;
}

const EMPTY: FormState = { name: "", colorHex: "#e23b3b", sku: "", stock: "0", priceOverride: "", filamentWeightOverride: "" };

export function VariantsCard({
  productId,
  basePrice,
  baseWeight,
}: {
  productId: string;
  basePrice: number;
  baseWeight: number | null;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<Variant[]>({
    queryKey: ["variants", productId],
    queryFn: () => fetch(`/api/products/${productId}/variants`).then((r) => r.json()),
  });
  const variants = Array.isArray(data) ? data : [];

  const [editingId, setEditingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);

  function openAdd() {
    setForm(EMPTY);
    setEditingId(null);
    setShowForm(true);
  }
  function openEdit(v: Variant) {
    setForm({
      name: v.name,
      colorHex: v.colorHex ?? "#e23b3b",
      sku: v.sku ?? "",
      stock: String(v.stock),
      priceOverride: v.priceOverride != null ? String(v.priceOverride) : "",
      filamentWeightOverride: v.filamentWeightOverride != null ? String(v.filamentWeightOverride) : "",
    });
    setEditingId(v.id);
    setShowForm(true);
  }
  function close() {
    setShowForm(false);
    setEditingId(null);
  }

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: form.name.trim(),
        colorHex: form.colorHex || null,
        sku: form.sku.trim() || null,
        stock: Number(form.stock) || 0,
        priceOverride: form.priceOverride ? Number(form.priceOverride) : null,
        filamentWeightOverride: form.filamentWeightOverride ? Number(form.filamentWeightOverride) : null,
      };
      const url = editingId ? `/api/variants/${editingId}` : `/api/products/${productId}/variants`;
      return fetch(url, {
        method: editingId ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => {
        if (!r.ok) throw new Error("Kaydedilemedi");
        return r.json();
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["variants", productId] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success(editingId ? "Varyant güncellendi" : "Varyant eklendi");
      close();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const del = useMutation({
    mutationFn: (id: string) => fetch(`/api/variants/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["variants", productId] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Varyant silindi");
    },
  });

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-500" style={{ animationDelay: "20ms", animationFillMode: "both" }}>
      <CardHeader className="pb-3 border-b border-border/50">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Layers className="h-4 w-4 text-primary" />
            Varyantlar
            {variants.length > 0 && (
              <Badge variant="outline" className="ml-1 tabular-nums">{variants.length}</Badge>
            )}
          </CardTitle>
          {!showForm && (
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={openAdd}>
              <Plus className="h-3.5 w-3.5" /> Ekle
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-3 space-y-2">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : variants.length === 0 && !showForm ? (
          <p className="text-xs text-muted-foreground py-2">
            Henüz varyant yok. Aynı ürünün renk/boy/tip seçeneklerini ekleyebilirsin (örn. Kırmızı, Mavi, Büyük Boy).
          </p>
        ) : (
          variants.map((v) =>
            editingId === v.id ? (
              <VariantForm key={v.id} form={form} setForm={setForm} onSave={() => save.mutate()} onCancel={close} pending={save.isPending} />
            ) : (
              <div key={v.id} className="flex items-center gap-2.5 py-1.5 border-b border-border/30 last:border-0">
                <span className="h-4 w-4 rounded-full border shrink-0" style={{ background: v.colorHex ?? "#9ca3af" }} />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate">{v.name}</p>
                  {v.sku && <p className="text-[10px] text-muted-foreground font-mono truncate">{v.sku}</p>}
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  <p className="text-xs font-medium">{formatCurrency(v.priceOverride ?? basePrice)}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {(v.filamentWeightOverride ?? baseWeight ?? 0) > 0 ? `${Math.round(v.filamentWeightOverride ?? baseWeight ?? 0)}g · ` : ""}
                    stok {v.stock}
                  </p>
                </div>
                <div className="flex gap-0.5 shrink-0">
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(v)} title="Düzenle">
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-destructive/70 hover:text-destructive"
                    title="Sil"
                    onClick={() => del.mutate(v.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            )
          )
        )}

        {showForm && !editingId && (
          <VariantForm form={form} setForm={setForm} onSave={() => save.mutate()} onCancel={close} pending={save.isPending} />
        )}
      </CardContent>
    </Card>
  );
}

function VariantForm({
  form,
  setForm,
  onSave,
  onCancel,
  pending,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  pending: boolean;
}) {
  const set = (k: keyof FormState, val: string) => setForm({ ...form, [k]: val });
  return (
    <div className="rounded-lg border bg-muted/20 p-3 space-y-2.5 animate-in fade-in duration-200">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">{form.name ? "Varyant düzenle" : "Yeni varyant"}</span>
        <button onClick={onCancel} className="p-0.5 text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-2">
        <div>
          <Label className="text-[10px]">Ad</Label>
          <Input className="h-8" value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="örn. Kırmızı / Büyük Boy" />
        </div>
        <div>
          <Label className="text-[10px]">Renk</Label>
          <input type="color" value={form.colorHex} onChange={(e) => set("colorHex", e.target.value)} className="h-8 w-12 rounded-md border bg-background cursor-pointer" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <Label className="text-[10px]">Stok</Label>
          <Input className="h-8" type="number" value={form.stock} onChange={(e) => set("stock", e.target.value)} />
        </div>
        <div>
          <Label className="text-[10px]">Fiyat (boş=ana)</Label>
          <Input className="h-8" type="number" value={form.priceOverride} onChange={(e) => set("priceOverride", e.target.value)} placeholder="ana fiyat" />
        </div>
        <div>
          <Label className="text-[10px]">Gramaj (boş=ana)</Label>
          <Input className="h-8" type="number" value={form.filamentWeightOverride} onChange={(e) => set("filamentWeightOverride", e.target.value)} placeholder="ana gramaj" />
        </div>
      </div>
      <div>
        <Label className="text-[10px]">SKU (opsiyonel)</Label>
        <Input className="h-8" value={form.sku} onChange={(e) => set("sku", e.target.value)} />
      </div>
      <div className="flex gap-2">
        <Button size="sm" className="flex-1 h-8" disabled={pending || !form.name.trim()} onClick={onSave}>
          {pending ? "Kaydediliyor…" : "Kaydet"}
        </Button>
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>İptal</Button>
      </div>
    </div>
  );
}
