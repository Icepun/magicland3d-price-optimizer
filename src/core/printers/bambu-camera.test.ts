/**
 * BAMBU KAMERA ÇÖZÜMLEYİCİSİ.
 *
 * Bambu'nun kamerası HTTP değil: 6000 portunda TLS, 80 baytlık kimlik paketi, sonra
 * [16 baytlık başlık][JPEG] biçiminde kareler. (Ölçüldü 21 Ağu 2026: A1 Combo'da 6000 açık.)
 *
 * Ağ olmadan test edilebilen kısım TAM OLARAK burası — ve hataların çıkacağı yer de burası:
 * TCP akışı kare sınırlarına saygı duymaz. Bir kare iki pakete bölünebilir, bir pakette iki
 * kare gelebilir, ya da bir paket bir buçuk kare taşıyabilir. Ayrıştırıcı bunların üçünü de
 * doğru yapmazsa görüntü ya hiç gelmez ya bozuk çizilir.
 */
import { describe, expect, it } from "vitest";
import { kimlikPaketi, kareleriAyikla, jpegMi } from "./bambu-camera";

/** Geçerli görünen küçük bir JPEG (imza + son işaretçi). */
function sahteJpeg(boy = 64): Buffer {
  const b = Buffer.alloc(boy, 0x41);
  b[0] = 0xff; b[1] = 0xd8;
  b[boy - 2] = 0xff; b[boy - 1] = 0xd9;
  return b;
}

function kare(jpeg: Buffer): Buffer {
  const bas = Buffer.alloc(16, 0);
  bas.writeUInt32LE(jpeg.length, 0);
  return Buffer.concat([bas, jpeg]);
}

describe("kimlik paketi", () => {
  it("80 bayt ve alanlar doğru yerde", () => {
    const p = kimlikPaketi("12345678");
    expect(p.length).toBe(80);
    expect(p.readUInt32LE(0)).toBe(0x40);
    expect(p.subarray(16, 20).toString("ascii")).toBe("bblp");
    expect(p.subarray(48, 56).toString("ascii")).toBe("12345678");
  });

  it("kısa kod kalanı SIFIRLA doldurur (çöp bayt gitmez)", () => {
    const p = kimlikPaketi("abc");
    expect(p.subarray(51, 80).every((x) => x === 0)).toBe(true);
  });
});

describe("kare ayıklama", () => {
  it("tek pakette tek kare", () => {
    const j = sahteJpeg();
    const { kareler, kalan } = kareleriAyikla(kare(j));
    expect(kareler.length).toBe(1);
    expect(kareler[0].equals(j)).toBe(true);
    expect(kalan.length).toBe(0);
  });

  it("tek pakette İKİ kare", () => {
    const a = sahteJpeg(32), b = sahteJpeg(48);
    const { kareler, kalan } = kareleriAyikla(Buffer.concat([kare(a), kare(b)]));
    expect(kareler.map((k) => k.length)).toEqual([32, 48]);
    expect(kalan.length).toBe(0);
  });

  it("YARIM kare: artık saklanır, sonraki parçayla tamamlanır", () => {
    const j = sahteJpeg(100);
    const tam = kare(j);
    const ilk = tam.subarray(0, 40); // başlık + gövdenin bir kısmı
    const r1 = kareleriAyikla(Buffer.from(ilk));
    expect(r1.kareler.length, "yarım kare yayınlanmamalı").toBe(0);
    expect(r1.kalan.length).toBe(40);

    const r2 = kareleriAyikla(Buffer.concat([r1.kalan, tam.subarray(40)]));
    expect(r2.kareler.length).toBe(1);
    expect(r2.kareler[0].equals(j)).toBe(true);
  });

  it("başlığın kendisi bölünürse de bozulmaz", () => {
    const tam = kare(sahteJpeg(24));
    const r1 = kareleriAyikla(tam.subarray(0, 7)); // başlık yarım
    expect(r1.kareler.length).toBe(0);
    const r2 = kareleriAyikla(Buffer.concat([r1.kalan, tam.subarray(7)]));
    expect(r2.kareler.length).toBe(1);
  });

  it("saçma uzunluk belleği doldurmaz", () => {
    // Bozuk/kaymış başlık okursak 4 GB'lık bir kare beklemeye başlamamalıyız.
    const kotu = Buffer.alloc(20, 0);
    kotu.writeUInt32LE(0xfffffff0, 0);
    const { kareler, kalan } = kareleriAyikla(kotu);
    expect(kareler.length).toBe(0);
    expect(kalan.length, "tampon atılmalı").toBe(0);
  });

  it("sıfır uzunluk sonsuz döngü yapmaz", () => {
    const sifir = Buffer.alloc(32, 0); // boy alanı 0
    const { kareler, kalan } = kareleriAyikla(sifir);
    expect(kareler.length).toBe(0);
    expect(kalan.length).toBe(0);
  });
});

describe("JPEG doğrulaması", () => {
  it("imzası tutmayan veri yayınlanmaz", () => {
    expect(jpegMi(sahteJpeg())).toBe(true);
    expect(jpegMi(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe(false);
    expect(jpegMi(Buffer.alloc(0))).toBe(false);
  });
});
