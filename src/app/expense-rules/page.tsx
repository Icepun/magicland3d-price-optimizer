"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Plus, Pencil, Trash2, Receipt } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { fetchJson } from "@/lib/fetch-json";
import { clearPricingQueryCache } from "@/lib/pricing-query-cache";

interface ExpenseRule {
  id: string;
  name: string;
  platform: string | null;
  type: string;
  value: number;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  priority: number;
  isActive: boolean;
}

const Schema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  platform: z.enum(["all", "trendyol", "shopify", "hepsiburada"]).default("all"),
  type: z.enum(["fixed", "percentage", "per_order"]),
  value: z.coerce.number().min(0),
  categoryName: z.string().optional(),
  minPrice: z.coerce.number().min(0).default(0),
  maxPrice: z.coerce.number().min(0).default(999999),
  priority: z.coerce.number().int().default(10),
  isActive: z.boolean().default(true),
});

type FormData = z.infer<typeof Schema>;

const TYPE_LABELS: Record<string, string> = {
  fixed: "Sabit (TL)",
  percentage: "Yüzdesel (%)",
  per_order: "Sipariş Başına (TL)",
};

const PLATFORM_BADGE: Record<string, { label: string; cls: string }> = {
  trendyol: { label: "Trendyol", cls: "bg-orange-500/10 text-orange-500 border-orange-500/20" },
  shopify: { label: "Shopify", cls: "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" },
  hepsiburada: { label: "Hepsiburada", cls: "bg-violet-500/10 text-violet-500 border-violet-500/20" },
};

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
      platform: "all",
      type: "fixed",
      minPrice: 0,
      maxPrice: 999999,
      priority: 10,
      isActive: true,
      ...defaultValues,
    },
  });

  const expenseType = useWatch({ control: form.control, name: "type" });
  const isActive = useWatch({ control: form.control, name: "isActive" });
  const platform = useWatch({ control: form.control, name: "platform" });

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Gider Adı *</Label>
          <Input {...form.register("name")} placeholder="Platform Hizmet Bedeli" />
        </div>
        <div>
          <Label>Platform *</Label>
          <select
            value={platform}
            onChange={(e) => form.setValue("platform", e.target.value as "all" | "trendyol" | "shopify" | "hepsiburada")}
            className="w-full h-9 rounded-md border bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            <option value="all">Tüm platformlar</option>
            <option value="trendyol">Sadece Trendyol</option>
            <option value="shopify">Sadece Shopify</option>
            <option value="hepsiburada">Sadece Hepsiburada</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label>Tür *</Label>
          <Controller
            control={form.control}
            name="type"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="fixed">Sabit (TL)</SelectItem>
                  <SelectItem value="percentage">Yüzdesel (%)</SelectItem>
                  <SelectItem value="per_order">Sipariş Başına (TL)</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </div>
        <div>
          <Label>
            Değer ({expenseType === "percentage" ? "%" : "TL"}) *
          </Label>
          <Input type="number" step="0.01" {...form.register("value")} />
        </div>
      </div>
      <div>
        <Label>Kategori (boş = tüm kategoriler)</Label>
        <Input {...form.register("categoryName")} />
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
          <Label>Öncelik</Label>
          <Input type="number" {...form.register("priority")} />
        </div>
        <div className="flex items-center gap-2 pt-5">
          <Switch
            checked={isActive}
            onCheckedChange={(v) => form.setValue("isActive", v)}
          />
          <Label>Aktif</Label>
        </div>
      </div>
      <DialogFooter>
        <Button type="submit" disabled={isPending}>
          {isPending ? "Kaydediliyor..." : "Kaydet"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export default function ExpenseRulesPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<ExpenseRule | null>(null);
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery<ExpenseRule[]>({
    queryKey: ["expense-rules"],
    queryFn: () => fetchJson("/api/expense-rules"),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetchJson("/api/expense-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          platform: data.platform === "all" ? null : data.platform,
          value: data.type === "percentage" ? data.value / 100 : data.value,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expense-rules"] });
      clearPricingQueryCache(queryClient);
      toast.success("Kural eklendi");
      setOpen(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      fetchJson(`/api/expense-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...data,
          platform: data.platform === "all" ? null : data.platform,
          value: data.type === "percentage" ? data.value / 100 : data.value,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expense-rules"] });
      clearPricingQueryCache(queryClient);
      toast.success("Güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetchJson(`/api/expense-rules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["expense-rules"] });
      clearPricingQueryCache(queryClient);
      toast.success("Silindi");
    },
  });

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Ek Gider Kuralları</h1>
        <Button onClick={() => setOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" /> Gider Ekle
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Komisyon ve kargo dışındaki platform bedeli, kampanya maliyeti vb. giderleri tanımlayın.
      </p>

      {isLoading ? (
        <div className="grid gap-3">
          {[1, 2, 3].map((i) => (
            <Card key={i}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-6 w-20" />
                </div>
              </CardHeader>
              <CardContent>
                <Skeleton className="h-4 w-3/4" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : rules.length === 0 ? (
        <EmptyState
          icon={Receipt}
          title="Henüz ek gider kuralı yok"
          description="Komisyon ve kargo dışındaki platform bedeli, kampanya maliyeti vb. giderleri tanımlayın. Sabit, yüzdesel ya da sipariş başına olabilir."
          action={
            <Button onClick={() => setOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-2" /> İlk Kuralı Ekle
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3">
          {rules.map((rule, index) => (
            <Card
              key={rule.id}
              className={cn(
                "animate-in fade-in slide-in-from-bottom-2 duration-500",
                !rule.isActive && "opacity-50"
              )}
              style={{ animationDelay: `${index * 40}ms`, animationFillMode: "both" }}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-sm font-semibold flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        rule.platform
                          ? PLATFORM_BADGE[rule.platform]?.cls
                          : "bg-muted text-muted-foreground"
                      )}
                    >
                      {rule.platform ? PLATFORM_BADGE[rule.platform]?.label : "Tümü"}
                    </Badge>
                    {rule.name}
                  </CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      {TYPE_LABELS[rule.type]}
                    </Badge>
                    {!rule.isActive && (
                      <Badge variant="secondary" className="text-xs">Pasif</Badge>
                    )}
                    <Button variant="ghost" size="icon" className="h-7 w-7" title="Düzenle" onClick={() => setEditing(rule)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" title="Sil" onClick={() => deleteMutation.mutate(rule.id)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-3 text-sm">
                  <span className="font-semibold text-primary">
                    {rule.type === "percentage"
                      ? `%${(rule.value * 100).toFixed(2)}`
                      : `${rule.value} TL`}
                  </span>
                  <span>
                    <span className="text-muted-foreground">Fiyat:</span>{" "}
                    {rule.minPrice} — {rule.maxPrice === 999999 ? "∞" : rule.maxPrice} TL
                  </span>
                  {rule.categoryName && (
                    <span><span className="text-muted-foreground">Kategori:</span> {rule.categoryName}</span>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Ek Gider Kuralı Ekle</DialogTitle>
          </DialogHeader>
          <RuleForm
            onSubmit={(d) => createMutation.mutate(d)}
            isPending={createMutation.isPending}
          />
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
                platform: (editing.platform as "trendyol" | "shopify" | "hepsiburada") ?? "all",
                type: editing.type as "fixed" | "percentage" | "per_order",
                value: editing.type === "percentage" ? editing.value * 100 : editing.value,
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
