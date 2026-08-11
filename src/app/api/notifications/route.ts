import { NextResponse } from "next/server";
import { prisma, remotePrisma } from "@/lib/prisma";
import { ensureRuntimeSchema } from "@/lib/runtime-schema";
import { swr } from "@/lib/route-cache";
import { buildFilamentAlerts, groupSpools } from "@/core/filament-groups";
import { loadFilamentSettings } from "@/lib/filament-settings";

/**
 * Bildirim ucu — zil bunu SIK yoklar (~20 sn), bu yüzden turu ucuz tutulur:
 *
 *   - Kalıcı bildirim satırları ve yazıcı durumu HER istekte taze okunur (olay anı budur).
 *   - Düşük stok / sitede tükenen / azalan filament taraması KISA ÖMÜRLÜ önbellekten gelir:
 *     bu değerler dakikalar içinde değişir, her yoklamada dört tabloyu taramak gereksizdi.
 *
 * Eşiği ilk geçen stok/filament durumları ayrıca kalıcı satıra yazılır (lib/order-watch) →
 * telefona da düşer. O satırlar buradaki anlık uyarılarla AYNI kimliği taşır, aşağıda tek
 * kayda indirgenir (zilde çift görünmez).
 */
export type AlertSeverity = "critical" | "warning" | "success";

export interface AppAlert {
  id: string;
  type: "stock" | "filament" | "printer" | "order";
  severity: AlertSeverity;
  title: string;
  body: string;
  href: string;
  /** Kalıcı bildirimlerde oluşturulma zamanı (ISO) — istemci ESKİ birikmişleri OS bildirimi
      olarak PATLATMASIN diye yaş sınırında kullanılır (anlık stok/filament uyarılarında yok). */
  createdAt?: string;
}

/** Stok/filament taraması bu kadar süre önbellekte kalır (zil 20 sn'de bir yokluyor). */
const INVENTORY_TTL_MS = 90_000;
const INVENTORY_CACHE_KEY = "notifications-inventory:v1";

/** Kalıcı satırın tipi → zildeki simge grubu. */
function alertTypeOf(type: string | null | undefined): AppAlert["type"] {
  const t = type ?? "";
  if (t.startsWith("printer")) return "printer";
  if (t === "spool" || t === "filament") return "filament";
  if (t === "stock" || t === "site-stock") return "stock";
  return "order";
}

/** Düşük stok / sitede tükenen / azalan filament — ucuz ama her yoklamada gereksiz olan tarama. */
async function inventoryAlerts(): Promise<AppAlert[]> {
  const alerts: AppAlert[] = [];

  const lowStock = await prisma.product.findMany({
    // Sipariş üzerine üretilende stok 0 normaldir — uyarı üretmez (Panel ile aynı kural).
    where: { isActive: true, hidden: false, madeToOrder: false, stock: { lte: 1 } },
    select: { id: true, name: true, stock: true },
    take: 50,
  });
  // Mağaza sayfası satışa kapanmış ürünler. İlan stokları normalde yüksek tutulduğu için
  // 0'a düşmesi "farkında olmadan tükendi" demektir — uygulamadaki gerçek stoktan bağımsız
  // olarak haber verilir. Sipariş üzerine üretilenler hariç (onlarda stok tutulmuyor).
  const siteOutOfStock = await prisma.listing
    .findMany({
      where: {
        platform: "shopify",
        isActive: true,
        stock: { lte: 0 },
        product: { isActive: true, hidden: false, madeToOrder: false },
      },
      select: { id: true, product: { select: { id: true, name: true } } },
      take: 50,
    })
    .catch(() => []);

  for (const p of lowStock) {
    const empty = p.stock <= 0;
    alerts.push({
      id: `stock-${p.id}`,
      type: "stock",
      severity: empty ? "critical" : "warning",
      title: empty ? "Stok bitti" : "Stok kritik",
      body: `${p.name} — ${p.stock} adet`,
      href: `/products/${p.id}`,
    });
  }

  for (const l of siteOutOfStock) {
    if (!l.product) continue;
    alerts.push({
      id: `site-stock-${l.product.id}`,
      type: "stock",
      severity: "warning",
      title: "Sitede stok bitti",
      body: `${l.product.name} — mağaza sayfası satışa kapandı`,
      href: `/products/${l.product.id}`,
    });
  }

  // FİLAMENT — v37: gram eşiği DEĞİL, grup (tür ailesi + renk tonu) başına KAPALI MAKARA SAYISI.
  //
  // Makara sorgusu da bu try/catch'in İÇİNDE: bu blok patlarsa stok + yazıcı + sipariş uyarıları
  // da sessizce yok olurdu (dış catch her şeyi yutuyor) — üstelik sonuç 90 sn önbelleğe girdiği
  // için kayıp sonraki yoklamalara da taşınırdı; kullanıcı bildirimlerinin gittiğini fark etmezdi.
  try {
    const spools = await prisma.filamentSpool.findMany({
      where: { isActive: true },
      select: {
        id: true, name: true, material: true, brand: true,
        colorName: true, colorHex: true, colorKey: true,
        totalGrams: true, remainingGrams: true, openedAt: true,
      },
    });
    const filamentSettings = await loadFilamentSettings();
    alerts.push(...buildFilamentAlerts(groupSpools(spools), filamentSettings));
  } catch (filamentError) {
    console.error("[notifications] filament uyarıları üretilemedi:", filamentError);
  }

  return alerts;
}

