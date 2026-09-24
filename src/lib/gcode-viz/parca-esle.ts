/**
 * PARÇA EŞLEME — dosyadaki parça (3B) ↔ yazıcının parça listesi (iptal komutu buna gider).
 *
 * Önce KİMLİK: Bambu'da dosyadaki etiket numarası yazıcıya giden identify_id'nin kendisi
 * ("281" = "281", kullanıcının dosyasında doğrulandı). Klipper parça adlarını BÜYÜK harfe
 * çeviriyor (`PISTONE_1_1_ID_0_COPY_0`) → karşılaştırma büyük/küçük harf duyarsız.
 * Kimlik tutmazsa YER: iki listenin tabladaki orta noktaları en yakın çiftlerle eşlenir
 * (tolerans içinde). Eşlenemeyen parça 3B'de seçilemez ama listede kalır — yanlış parçayı
 * iptal ettirmektense seçtirmemek doğru.
 */

export interface PaketParcasi {
  anahtar: string;
  merkez: [number, number];
}

export interface YaziciParcasi {
  name: string;
  center: [number, number];
}

/** Paket parçası i → yazıcı parçası indeksi (eşlenemezse -1). Birebir: iki parça aynı yere gitmez. */
export function parcalariEsle(paket: PaketParcasi[], yazici: YaziciParcasi[], toleransMm = 25): number[] {
  const sonuc = new Array<number>(paket.length).fill(-1);
  const dolu = new Array<boolean>(yazici.length).fill(false);

  const adlar = new Map<string, number[]>();
  yazici.forEach((p, j) => {
    const k = p.name.toUpperCase();
    adlar.set(k, [...(adlar.get(k) ?? []), j]);
  });
  paket.forEach((p, i) => {
    const adaylar = adlar.get(p.anahtar.toUpperCase());
    // Aynı ad birden çok parçadaysa ad tek başına ayırt etmez → yere bırak.
    if (adaylar && adaylar.length === 1 && !dolu[adaylar[0]]) {
      sonuc[i] = adaylar[0];
      dolu[adaylar[0]] = true;
    }
  });

  const ciftler: Array<{ i: number; j: number; d: number }> = [];
  paket.forEach((p, i) => {
    if (sonuc[i] >= 0) return;
    yazici.forEach((q, j) => {
      if (dolu[j]) return;
      const d = Math.hypot(p.merkez[0] - q.center[0], p.merkez[1] - q.center[1]);
      if (d <= toleransMm) ciftler.push({ i, j, d });
    });
  });
  ciftler.sort((a, b) => a.d - b.d);
  for (const c of ciftler) {
    if (sonuc[c.i] >= 0 || dolu[c.j]) continue;
    sonuc[c.i] = c.j;
    dolu[c.j] = true;
  }
  return sonuc;
}
