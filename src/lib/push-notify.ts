import { prisma } from "./prisma";

const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";

/**
 * Kayıtlı tüm Expo push token'larına bildirim gönder (baskı bitti vb.). Telefon KAPALIYKEN de düşer.
 * Mobil uygulama token'ı PushToken tablosuna yazar; bu masaüstü relay'inden çağrılır. Tamamen
 * defensive: hata/ağ yoksa sessiz geçer (relay'i asla bozmaz). Geçersiz token'ları (DeviceNotRegistered)
 * temizler.
 */
export async function pushToAllDevices(title: string, body: string): Promise<void> {
  let tokens: string[] = [];
  try {
    const rows = await prisma.pushToken.findMany({ select: { token: true } });
    tokens = rows.map((r) => r.token).filter((t) => typeof t === "string" && t.startsWith("ExponentPushToken"));
  } catch {
    return; // tablo yok / okuma hatası
  }
  if (tokens.length === 0) return;

  const messages = tokens.map((to) => ({
    to,
    title,
    body,
    sound: "default" as const,
    priority: "high" as const,
    channelId: "default",
  }));

  try {
    const res = await fetch(EXPO_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(messages),
    });
    const data = (await res.json().catch(() => null)) as
      | { data?: Array<{ status: string; details?: { error?: string } }> }
      | null;
    if (data?.data) {
      const dead: string[] = [];
      data.data.forEach((r, i) => {
        if (r.status === "error" && r.details?.error === "DeviceNotRegistered") dead.push(tokens[i]);
      });
      if (dead.length) await prisma.pushToken.deleteMany({ where: { token: { in: dead } } }).catch(() => {});
    }
  } catch {
    /* ağ hatası → sessiz */
  }
}
