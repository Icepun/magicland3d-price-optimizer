"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, PlugZap } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/fetch-json";

interface N11AcikAyarlar {
  anahtarVar: boolean;
  anahtarMaskeli: string;
  sifreVar: boolean;
}

/** n11 bağlantısı: API anahtarı + şifresi (n11 Satıcı Paneli → Hesabım → API Hesapları) ve deneme. */
export function N11Karti() {
  const qc = useQueryClient();
  const { data: ayarlar } = useQuery<N11AcikAyarlar>({
    queryKey: ["n11-settings"],
    queryFn: () => fetchJson("/api/n11/settings"),
  });
  const [anahtar, setAnahtar] = useState("");
  const [sifre, setSifre] = useState("");
  const [sonuc, setSonuc] = useState<{ urun: number; siparis: number } | null>(null);

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson<N11AcikAyarlar>("/api/n11/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey: anahtar || undefined, appSecret: sifre || undefined }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["n11-settings"], d);
      setAnahtar("");
      setSifre("");
      setSonuc(null);
      toast.success("n11 bilgileri kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const dene = useMutation({
    mutationFn: () => fetchJson<{ ok: boolean; urunSayisi: number; siparisSayisi: number }>("/api/n11/test", { method: "POST" }),
    onSuccess: (d) => {
      setSonuc({ urun: d.urunSayisi, siparis: d.siparisSayisi });
      toast.success("n11 bağlantısı çalışıyor");
    },
    onError: (e: Error) => {
      setSonuc(null);
      toast.error(e.message);
    },
  });

  const hazir = Boolean(ayarlar?.anahtarVar && ayarlar.sifreVar);
  const degisti = anahtar.trim() !== "" || sifre.trim() !== "";

  return (
    <div className="space-y-4">
      <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
        <CardHeader>
          <CardTitle className="text-sm flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> n11 Bağlantısı
            {hazir && !degisti && (
              <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500 animate-in zoom-in-75 duration-300">
                <CheckCircle2 className="h-3 w-3" /> Kayıtlı
              </span>
            )}
          </CardTitle>
          <p className="text-[11px] text-muted-foreground mt-1">
            n11 Satıcı Paneli → Hesabım → API Hesapları&apos;ndaki anahtar ve şifreyi gir. Bilgiler yalnız bu bilgisayarda saklanır.
          </p>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              kaydet.mutate();
            }}
          >
            <div>
              <Label className="text-xs">API Anahtarı</Label>
              <Input
                value={anahtar}
                onChange={(e) => setAnahtar(e.target.value)}
                autoComplete="off"
                placeholder={ayarlar?.anahtarVar ? `${ayarlar.anahtarMaskeli} (kayıtlı)` : "API anahtarı"}
              />
            </div>
            <div>
              <Label className="text-xs">API Şifresi</Label>
              <Input
                type="password"
                value={sifre}
                onChange={(e) => setSifre(e.target.value)}
                autoComplete="new-password"
                placeholder={ayarlar?.sifreVar ? "•••••••• (kayıtlı)" : "API şifresi"}
              />
            </div>
            <Button type="submit" size="sm" disabled={kaydet.isPending || !degisti} className="active:scale-[0.98] transition-transform">
              {kaydet.isPending ? "Kaydediliyor…" : "Kaydet"}
            </Button>
          </form>
        </CardContent>
      </Card>

      <Button variant="outline" className="w-full" disabled={dene.isPending || !hazir || degisti} onClick={() => dene.mutate()}>
        <PlugZap className={`h-4 w-4 mr-2 ${dene.isPending ? "animate-spin" : ""}`} />
        {dene.isPending ? "Deneniyor…" : "Bağlantıyı Dene"}
      </Button>

      {sonuc && (
        <Card className="border-green-500/40 bg-green-500/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <CardContent className="flex items-start gap-3 py-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-500 animate-in zoom-in-50 duration-300" />
            <div className="min-w-0 text-sm">
              <p className="font-semibold">Bağlandı</p>
              <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
                {sonuc.urun.toLocaleString("tr-TR")} ürün · son 30 günde {sonuc.siparis.toLocaleString("tr-TR")} sipariş
              </p>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
