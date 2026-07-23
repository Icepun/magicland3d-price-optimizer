/**
 * TEX kargo kurallarını (Trendyol baremi 15 Nisan 2026) DB'ye yükler.
 *
 * KULLANIM:
 *   1) Önce uygulamayı dev modda çalıştır:
 *        npm run electron:dev          (veya sadece: npm run dev)
 *      ve http://localhost:3000 ayağa kalkana kadar bekle.
 *
 *   2) Başka bir terminalde:
 *        node scripts/seed-tex-cargo-rules.mjs
 *
 * Script önce mevcut tüm TEX kurallarını siler, sonra yenilerini ekler.
 * Diğer kargo firmalarına ait kurallar dokunulmaz.
 *
 * NOT: Hem "Avantajlı" (1 günlük termin) hem "Standart" (2+ gün termin)
 * baremi sisteme eklenir. Avantajlı barem isActive=false olarak kaydedilir;
 * 1 günlük termine geçtiğinde Kargo Kuralları sayfasından aktif et,
 * Standart barem'i pasife al.
 *
 * Farklı bir API URL'i için:
 *   set API_URL=http://localhost:3001 && node scripts/seed-tex-cargo-rules.mjs
 */

const API_URL = process.env.API_URL || "http://localhost:3000";

// ────────────────────────────────────────────────────────────────────────────
// TEX Kargo Kuralları (15 Nisan 2026 fiyat listesi — KDV hariç)
// ────────────────────────────────────────────────────────────────────────────

/** Barem altı kuralları (0–349.99 TL siparişler için) */
const baremRules = [
  // ── AVANTAJLI BAREM (1 günlük termin + Hızlı Teslimat etiketi + başarılı teslimat)
  {
    name: "TEX • Avantajlı Barem • 0-200 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 0,
    maxPrice: 199.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 34.16,
    vatIncluded: false,
    priority: 30,
    isActive: false, // 2 günlük terminde değil → pasif
  },
  {
    name: "TEX • Avantajlı Barem • 200-350 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 200,
    maxPrice: 349.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 65.83,
    vatIncluded: false,
    priority: 30,
    isActive: false,
  },
  // ── STANDART BAREM (1 günden fazla termin / etiket yok / başarısız teslimat)
  {
    name: "TEX • Standart Barem • 0-200 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 0,
    maxPrice: 199.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 64.58,
    vatIncluded: false,
    priority: 20,
    isActive: true, // şu an 2 günlük terminde → aktif
  },
  {
    name: "TEX • Standart Barem • 200-350 TL",
    platform: "trendyol",
    cargoProvider: "TEX",
    minPrice: 200,
    maxPrice: 349.99,
    minDesi: 0,
    maxDesi: 999,
    cargoCost: 72.91,
    vatIncluded: false,
    priority: 20,
    isActive: true,
  },
];

/**
 * 350+ TL siparişler için desi bazlı TEX fiyatları.
 * Trendyol desi'yi yukarı yuvarlar (örn. 2.3 → 3 desi).
 * Aralıklar: minDesi (dahil) → maxDesi (dahil).
 */
const desiPriceMap = [
  { fromDesi: 0,    toDesi: 2,   cost: 77.54  },
  { fromDesi: 2.01, toDesi: 3,   cost: 93.63  },
  { fromDesi: 3.01, toDesi: 4,   cost: 101.46 },
  { fromDesi: 4.01, toDesi: 5,   cost: 107.98 },
  { fromDesi: 5.01, toDesi: 6,   cost: 118.30 },
  { fromDesi: 6.01, toDesi: 7,   cost: 125.66 },
  { fromDesi: 7.01, toDesi: 8,   cost: 134.21 },
  { fromDesi: 8.01, toDesi: 9,   cost: 142.42 },
  { fromDesi: 9.01, toDesi: 10,  cost: 153.47 },
  { fromDesi: 10.01, toDesi: 11, cost: 162.13 },
  { fromDesi: 11.01, toDesi: 12, cost: 170.33 },
  { fromDesi: 12.01, toDesi: 13, cost: 178.04 },
  { fromDesi: 13.01, toDesi: 14, cost: 185.17 },
  { fromDesi: 14.01, toDesi: 15, cost: 192.81 },
  { fromDesi: 15.01, toDesi: 20, cost: 236.21 }, // 16-20 desi grubu (en yüksek olan 20 desi)
  { fromDesi: 20.01, toDesi: 30, cost: 328.88 }, // 21-30 desi grubu (en yüksek olan 30 desi)
];

const desiRules = desiPriceMap.map(({ fromDesi, toDesi, cost }) => ({
  name: `TEX • 350+ TL • ${Math.ceil(fromDesi)}-${toDesi} desi`,
  platform: "trendyol",
  cargoProvider: "TEX",
  minPrice: 350,
  maxPrice: 999999,
  minDesi: fromDesi,
  maxDesi: toDesi,
  cargoCost: cost,
  vatIncluded: false,
  priority: 10,
  isActive: true,
}));

const allRules = [...baremRules, ...desiRules];

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

async function api(path, init = {}) {
  const url = `${API_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `${init.method || "GET"} ${url} → ${res.status} ${res.statusText}\n  Body sent: ${
        init.body ?? "(none)"
      }\n  Response: ${body}`
    );
  }
  return res.json().catch(() => ({}));
}

// ────────────────────────────────────────────────────────────────────────────
// Çalıştır
// ────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`API: ${API_URL}\n`);

  // 1. Mevcut tüm kuralları al, TEX olanları sil
  const existing = await api("/api/cargo-rules");
  const texRules = existing.filter(
    (r) => r.cargoProvider === "TEX" || (r.name && r.name.toUpperCase().includes("TEX"))
  );
  for (const rule of texRules) {
    await api(`/api/cargo-rules/${rule.id}`, { method: "DELETE" });
  }
  console.log(`✓ ${texRules.length} mevcut TEX kuralı silindi`);

  // 2. Yenilerini ekle
  let added = 0;
  for (const rule of allRules) {
    await api("/api/cargo-rules", {
      method: "POST",
      body: JSON.stringify(rule),
    });
    added += 1;
  }
  console.log(`✓ ${added} yeni TEX kuralı eklendi`);

  // 3. Özet
  const updated = await api("/api/cargo-rules");
  const tex = updated
    .filter((r) => r.cargoProvider === "TEX")
    .sort((a, b) => b.priority - a.priority || a.minPrice - b.minPrice || a.minDesi - b.minDesi);

  console.log("\n📦 Sistemdeki TEX kuralları:");
  for (const r of tex) {
    const active = r.isActive ? "✅" : "⏸️ ";
    const price = `${r.minPrice}-${r.maxPrice === 999999 ? "∞" : r.maxPrice}TL`;
    const desi = `${r.minDesi}-${r.maxDesi === 999 ? "∞" : r.maxDesi}desi`;
    console.log(
      `   ${active} ${r.name.padEnd(40)} → ${r.cargoCost.toFixed(2)} TL  [${price}, ${desi}]`
    );
  }

  console.log(
    "\n💡 İpucu: 1 günlük termine geçince 'Kargo Kuralları' sayfasından" +
      "\n   Avantajlı Barem kurallarını aktif et, Standart Barem'i pasife al."
  );
}

main().catch((err) => {
  console.error("\n❌ HATA:", err.message);
  console.error(
    "\nKontrol et: Uygulama dev modda çalışıyor mu? (npm run dev veya npm run electron:dev)"
  );
  process.exit(1);
});
