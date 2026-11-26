"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, KeyRound, PlugZap, RefreshCw } from "lucide-react";
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
  const [esitleme, setEsitleme] = useState<{ bagli: number; bekleyen: number; degisen: number } | null>(null);

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson<N11AcikAyarlar>("/api/n11/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appKey: anahtar || undefined, appSecret: sifre || undefined }),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["n11-settings"], d);
      qc.invalidateQueries({ queryKey: ["integrations-status"] });
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

  // Ürünleri eşitle: stok kodu tutan ilanlar ürünlere bağlanır, kalanlar "Ürün Seç" havuzuna düşer,
  // bağlı ilanların fiyatı tazelenir. n11'e hiçbir şey yazılmaz.
  const esitle = useMutation({
    mutationFn: () =>
      fetchJson<{ linked?: number; unmatched?: number; checked?: number; changed?: number }>("/api/n11/sync-products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "full" }),
      }),
    onSuccess: (d) => {
      setEsitleme({ bagli: d.linked ?? 0, bekleyen: d.unmatched ?? 0, degisen: d.changed ?? 0 });
      toast.success("n11 ürünleri eşitlendi");
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });
      qc.invalidateQueries({ queryKey: ["unmatched-listings"] });
    },
    onError: (e: Error) => {
      setEsitleme(null);
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

      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" disabled={dene.isPending || !hazir || degisti} onClick={() => dene.mutate()}>
          <PlugZap className={`h-4 w-4 mr-2 ${dene.isPending ? "animate-spin" : ""}`} />
          {dene.isPending ? "Deneniyor…" : "Bağlantıyı Dene"}
        </Button>
        <Button variant="outline" disabled={esitle.isPending || !hazir || degisti} onClick={() => esitle.mutate()}>
          <RefreshCw className={`h-4 w-4 mr-2 ${esitle.isPending ? "animate-spin" : ""}`} />
          {esitle.isPending ? "Eşitleniyor…" : "Ürünleri Eşitle"}
        </Button>
      </div>

      {esitle.isPending && (
        <div className="space-y-1.5 animate-in fade-in duration-300" role="status">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full w-1/3 rounded-full bg-gradient-to-r from-[#9B5CFF] to-[#4F8CFF] animate-[n11-kayan_1.2s_ease-in-out_infinite] motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-60" />
          </div>
          <p className="text-[11px] text-muted-foreground">n11 ürünleri okunuyor ve ürünlerinle eşleştiriliyor…</p>
          <style>{`@keyframes n11-kayan { 0% { transform: translateX(-100%); } 100% { transform: translateX(300%); } }`}</style>
        </div>
      )}

      {esitleme && !esitle.isPending && (
        <Card className="border-[#7A7EFF]/40 bg-[#7A7EFF]/5 animate-in fade-in slide-in-from-bottom-2 duration-300">
          <CardContent className="grid grid-cols-3 gap-3 py-4 text-center">
            {([
              ["Bağlandı", esitleme.bagli],
              ["Eşleşme bekliyor", esitleme.bekleyen],
              ["Fiyatı değişti", esitleme.degisen],
            ] as const).map(([ad, sayi], i) => (
              <div key={ad} className="animate-in fade-in zoom-in-95 duration-500 fill-mode-both" style={{ animationDelay: `${i * 90}ms` }}>
                <p className="text-lg font-semibold tabular-nums">{sayi.toLocaleString("tr-TR")}</p>
                <p className="text-[11px] text-muted-foreground">{ad}</p>
              </div>
            ))}
            {esitleme.bekleyen > 0 && (
              <p className="col-span-3 text-[11px] text-muted-foreground">
                Eşleşmeyenleri Ürünler sayfasında &quot;Ürün Seç&quot; ile bağlayabilirsin.
              </p>
            )}
          </CardContent>
        </Card>
      )}

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
