"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Cloud, Loader2, CheckCircle2, AlertTriangle, Copy, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const CORS_JSON = `[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "PUT", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]`;

type TestState =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok" }
  | { kind: "error"; msg: string };

/**
 * Cloud Depolama (Cloudflare R2). Model dosyaları buraya yüklenir → tüm cihazlardan (Mac/Win)
 * erişilir, yerel disk şişmez. "Kaydet ve Bağlantıyı Test Et": önce sunucu kimliği doğrular
 * (HeadBucket), sonra tarayıcının gerçek bir CORS round-trip'i yapabildiğini test eder.
 */
export function R2StorageCard() {
  const { data: settings } = useQuery<Record<string, string>>({
    queryKey: ["app-settings-r2"],
    queryFn: () => fetch("/api/settings").then((r) => r.json()),
  });
  return (
    <R2StorageForm
      key={settings ? "loaded" : "loading"}
      settings={settings ?? {}}
    />
  );
}

function R2StorageForm({ settings }: { settings: Record<string, string> }) {
  const qc = useQueryClient();

  const [accountId, setAccountId] = useState(settings.r2AccountId ?? "");
  const [bucket, setBucket] = useState(settings.r2Bucket ?? "");
  const [accessKeyId, setAccessKeyId] = useState(settings.r2AccessKeyId ?? "");
  const [secret, setSecret] = useState(settings.r2SecretKey ?? "");
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<TestState>({ kind: "idle" });
  const [showSetup, setShowSetup] = useState(false);

  const configured = !!(accountId.trim() && bucket.trim() && accessKeyId.trim() && secret.trim());

  async function saveAndTest() {
    if (busy) return;
    setBusy(true);
    setTest({ kind: "testing" });
    try {
      // 1. Kaydet
      const save = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          r2AccountId: accountId.trim(),
          r2Bucket: bucket.trim(),
          r2AccessKeyId: accessKeyId.trim(),
          r2SecretKey: secret.trim(),
        }),
      });
      if (!save.ok) throw new Error("Ayarlar kaydedilemedi");
      qc.invalidateQueries({ queryKey: ["app-settings-r2"] });
      qc.invalidateQueries({ queryKey: ["app-settings"] });

      if (!configured) {
        setTest({ kind: "error", msg: "Önce 4 alanı da doldur." });
        return;
      }

      // 2. Sunucu tarafı: kimlik + bucket
      const r = await fetch("/api/storage/r2-test", { method: "POST" });
      const data = (await r.json().catch(() => ({}))) as { ok?: boolean; error?: string; corsTestUrl?: string };
      if (!r.ok || !data.ok || !data.corsTestUrl) {
        setTest({ kind: "error", msg: data.error || "Kimlik/bucket doğrulanamadı." });
        return;
      }

      // 3. Tarayıcı CORS round-trip (gerçek PUT)
      try {
        const put = await fetch(data.corsTestUrl, { method: "PUT", body: "ok" });
        if (!put.ok) {
          setTest({ kind: "error", msg: `Tarayıcı yüklemesi reddedildi (HTTP ${put.status}). CORS ayarını kontrol et.` });
          return;
        }
      } catch {
        setTest({ kind: "error", msg: "Tarayıcı buluta yazamadı — büyük olasılıkla CORS ayarı eksik. Aşağıdaki JSON'u bucket CORS'una ekle." });
        setShowSetup(true);
        return;
      }

      setTest({ kind: "ok" });
      toast.success("Cloud depolama hazır 🎉");
    } catch (e) {
      setTest({ kind: "error", msg: e instanceof Error ? e.message : "Hata" });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <Cloud className="h-4 w-4 text-primary" /> Cloud Depolama (Cloudflare R2)
          {configured && test.kind === "ok" && (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] font-semibold text-green-600 dark:text-green-500">
              <CheckCircle2 className="h-3.5 w-3.5" /> Bağlı
            </span>
          )}
        </CardTitle>
        <p className="text-[11px] text-muted-foreground leading-relaxed mt-1">
          Model dosyaları buluta yüklenir → Mac&apos;ten de basabilirsin, yerel disk şişmez. Boş bırakırsan
          dosyalar eskisi gibi bu bilgisayarda saklanır.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <Label className="text-xs">Account ID</Label>
            <Input value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="cloudflare hesap kimliği" className="font-mono text-xs" />
          </div>
          <div>
            <Label className="text-xs">Bucket adı</Label>
            <Input value={bucket} onChange={(e) => setBucket(e.target.value)} placeholder="örn. magicland-models" className="font-mono text-xs" />
          </div>
          <div>
            <Label className="text-xs">Access Key ID</Label>
            <Input value={accessKeyId} onChange={(e) => setAccessKeyId(e.target.value)} placeholder="R2 API token" className="font-mono text-xs" />
          </div>
          <div>
            <Label className="text-xs">Secret Access Key</Label>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" className="font-mono text-xs" />
          </div>
        </div>

        {test.kind === "error" && (
          <div className="flex items-start gap-2 text-xs text-destructive bg-destructive/10 border border-destructive/30 rounded-md px-2.5 py-2">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>{test.msg}</span>
          </div>
        )}
        {test.kind === "ok" && (
          <div className="flex items-center gap-2 text-xs text-green-600 dark:text-green-500 bg-green-500/10 border border-green-500/30 rounded-md px-2.5 py-2">
            <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
            <span>Bağlantı ve CORS çalışıyor. Artık model yüklemeleri buluta gidecek.</span>
          </div>
        )}

        <div className="flex items-center gap-2">
          <Button onClick={saveAndTest} disabled={busy} className="gap-2">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}
            Kaydet ve Bağlantıyı Test Et
          </Button>
          <button
            type="button"
            onClick={() => setShowSetup((v) => !v)}
            className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
          >
            Kurulum adımları <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", showSetup && "rotate-180")} />
          </button>
        </div>

        {showSetup && (
          <div className="rounded-lg border bg-muted/30 p-3 space-y-2 text-[11px] text-muted-foreground leading-relaxed animate-in fade-in slide-in-from-top-1">
            <ol className="list-decimal list-inside space-y-1">
              <li>Cloudflare R2&apos;de özel bir <strong className="text-foreground">bucket</strong> aç.</li>
              <li>Yöneticiden bu bucket&apos;a özel bir <strong className="text-foreground">API token</strong> (Object Read &amp; Write) üret → Access Key ID + Secret.</li>
              <li>Account ID&apos;yi R2 panelinden al, yukarı gir.</li>
              <li>Bucket → <strong className="text-foreground">Settings → CORS policy</strong>&apos;e şu JSON&apos;u yapıştır:</li>
            </ol>
            <div className="relative">
              <pre className="bg-background border rounded-md p-2 overflow-x-auto text-[10px] font-mono text-foreground/90">{CORS_JSON}</pre>
              <Button
                size="icon"
                variant="ghost"
                className="absolute top-1 right-1 h-6 w-6"
                onClick={() => { navigator.clipboard?.writeText(CORS_JSON); toast.success("CORS JSON kopyalandı"); }}
                title="Kopyala"
              >
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
