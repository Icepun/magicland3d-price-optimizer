"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Building2, CheckCircle2, Undo2, Warehouse } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { fetchJson } from "@/lib/fetch-json";
import { cn } from "@/lib/utils";

interface Hesap {
  sirketAdi: string;
  sirketKodu: string;
  aktarmaKodu: string;
  barkodOnEki: string;
  depo: { adresKimligi: string; il: string; ilce: string; mahalle: string; adres: string; yetkili?: string; telefon?: string };
}

const BOS: Hesap = {
  sirketAdi: "", sirketKodu: "", aktarmaKodu: "", barkodOnEki: "",
  depo: { adresKimligi: "", il: "", ilce: "", mahalle: "", adres: "", yetkili: "", telefon: "" },
};

type Alan =
  | { ad: string; yol: keyof Omit<Hesap, "depo">; ipucu?: string; kucuk?: boolean }
  | { ad: string; yol: `depo.${keyof Hesap["depo"]}`; ipucu?: string; kucuk?: boolean; genis?: boolean };

const HESAP_ALANLARI: Alan[] = [
  { ad: "Şirket adı", yol: "sirketAdi" },
  { ad: "Şirket kodu", yol: "sirketKodu", kucuk: true },
  { ad: "Aktarma merkezi kodu", yol: "aktarmaKodu", kucuk: true },
  { ad: "Barkod ön eki", yol: "barkodOnEki", ipucu: "3 harf", kucuk: true },
];
const DEPO_ALANLARI: Alan[] = [
  { ad: "Depo adres kimliği", yol: "depo.adresKimligi", kucuk: true },
  { ad: "İl", yol: "depo.il" },
  { ad: "İlçe", yol: "depo.ilce" },
  { ad: "Mahalle", yol: "depo.mahalle" },
  { ad: "Açık adres", yol: "depo.adres", genis: true },
];
const IADE_ALANLARI: Alan[] = [
  { ad: "Teslim alacak kişi", yol: "depo.yetkili" },
  { ad: "Telefon", yol: "depo.telefon", ipucu: "05xx xxx xx xx" },
];

function oku(h: Hesap, yol: Alan["yol"]): string {
  if (yol.startsWith("depo.")) return (h.depo[yol.slice(5) as keyof Hesap["depo"]] as string | undefined) ?? "";
  return h[yol as keyof Omit<Hesap, "depo">];
}

function yaz(h: Hesap, yol: Alan["yol"], deger: string): Hesap {
  if (yol.startsWith("depo.")) return { ...h, depo: { ...h.depo, [yol.slice(5)]: deger } };
  return { ...h, [yol]: deger };
}

/**
 * HepsiJet'in hesaba tanımladığı gönderici ve iade bilgileri (mailindeki sabitler). Kargo
 * oluşturma bu bilgiler girilmeden çalışmaz. Mac ve Windows aynı kaydı görür.
 */
export function HepsijetHesapKarti() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery<{ hesap: Hesap | null }>({
    queryKey: ["hepsijet-hesap"],
    queryFn: () => fetchJson("/api/hepsijet/hesap"),
  });
  const [taslak, setTaslak] = useState<Hesap | null>(null);
  const kayitli = data?.hesap ?? null;
  const h = taslak ?? kayitli ?? BOS;
  const degisti = taslak != null && JSON.stringify(taslak) !== JSON.stringify(kayitli ?? BOS);

  const kaydet = useMutation({
    mutationFn: () =>
      fetchJson<{ hesap: Hesap }>("/api/hepsijet/hesap", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(h),
      }),
    onSuccess: (d) => {
      qc.setQueryData(["hepsijet-hesap"], d);
      setTaslak(null);
      toast.success("Gönderici bilgileri kaydedildi");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const grup = (baslik: string, Ikon: typeof Building2, alanlar: Alan[], gecikme: number) => (
    <div
      className="space-y-2 animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none"
      style={{ animationDelay: `${gecikme}ms`, animationFillMode: "both" }}
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
        <Ikon className="h-3.5 w-3.5" /> {baslik}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {alanlar.map((a) => (
          <div key={a.yol} className={cn("genis" in a && a.genis && "col-span-2")}>
            <Label className="text-xs">{a.ad}</Label>
            <Input
              value={oku(h, a.yol)}
              onChange={(e) => setTaslak(yaz(h, a.yol, e.target.value))}
              placeholder={a.ipucu}
              autoComplete="off"
              className={cn("mt-1 transition-shadow focus-visible:shadow-[0_0_0_3px_rgba(155,92,255,0.18)]", a.kucuk && "font-mono text-xs")}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <Card className="animate-in fade-in slide-in-from-bottom-2 duration-300 motion-reduce:animate-none">
      <CardHeader>
        <CardTitle className="text-sm flex items-center gap-2">
          <Warehouse className="h-4 w-4" /> Gönderici ve İade Bilgileri
          {kayitli && !degisti && (
            <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-500 animate-in zoom-in-75 duration-300">
              <CheckCircle2 className="h-3 w-3" /> Hazır
            </span>
          )}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground mt-1">HepsiJet&apos;in mailinde gönderdiği bilgileri gir.</p>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 animate-pulse rounded-md bg-muted/50" style={{ animationDelay: `${i * 120}ms` }} />
            ))}
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              kaydet.mutate();
            }}
          >
            {grup("Hesap", Building2, HESAP_ALANLARI, 0)}
            {grup("Gönderici deposu", Warehouse, DEPO_ALANLARI, 60)}
            {grup("İadeler", Undo2, IADE_ALANLARI, 120)}
            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={kaydet.isPending || !degisti} className="active:scale-[0.98] transition-transform">
                {kaydet.isPending ? "Kaydediliyor…" : "Kaydet"}
              </Button>
              {degisti && (
                <Button type="button" size="sm" variant="ghost" onClick={() => setTaslak(null)}>
                  Vazgeç
                </Button>
              )}
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