/** Yazıcı canlı durumu (relay yazar): hata = baskı durdu → acil; duraklatıldı = uyarı. */
async function printerAlerts(): Promise<AppAlert[]> {
  const printers = await remotePrisma.printerSnapshot
    .findMany({
      select: {
        printerConfigId: true,
        name: true,
        status: true,
        statusMessage: true,
        online: true,
        productName: true,
      },
    })
    .catch(() => []);
  const alerts: AppAlert[] = [];
  for (const pr of printers) {
    const job = pr.productName ? ` — ${pr.productName}` : "";
    const reason = pr.statusMessage ? ` · ${pr.statusMessage}` : "";
    if (pr.status === "error") {
      alerts.push({
        id: `printer-${pr.printerConfigId}-error`,
        type: "printer",
        severity: "critical",
        title: "Baskı hatayla durdu",
        body: `${pr.name}${job}${reason}`,
        href: "/printers",
      });
    } else if (pr.status === "paused" && pr.online) {
      alerts.push({
        id: `printer-${pr.printerConfigId}-paused`,
        type: "printer",
        severity: "warning",
        title: "Baskı duraklatıldı",
        body: `${pr.name}${job}${reason}`,
        href: "/printers",
      });
    }
  }
  return alerts;
}

/** Kalıcı olay-anı bildirimleri (sipariş, baskı, eşiği geçen stok/filament) — okunmamışlar. */
async function storedAlerts(): Promise<AppAlert[]> {
  const stored = await remotePrisma.notification
    .findMany({ where: { acknowledgedAt: null }, orderBy: { createdAt: "desc" }, take: 100 })
    .catch(() => []);
  return stored.map((n) => ({
    id: n.id,
    type: alertTypeOf(n.type),
    severity: (n.severity === "critical"
      ? "critical"
      : n.severity === "success"
        ? "success"
        : "warning") as AlertSeverity,
    title: n.title,
    body: n.body,
    href: n.href,
    createdAt: n.createdAt instanceof Date ? n.createdAt.toISOString() : String(n.createdAt ?? ""),
  }));
}

function withCounts(alerts: AppAlert[]) {
  // Sıralama: kritik (kırmızı) → uyarı (sarı) → başarı (yeşil)
  const rank = (s: AlertSeverity) => (s === "critical" ? 0 : s === "warning" ? 1 : 2);
  const sorted = [...alerts].sort((a, b) => rank(a.severity) - rank(b.severity));
  const critical = sorted.filter((a) => a.severity === "critical").length;
  const warning = sorted.filter((a) => a.severity === "warning").length;
  const success = sorted.filter((a) => a.severity === "success").length;
  return {
    alerts: sorted,
    counts: { total: sorted.length, critical, warning, success },
  };
}

export async function GET(req: Request) {
  // scope=events: yalnız kalıcı OLAY satırları (tek sorgu). Masaüstü uygulamasının arka planı
  // işletim sistemi bildirimini bundan üretir — pencere kapalıyken bile çalışır.
  const eventsOnly = new URL(req.url).searchParams.get("scope") === "events";

  try {
    await ensureRuntimeSchema();

    if (eventsOnly) {
      return NextResponse.json(withCounts(await storedAlerts()));
    }

    const live = [
      ...(await swr(INVENTORY_CACHE_KEY, INVENTORY_TTL_MS, inventoryAlerts)),
      ...(await printerAlerts()),
    ];
    const stored = await storedAlerts();

    // Aynı kimlik hem anlık hem kalıcı gelebilir (stok/filament eşikleri). Anlık metin daha
    // günceldir; kalıcı satırdan yalnız oluşturulma zamanı taşınır (yaş sınırı için gerekli).
    const byId = new Map<string, AppAlert>();
    for (const a of live) byId.set(a.id, a);
    for (const s of stored) {
      const existing = byId.get(s.id);
      byId.set(s.id, existing ? { ...existing, createdAt: s.createdAt } : s);
    }
    return NextResponse.json(withCounts([...byId.values()]));
  } catch {
    /* tablo yoksa boş dön */
    return NextResponse.json(withCounts([]));
  }
}

/**
 * Bildirim(ler)i "okundu" işaretle — KALICI (sipariş) bildirimleri için cihazlar-arası.
 * Anlık hesaplanan (stok/filament/yazıcı) id'ler hiçbir satırla eşleşmez → zararsız no-op
 * (onlar istemcide localStorage ile gizlenir).
 */
export async function POST(req: Request) {
  try {
    const body = (await req.json()) as { ids?: unknown };
    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === "string") : [];
    if (ids.length > 0) {
      await ensureRuntimeSchema();
      await remotePrisma.notification.updateMany({
        where: { id: { in: ids } },
        data: { acknowledgedAt: new Date() },
      });
    }
  } catch {
    /* ignore */
  }
  return NextResponse.json({ ok: true });
}
