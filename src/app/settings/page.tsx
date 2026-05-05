"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";

const Schema = z.object({
  defaultMinNetProfit: z.coerce.number().min(0).default(0),
  defaultMinMargin: z.coerce.number().min(0).max(100).default(0),
});

type FormData = z.infer<typeof Schema>;

export default function SettingsPage() {
  const queryClient = useQueryClient();

  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["settings"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });

  const form = useForm<FormData>({
    resolver: zodResolver(Schema),
    defaultValues: { defaultMinNetProfit: 0, defaultMinMargin: 0 },
  });

  useEffect(() => {
    if (settings) {
      form.reset({
        defaultMinNetProfit: Number(settings.defaultMinNetProfit ?? 0),
        defaultMinMargin: Number(settings.defaultMinMargin ?? 0),
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: (data: FormData) =>
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultMinNetProfit: String(data.defaultMinNetProfit),
          defaultMinMargin: String(data.defaultMinMargin / 100),
        }),
      }).then((r) => r.json()),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
      toast.success("Ayarlar kaydedildi");
    },
    onError: () => toast.error("Kaydedilemedi"),
  });

  return (
    <div className="p-6 space-y-6 max-w-xl">
      <h1 className="text-2xl font-bold">Ayarlar</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Minimum Kâr Eşikleri</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={form.handleSubmit((d) => saveMutation.mutate(d))}
            className="space-y-4"
          >
            <div>
              <Label>Minimum Net Kâr (TL)</Label>
              <Input
                type="number"
                step="1"
                {...form.register("defaultMinNetProfit")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Bu değerin altındaki kâra sahip fiyatlar simülasyonda &quot;geçersiz&quot; sayılır.
              </p>
            </div>
            <div>
              <Label>Minimum Kâr Oranı (%)</Label>
              <Input
                type="number"
                step="0.5"
                {...form.register("defaultMinMargin")}
              />
              <p className="text-xs text-muted-foreground mt-1">
                Örnek: 20 girerseniz kâr oranı %20&apos;nin altındaki fiyatlar elenir.
              </p>
            </div>
            <Button type="submit" disabled={saveMutation.isPending}>
              {saveMutation.isPending ? "Kaydediliyor..." : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Uygulama Hakkında</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-1">
          <p>Trendyol Price Optimizer v0.1.0</p>
          <p>Magicland 3D Apps</p>
          <p className="mt-2">
            Veritabanı: SQLite (lokal) — ileride Supabase PostgreSQL&apos;e geçilebilir.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
