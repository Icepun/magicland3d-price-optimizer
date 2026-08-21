/**
 * AKTARIM HIZ SINIRI — Snapmaker U1 tam hızda yüklemede ağdan düşüyor.
 *
 * ÖLÇÜLDÜ (21 Ağu 2026): U1'e büyük dosya yüklenirken kart ağdan TAMAMEN kayboluyor
 * (ICMP yok; 7125, 80 ve 22 portlarının üçü de "bağlantı reddedildi" değil ZAMAN AŞIMI
 * veriyor — yani adreste yanıt veren cihaz kalmıyor) ve elle kapatılıp açılana kadar
 * dönmüyor. Aynı anda Neptune 4 Pro 2-4 ms'de yanıtlıyor.
 *
 * Düşüş yüzdesi SABİT DEĞİL — %5, %24, %40-50 → dosya boyutu eşiği değil, hattı doldurmanın
 * kendisi. Karşılaştırma noktası: Bambu'nun FTP'si 183 KB/sn veriyor ve hiç düşmüyor.
 *
 * Bu dosya, sınırın YALNIZ sorunu yaşayan markaya uygulandığını ve sürüm çıkmadan
 * ayarlanabilir kaldığını kilitler — yanlış markayı yavaşlatmak sessiz bir gerileme olurdu.
 */
import { describe, expect, it, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const KAYNAK = fs.readFileSync(
  path.join(process.cwd(), "src/core/printers/moonraker.ts"),
  "utf8",
);

/** Kaynaktaki fonksiyonu izole çalıştır (modül ağ/DB bağımlılıkları yüklemeden). */
function hizSiniri(marka?: string): number {
  const m = /function yuklemeHizSiniriKbps\(marka\?: string\): number \{([\s\S]*?)\n\}/.exec(KAYNAK);
  if (!m) throw new Error("yuklemeHizSiniriKbps bulunamadı");
  const govde = m[1]
    .replace(/const env = Number\(process\.env\.MLHUB_UPLOAD_KBPS\);/, "const env = Number(ENV);");
  const fn = new Function("marka", "ENV", govde) as (m?: string, e?: string) => number;
  return fn(marka, process.env.MLHUB_UPLOAD_KBPS);
}

afterEach(() => {
  delete process.env.MLHUB_UPLOAD_KBPS;
});

describe("yükleme hız sınırı", () => {
  it("Snapmaker sınırlı — düşen marka bu", () => {
    expect(hizSiniri("snapmaker")).toBeGreaterThan(0);
    expect(hizSiniri("Snapmaker")).toBeGreaterThan(0);
  });

  it("diğer markalar TAM HIZDA kalır — onlarda sorun yok", () => {
    expect(hizSiniri("elegoo")).toBe(0);
    expect(hizSiniri("bambu")).toBe(0);
    expect(hizSiniri(undefined)).toBe(0);
  });

  it("env ile sürüm çıkmadan ayarlanabilir (0 = sınırsız)", () => {
    process.env.MLHUB_UPLOAD_KBPS = "256";
    expect(hizSiniri("snapmaker")).toBe(256);
    expect(hizSiniri("elegoo")).toBe(256);
    process.env.MLHUB_UPLOAD_KBPS = "0";
    expect(hizSiniri("snapmaker")).toBe(0);
  });

  it("geçersiz env değeri yok sayılır (yanlışlıkla sınırsız kalmasın)", () => {
    process.env.MLHUB_UPLOAD_KBPS = "abc";
    expect(hizSiniri("snapmaker")).toBeGreaterThan(0);
    process.env.MLHUB_UPLOAD_KBPS = "-5";
    expect(hizSiniri("snapmaker")).toBeGreaterThan(0);
  });
});

describe("yazma döngüsü", () => {
  it("parça boyu hız sınırıyla uyumlu (duraklamalar sık ve kısa olmalı)", () => {
    // 256 KB'lık parçayla 1 MB/sn sınırı, 4 kez/sn'lik kesikli akış demek olurdu.
    // Yükleme döngüsüne `req.write(head)` ile çıpalanıyor — fonksiyon adı yorumlarda da geçiyor.
    const govde = KAYNAK.slice(KAYNAK.indexOf("req.write(head);"));
    const m = /const CHUNK = (\d+) \* 1024;/.exec(govde);
    expect(m, "yükleme parçası bulunamadı").not.toBeNull();
    expect(Number(m![1])).toBeLessThanOrEqual(64);
  });

  it("bekleme planlanan süreye göre hesaplanıyor — sabit uyku DEĞİL", () => {
    // Sabit uyku, hızlı ağda gereksiz yavaşlatır; plan-tabanlı bekleme hedef hızı tutturur.
    expect(KAYNAK).toContain("const olmasiGereken = (off / baytSaniye) * 1000;");
  });
});
