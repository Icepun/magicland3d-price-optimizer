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
import { Plus, Pencil, Search, Trash2 } from "lucide-react";
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
      toast.success("Kural güncellendi");
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/commission-rules/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["commission-rules"] });
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
        Urun bazli komisyonlar Trendyol API sayfasindaki Komisyonlari Guncelle ile
        cekilir. Bu sayfa sadece gerektiginde genel/fallback komisyon kurali
        tanimlamak icindir.
      </p>

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
        <p className="text-muted-foreground">Yükleniyor...</p>
      ) : rules.length === 0 ? (
        <Card className="py-12 text-center">
          <CardContent>
            <p className="text-muted-foreground">Henüz kural yok.</p>
          </CardContent>
        </Card>
      ) : filteredRules.length === 0 ? (
        <Card className="py-12 text-center">
          <CardContent>
            <p className="text-muted-foreground">Aramaya uygun komisyon kuralı bulunamadı.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {filteredRules.map((rule) => (
            <Card key={rule.id} className={!rule.isActive ? "opacity-50" : ""}>
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
                      onClick={() => setEditing(rule)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-destructive"
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
