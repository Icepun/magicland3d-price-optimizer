import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getUserDataDir } from "@/lib/storage";
import { etiketYazicisiSec } from "./yazici-secimi";
import { KullaniciHatasi } from "./kullanici-hatasi";

const GONDERILEMEDI = "Etiket yazıcıya gönderilemedi. Yazıcının açık ve bağlı olduğunu kontrol et.";

/**
 * Etiket yazıcısına HAM (RAW) gönderim — sürücü çizmez, ZPL olduğu gibi yazıcıya gider.
 *
 * Ölçüldü 13 Kas 2026: Xprinter XP-490B (Windows, USB001, üreticinin sürücüsü) ZPL'i doğrudan
 * anlıyor; ^CI28 ile Türkçe harfler ve ^BC barkod düzgün basıldı. Panelden "resim olarak"
 * basarken gereken ölçek/kağıt ayarı (USER, %35) burada gerekmez: ZPL kendi ölçüsünü taşır.
 *
 * Windows: winspool.drv (OpenPrinter → StartDocPrinter "RAW" → WritePrinter) PowerShell
 * içinden çağrılır — ek paket yok. macOS/Linux: `lp -o raw`.
 *
 * Seçili yazıcı BU BİLGİSAYARA aittir (Mac'te başka yazıcı olabilir) → veritabanında değil,
 * userData'da yerel dosyada.
 */

const SECIM_DOSYASI = "etiket-yazici.json";
const ZAMAN_ASIMI_MS = 30_000;

export interface YaziciListesi {
  yazicilar: string[];
  /** Kullanılacak yazıcı (kayıtlı seçim ya da otomatik bulunan); bulunamazsa null. */
  secili: string | null;
  /** Seçim kullanıcıdan mı geldi, yoksa adından mı tahmin edildi. */
  elleSecildi: boolean;
}

function calistir(komut: string, argumanlar: string[], ortam?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      komut,
      argumanlar,
      { timeout: ZAMAN_ASIMI_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: ortam ?? process.env },
      (hata, stdout, stderr) => {
        if (hata) {
          const ayrinti = String(stderr || stdout || hata.message).trim().slice(0, 400);
          reject(new Error(ayrinti || hata.message));
          return;
        }
        resolve(String(stdout));
      }
    );
  });
}

const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"];

async function windowsYazicilari(): Promise<string[]> {
  const cikti = await calistir("powershell.exe", [
    ...POWERSHELL_ARGS,
    "-Command",
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Printer | ForEach-Object { $_.Name }",
  ]);
  return cikti.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

async function cupsYazicilari(): Promise<string[]> {
  // `lpstat -e` yalnız adları verir (CUPS 2.x); eski sürümde `-a`'nın ilk sütunu.
  try {
    const cikti = await calistir("lpstat", ["-e"]);
    const adlar = cikti.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (adlar.length) return adlar;
  } catch {
    /* aşağıdaki yola düş */
  }
  const cikti = await calistir("lpstat", ["-a"]);
  return cikti
    .split(/\r?\n/)
    .map((s) => s.trim().split(/\s+/)[0])
    .filter(Boolean);
}

export async function yazicilariListele(): Promise<string[]> {
  return process.platform === "win32" ? windowsYazicilari() : cupsYazicilari();
}

function secimDosyasi(): string {
  return path.join(getUserDataDir(), SECIM_DOSYASI);
}

function kayitliSecim(): string | null {
  try {
    const veri = JSON.parse(fs.readFileSync(secimDosyasi(), "utf8")) as { yazici?: unknown };
    return typeof veri.yazici === "string" && veri.yazici.trim() ? veri.yazici : null;
  } catch {
    return null;
  }
}

export function etiketYazicisiKaydet(yazici: string): void {
  fs.mkdirSync(path.dirname(secimDosyasi()), { recursive: true });
  fs.writeFileSync(secimDosyasi(), JSON.stringify({ yazici }, null, 2), "utf8");
}

export async function yaziciDurumu(): Promise<YaziciListesi> {
  const yazicilar = await yazicilariListele();
  const kayitli = kayitliSecim();
  const secim = etiketYazicisiSec(yazicilar, kayitli);
  return { yazicilar, secili: secim.yazici, elleSecildi: secim.elleSecildi };
}

/**
 * winspool'u çağıran betik. Yazıcı adı ve dosya yolu ARGÜMAN olarak geçer (execFile, kabuk
 * yok) → adda boşluk/tırnak olsa da bozulmaz. Çıktı: yazılan bayt sayısı ya da -WinHata.
 */
const WINDOWS_BETIGI = String.raw`param([string]$Yazici, [string]$Dosya)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class MlhubHamYazici {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern int StartDocPrinter(IntPtr h, int level, DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] static extern bool WritePrinter(IntPtr h, byte[] b, int n, out int w);
  public static int Gonder(string yazici, byte[] veri, string belge) {
    IntPtr h;
    if (!OpenPrinter(yazici, out h, IntPtr.Zero)) return -Marshal.GetLastWin32Error();
    try {
      var di = new DOCINFO { pDocName = belge, pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) return -Marshal.GetLastWin32Error();
      try {
        if (!StartPagePrinter(h)) return -Marshal.GetLastWin32Error();
        int w; bool ok = WritePrinter(h, veri, veri.Length, out w);
        EndPagePrinter(h);
        if (!ok) return -Marshal.GetLastWin32Error();
        return w;
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
$veri = [System.IO.File]::ReadAllBytes($Dosya)
[MlhubHamYazici]::Gonder($Yazici, $veri, 'Magicland kargo etiketi')
`;

function betikYolu(): string {
  const yol = path.join(os.tmpdir(), "mlhub-ham-yazici-v1.ps1");
  try {
    if (fs.readFileSync(yol, "utf8") === WINDOWS_BETIGI) return yol;
  } catch {
    /* yok → yaz */
  }
  fs.writeFileSync(yol, WINDOWS_BETIGI, "utf8");
  return yol;
}

/** Ham veriyi yazıcıya gönderir. Başarısızlıkta kullanıcıya gösterilebilir kısa hata fırlatır. */
export async function hamYazdir(yazici: string, veri: Buffer): Promise<void> {
  const gecici = path.join(
    os.tmpdir(),
    `mlhub-etiket-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`
  );
  fs.writeFileSync(gecici, veri);
  try {
    if (process.platform === "win32") {
      let cikti: string;
      try {
        cikti = (await calistir("powershell.exe", [...POWERSHELL_ARGS, "-File", betikYolu(), "-Yazici", yazici, "-Dosya", gecici])).trim();
      } catch (hata) {
        throw new KullaniciHatasi(GONDERILEMEDI, hata);
      }
      const yazilan = Number(cikti.split(/\r?\n/).pop());
      if (!Number.isFinite(yazilan) || yazilan <= 0) {
        // 1801 = yazıcı adı geçersiz (silinmiş/yeniden adlandırılmış).
        if (yazilan === -1801) throw new KullaniciHatasi("Etiket yazıcısı bulunamadı. Yazıcıyı yeniden seç.", cikti);
        throw new KullaniciHatasi(GONDERILEMEDI, cikti);
      }
      return;
    }
    try {
      await calistir("lp", ["-d", yazici, "-o", "raw", gecici]);
    } catch (hata) {
      throw new KullaniciHatasi(GONDERILEMEDI, hata);
    }
  } finally {
    fs.rm(gecici, { force: true }, () => {});
  }
}
