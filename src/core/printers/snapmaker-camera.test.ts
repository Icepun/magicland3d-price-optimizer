/**
 * SNAPMAKER U1 KAMERASI — ölçülen davranışın kilidi.
 *
 * U1'in kamerası standart `/webcam/` yolunda değil (orası her koşulda 502 veriyor), Moonraker'ın
 * dosya yolunda tek kare olarak duruyor: `/server/files/camera/monitor.jpg`.
 *
 * ASIL TUZAK: kamera boşta UYUYOR. Kimse istemezse kare tazelenmeyi bırakıyor ama adres son
 * (bayat) görüntüyü 200 + JPEG olarak döndürmeye devam ediyor. Yani "görüntü aldım" demek
 * "canlı" demek değil. Uyanık kalması için Moonraker WebSocket'ine `camera.start_monitor`
 * periyodik olarak gönderilmeli.
 *
 * Ölçüldü (23 Ağu 2026, gerçek U1): uyandırıldıktan sonra kare ~480 ms'de bir değişiyor
 * (≈2,1 fps), tek istek ~51 ms. Daha sık çekmek AYNI kareyi tekrar indirmek olurdu — bugün
 * öğrendiğimiz ders tam da yazıcıya gereksiz yük bindirmemek.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const KAYNAK = fs.readFileSync(
  path.join(process.cwd(), "src/core/printers/snapmaker-camera.ts"),
  "utf8",
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("kamera adresi ve uyandırma", () => {
  it("kare Moonraker'ın dosya yolundan alınıyor — /webcam/ DEĞİL", () => {
    expect(KAYNAK).toContain("/server/files/camera/monitor.jpg");
    expect(KAYNAK).not.toContain("action=stream");
  });

  it("uyandırma isteği doğru yöntem ve parametrelerle gönderiliyor", () => {
    expect(KAYNAK).toContain("camera.start_monitor");
    expect(KAYNAK).toContain('domain: "lan"');
  });

  it("uyandırma TEKRARLANIYOR — tek seferlik olsa kamera uykuya döner", () => {
    expect(KAYNAK).toContain("setInterval(uyandir");
    const m = /const UYANDIRMA_MS = ([\d_]+)/.exec(KAYNAK);
    expect(m, "uyandırma aralığı bulunamadı").not.toBeNull();
    // Kamera birkaç saniyede uykuya dönüyor; aralık bunun altında kalmalı.
    expect(Number(m![1].replace(/_/g, ""))).toBeLessThanOrEqual(10_000);
  });

  it("kare aralığı ölçülen tazelenme hızıyla uyumlu (daha sık çekmek boşuna)", () => {
    const m = /const KARE_MS = ([\d_]+)/.exec(KAYNAK);
    expect(m, "kare aralığı bulunamadı").not.toBeNull();
    const ms = Number(m![1].replace(/_/g, ""));
    expect(ms, "ölçülen 480 ms'den belirgin hızlı çekmek yazıcıyı boşuna yorar").toBeGreaterThanOrEqual(300);
    expect(ms, "çok seyrek çekmek görüntüyü takik yapar").toBeLessThanOrEqual(1000);
  });

  it("durdurulunca uyandırma da duruyor — kamera uykuya dönebilmeli", () => {
    // `durdur()` yalnız soketi kapatıp zamanlayıcıyı bırakırsa, pencere kapandıktan sonra da
    // yazıcıya istek gitmeye devam eder.
    expect(KAYNAK).toContain("clearInterval(uyandirmaZamanlayici)");
  });
});

describe("snapmakerKameraVar", () => {
  it("JPEG dönerse kamera VAR", async () => {
    const jpeg = Buffer.alloc(64, 0x41);
    jpeg[0] = 0xff; jpeg[1] = 0xd8;
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => jpeg.buffer.slice(jpeg.byteOffset, jpeg.byteOffset + jpeg.length),
    })));
    const { snapmakerKameraVar } = await import("./snapmaker-camera");
    expect(await snapmakerKameraVar("10.0.0.5", 7125)).toBe(true);
  });

  it("JPEG olmayan gövde kamera SAYILMAZ", async () => {
    const html = Buffer.from("<html>502</html>");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      headers: { get: () => "text/html" },
      arrayBuffer: async () => html.buffer.slice(html.byteOffset, html.byteOffset + html.length),
    })));
    const { snapmakerKameraVar } = await import("./snapmaker-camera");
    expect(await snapmakerKameraVar("10.0.0.5", 7125)).toBe(false);
  });

  it("ulaşılamayan yazıcıda hata FIRLATMAZ, sadece false döner", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("ECONNREFUSED"); }));
    const { snapmakerKameraVar } = await import("./snapmaker-camera");
    await expect(snapmakerKameraVar("10.0.0.5", 7125)).resolves.toBe(false);
  });
});
