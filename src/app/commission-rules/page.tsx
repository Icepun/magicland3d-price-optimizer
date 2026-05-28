"use client";

import { useMemo, useState } from "react";
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
import { Plus, Pencil, Search, Trash2, Percent, SearchX, ShoppingBag } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

interface CommissionRule {
  id: string;
  name: string;
  categoryName: string | null;
  minPrice: number;
  maxPrice: number;
  commissionRate: number;
  fixedCommission: number;
  priority: number;
  isActive: boolean;
}

const Schema = z.object({
  name: z.string().min(1, "Ad zorunlu"),
  categoryName: z.string().optional(),
  minPrice: z.coerce.number().min(0).default(0),
  maxPrice: z.coerce.number().min(0).default(999999),
  commissionRate: z.coerce.number().min(0).max(100),
  fixedCommission: z.coerce.number().min(0).default(0),
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
      fixedCommission: 0,
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
      <div>
        <Label>Kategori (boş = tüm kategoriler)</Label>
        <Input {...form.register("categoryName")} placeholder="Gamepad Standı" />
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
          <Label>Komisyon Oranı (%)</Label>
          <Input type="number" step="0.1" {...form.register("commissionRate")} placeholder="18" />
        </div>
        <div>
          <Label>Sabit Komisyon (TL)</Label>
          <Input type="number" step="0.01" {...form.register("fixedCommission")} />
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

export default function CommissionRulesPage() {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<CommissionRule | null>(null);
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();

  const { data: rules = [], isLoading } = useQuery<CommissionRule[]>({
    queryKey: ["commission-rules"],
    queryFn: () => fetch("/api/commission-rules").then((r) => r.json()),
  });

  const createMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetch("/api/commission-rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, commissionRate: data.commissionRate / 100 }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commission-rules"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Kural eklendi");
      setOpen(false);
    },
    onError: () => toast.error("Eklenemedi"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: FormData }) =>
      fetch(`/api/commission-rules/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, commissionRate: data.commissionRate / 100 }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commission-rules"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Kural güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/commission-rules/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commission-rules"] });
      queryClient.invalidateQueries({ queryKey: ["products"] });
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Kural silindi");
    },
  });

  const filteredRules = useMemo(() => {
    const q = search.trim().toLocaleLowerCase("tr-TR");
    if (!q) return rules;

    return rules.filter((rule) =>
      [rule.name, rule.categoryName]
        .filter(Boolean)
        .some((value) => String(value).toLocaleLowerCase("tr-TR").includes(q))
    );
  }, [rules, search]);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Komisyon Kuralları</h1>
        <Button onClick={() => setOpen(true)} size="sm">
          <Plus className="h-4 w-4 mr-2" /> Kural Ekle
        </Button>
      </div>

      <p className="text-sm text-muted-foreground">
        Aşağıdaki kurallar <strong>Trendyol</strong> kategori bazlı komisyonu içindir.
        Shopify komisyonu sabittir, ayrı kartta. Trendyol&apos;da ürüne komisyon
        girilmezse ürün listesinde kırmızı uyarı çıkar.
      </p>

      <ShopifyCommissionCard />

      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Kategori veya kural ara..."
          className="pl-9"
        />
      </div>

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
          icon={Percent}
          title="Henüz komisyon kuralı yok"
          description="Trendyol API sayfasından 'Komisyonları Güncelle' ile ürün bazlı komisyonları çek, ya da fallback için manuel kural ekle."
          action={
            <Button onClick={() => setOpen(true)} size="sm">
              <Plus className="h-4 w-4 mr-2" /> İlk Kuralı Ekle
            </Button>
          }
        />
      ) : filteredRules.length === 0 ? (
        <EmptyState
          icon={SearchX}
          title="Aramaya uygun kural yok"
          description={`"${search}" için sonuç bulunamadı. Farklı bir kategori veya kural adı deneyin.`}
        />
      ) : (
        <div className="grid gap-3">
          {filteredRules.map((rule, index) => (
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
                  <CardTitle className="text-sm font-semibold">{rule.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-xs">
                      Öncelik: {rule.priority}
                    </Badge>
                    {!rule.isActive && <Badge variant="secondary" className="text-xs">Pasif</Badge>}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      title="Düzenle"
                      onClick={() => setEditing(rule)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
                      title="Sil"
                      onClick={() => deleteMutation.mutate(rule.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex flex-wrap gap-3 text-sm">
                  {rule.categoryName && (
                    <span><span className="text-muted-foreground">Kategori:</span> {rule.categoryName}</span>
                  )}
                  <span>
                    <span className="text-muted-foreground">Fiyat:</span>{" "}
                    {rule.minPrice} — {rule.maxPrice === 999999 ? "∞" : rule.maxPrice} TL
                  </span>
                  <span className="font-semibold text-primary">
                    %{(rule.commissionRate * 100).toFixed(1)} komisyon
                    {rule.fixedCommission > 0 && ` + ${rule.fixedCommission} TL sabit`}
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
            <DialogTitle>Komisyon Kuralı Ekle</DialogTitle>
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
                commissionRate: editing.commissionRate * 100,
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

/**
 * Shopify sabit komisyon kartı — AppSetting.shopifyCommissionRate (yüzde).
 * Shopify listing'lerine override yoksa bu oran uygulanır.
 */
function ShopifyCommissionCard() {
  const qc = useQueryClient();
  const { data: settings = {} } = useQuery<Record<string, string>>({
    queryKey: ["app-settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });
  const [value, setValue] = useState<string | null>(null);
  const current = value ?? settings.shopifyCommissionRate ?? "3.2";

  const save = useMutation({
    mutationFn: (rate: string) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shopifyCommissionRate: rate }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      toast.success("Shopify komisyonu kaydedildi — tüm Shopify listing'lerine uygulandı");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  return (
    <Card className="border-emerald-500/30 bg-emerald-500/5">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <ShoppingBag className="h-4 w-4 text-emerald-500" /> Shopify Sabit Komisyonu
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex items-end gap-3">
          <div className="flex-1 max-w-[180px]">
            <Label className="text-xs">Komisyon Oranı (%)</Label>
            <Input
              type="number"
              min="0"
              max="100"
              step="0.1"
              value={current}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            onClick={() => save.mutate(current)}
            disabled={save.isPending}
          >
            {save.isPending ? "Kaydediliyor..." : "Kaydet"}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground mt-2">
          Shopify tüm ürünlerde aynı komisyonu alır (varsayılan %3.2). Bir Shopify
          listing&apos;inde özel oran girersen o öncelikli olur.
        </p>
      </CardContent>
    </Card>
  );
}
