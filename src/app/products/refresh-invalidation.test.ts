/**
 * FİYAT YENİLEMESİ EKRANI GERÇEKTEN TAZELİYOR MU — davranış testi.
 *
 * SAHADAKİ HATA: kullanıcı fiyatları yeniliyor, ürün detayını açıyor, ESKİ fiyatı görüyor.
 *
 * İLK DÜZELTME İŞE YARAMADI ve testi de yeşil geçiyordu: kaynak metninde
 * `invalidateQueries({ queryKey: ["product"] })` aramak yetmiyor, çünkü `QueryProvider`da
 * `refetchOnMount: false` global olarak açık. Geçersiz kılmak yalnız "bayat" bayrağı basar;
 * gözlemcisi olmayan bir sorgu sonraki mount'ta YENİDEN ÇEKİLMEZ, önbellekten servis edilir.
 *
 * Bu yüzden test artık metin değil DAVRANIŞ ölçüyor: gerçek bir QueryClient kurulup
 * "getir → ekrandan çık → yenile → tekrar aç" senaryosu koşuluyor ve sunucuya ikinci kez
 * gidilip gidilmediğine bakılıyor.
 */
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Uygulamanın gerçek varsayılanları (QueryProvider.tsx ile aynı olmalı). */
function istemciKur(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60_000,
        gcTime: 10 * 60_000,
        retry: false,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        refetchOnReconnect: false,
      },
    },
  });
}

/** Bir sorguyu ekrana getir, veriyi bekle, sonra ekrandan çık. */
async function acKapa(qc: QueryClient, anahtar: unknown[], queryFn: () => Promise<unknown>) {
  const gozlemci = new QueryObserver(qc, { queryKey: anahtar, queryFn });
  // Önbellekte veri VARSA `subscribe` hiç tetiklenmez (yalnız DEĞİŞİMDE ateşlenir) —
  // mevcut durumu önce oku, yoksa test sonsuza kadar bekler.
  const birak = gozlemci.subscribe(() => {});
  if (gozlemci.getCurrentResult().status !== "success") {
    await new Promise<void>((coz) => {
      const dur = gozlemci.subscribe((s) => {
        if (s.status === "success") { dur(); coz(); }
      });
    });
  }
  birak();
}

describe("yenileme sonrası detay gerçekten tazeleniyor", () => {
  it("removeQueries KULLANILDIĞINDA sunucuya yeniden gidiliyor", async () => {
    const qc = istemciKur();
    let cagri = 0;
    const fn = async () => { cagri++; return { fiyat: cagri * 100 }; };

    await acKapa(qc, ["product", "p1"], fn);
    expect(cagri).toBe(1);

    // Fiyat yenilemesi: uygulamanın yaptığı şey.
    qc.removeQueries({ queryKey: ["product"] });

    await acKapa(qc, ["product", "p1"], fn);
    expect(cagri, "detay yeniden çekilmeli").toBe(2);
  });

  it("invalidateQueries TEK BAŞINA YETMİYOR — bu yüzden kullanılmıyor", async () => {
    /**
     * Bu test hatayı belgeler: `refetchOnMount:false` altında geçersiz kılmak, gözlemcisi
     * olmayan sorguyu yeniden çektirmez. Biri düzeltmeyi `invalidateQueries`e geri çevirirse
     * bu beklenti kırılır ve nedeni burada yazılı olur.
     */
    const qc = istemciKur();
    let cagri = 0;
    const fn = async () => { cagri++; return { fiyat: cagri * 100 }; };

    await acKapa(qc, ["product", "p2"], fn);
    qc.invalidateQueries({ queryKey: ["product"] });
    await acKapa(qc, ["product", "p2"], fn);

    expect(cagri, "invalidate ile yeniden çekilmiyor (hatanın kökü)").toBe(1);
  });

  it("önek eşleşmesi başka anahtarları düşürmüyor", async () => {
    // ["product"] öneki ["products"] veya ["product-models"] ile EŞLEŞMEMELİ,
    // yoksa yenileme gereksiz yere ağır listeleri de attırır.
    const qc = istemciKur();
    await acKapa(qc, ["products"], async () => []);
    await acKapa(qc, ["product-models", "p1"], async () => []);

    qc.removeQueries({ queryKey: ["product"] });

    expect(qc.getQueryData(["products"])).toBeDefined();
    expect(qc.getQueryData(["product-models", "p1"])).toBeDefined();
  });
});

describe("yenileme bloğu doğru anahtarları düşürüyor", () => {
  const LISTE = readFileSync(join(process.cwd(), "src/app/products/page.tsx"), "utf8");
  const blok = (() => {
    const bas = LISTE.indexOf('setRefreshProgress({ total, done, label: "Liste & panel güncelleniyor…" })');
    expect(bas).toBeGreaterThan(0);
    return LISTE.slice(bas, bas + 1800);
  })();

  it("detay ve fiyat geçmişi SİLİNİYOR (bayat bırakılmıyor)", () => {
    expect(blok).toContain('removeQueries({ queryKey: ["product"] })');
    expect(blok).toContain('removeQueries({ queryKey: ["price-history"] })');
  });

  it("liste ve panel tazeleniyor", () => {
    expect(blok).toContain('queryKey: ["products"]');
    expect(blok).toContain('queryKey: ["dashboard"]');
    expect(blok).toContain('queryKey: ["orders"]');
  });

  it("ÖLÜ anahtar eklenmiyor", () => {
    /**
     * `profit-preview` ve `price-lab` anahtarlarını okuyan hiçbir `useQuery` yok (ölçüldü);
     * yenileme listesine konmaları hiçbir şey yapmaz, yalnız yanlış güven verir.
     */
    expect(blok).not.toContain('"profit-preview"');
    expect(blok).not.toContain('"price-lab"');
  });
});
