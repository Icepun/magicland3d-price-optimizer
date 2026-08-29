/**
 * TIMELAPSE ADI ÇÖZÜMLEME.
 *
 * Galeride ham dosya adı gösteriliyordu ve kullanıcı "hiçbir şey görünmüyor" dedi. Adın
 * içinde baskı adı, süre ve tarih var; bunları ayırıyoruz.
 *
 * Örnekler U1'den CANLI okundu (28 Ağu 2026, 21 video).
 *
 * ⚠️ Biçim garanti değil: Bambu'nun .avi adları farklı, firmware de değiştirebilir.
 * Bu yüzden en önemli test, TANIMADIĞIMIZ adın kartı boş bırakmaması.
 */
import { describe, expect, it } from "vitest";
import { timelapseAdiCozumle, timelapseKapakSec } from "./timelapse-name";

describe("gerçek U1 adları", () => {
  it("baskı adı, süre ve gürültü ayrılıyor", () => {
    const r = timelapseAdiCozumle("Thousand Sunny P9 1s41dk-1f89ccc266_20260828175043.mp4");
    expect(r.ad).toBe("Thousand Sunny P9");
    expect(r.sure).toBe("1 sa 41 dk");
  });

  it("tek haneli dakika", () => {
    expect(timelapseAdiCozumle("Thousand Sunny P14 1s9dk-17776d21f7_20260828164119.mp4"))
      .toEqual({ ad: "Thousand Sunny P14", sure: "1 sa 9 dk" });
  });

  it("uzun baskı", () => {
    expect(timelapseAdiCozumle("Thousand Sunny P10 3s7dk-0dc6332190_20260828133959.mp4").sure)
      .toBe("3 sa 7 dk");
  });
});

describe("süre biçimleri", () => {
  it("yalnız dakika", () => {
    expect(timelapseAdiCozumle("Parça 45dk-abcdef12_20260828120000.mp4").sure).toBe("45 dk");
  });

  it("yalnız saat", () => {
    expect(timelapseAdiCozumle("Parça 2s-abcdef12_20260828120000.mp4").sure).toBe("2 sa");
  });

  it("süre yoksa null — uydurma yapılmaz", () => {
    const r = timelapseAdiCozumle("Kapak-abcdef12_20260828120000.mp4");
    expect(r.sure).toBeNull();
    expect(r.ad).toBe("Kapak");
  });
});

describe("tanınmayan adlar KARTI BOŞ BIRAKMAZ", () => {
  it("Bambu tarzı .avi adı olduğu gibi gösterilir", () => {
    const r = timelapseAdiCozumle("video_20260828_120000.avi");
    expect(r.ad.length).toBeGreaterThan(0);
    expect(r.sure).toBeNull();
  });

  it("sade ad", () => {
    expect(timelapseAdiCozumle("deneme.mp4")).toEqual({ ad: "deneme", sure: null });
  });

  it("yalnız zaman damgasından ibaret ad boş başlık üretmez", () => {
    // Ad tamamen erirse başlıksız bir kart kalırdı — ham ada geri dönülmeli.
    const r = timelapseAdiCozumle("_20260828175043.mp4");
    expect(r.ad.trim().length).toBeGreaterThan(0);
  });

  it("uzantısız ad patlamaz", () => {
    expect(timelapseAdiCozumle("Parça 1s5dk").ad).toBe("Parça");
  });
});

describe("kapak seçimi", () => {
  /**
   * ÖLÇÜLDÜ (29 Ağu 2026, U1): her video için iki jpg yazılıyor — 120x90 (3 KB) ve
   * 880x495 (35 KB, tam 16:9). Küçük olan seçilince kart bulanık ve kırpık görünüyordu.
   */
  it("_cover varsa O seçilir", () => {
    const mevcut = new Set(["Parça_20260828", "Parça_20260828_cover"]);
    expect(timelapseKapakSec("Parça_20260828", mevcut)).toBe("Parça_20260828_cover.jpg");
  });

  it("_cover yoksa küçük kapağa düşülür", () => {
    expect(timelapseKapakSec("Parça", new Set(["Parça"]))).toBe("Parça.jpg");
  });

  it("hiç kapak yoksa null — kartta yer tutucu çizilir", () => {
    expect(timelapseKapakSec("Parça", new Set())).toBeNull();
  });

  it("başka videonun kapağı yanlışlıkla seçilmez", () => {
    expect(timelapseKapakSec("Parça_A", new Set(["Parça_B", "Parça_B_cover"]))).toBeNull();
  });
});
