import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SymbolView } from "expo-symbols";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ScreenHeader } from "@/components/form";
import {
  getCustomPrints,
  getPrinterSnapshots,
  getRecentCommands,
  sendPrintCommand,
  type CustomPrint,
} from "@/lib/db/printers";
import { getSettingsMap } from "@/lib/db/rules";
import { ML, radius } from "@/theme/colors";

function fmtSize(bytes: number): string {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
function fmtDur(min: number | null): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h > 0 ? `${h}sa ${m}dk` : `${m}dk`;
}
function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("tr-TR", { day: "2-digit", month: "short" });
  } catch {
    return "";
  }
}

export default function CustomPrintsScreen() {
  const qc = useQueryClient();
  // Arşiv nadiren değişir → sürekli poll yok; ekran her mount'ta zaten taze çeker.
  const { data: items = [], isLoading } = useQuery({
    queryKey: ["custom-prints"],
    queryFn: getCustomPrints,
  });
  const { data: snaps = [] } = useQuery({
    queryKey: ["printer-snapshots"],
    queryFn: getPrinterSnapshots,
    refetchInterval: 4000,
  });
  const snapById = useMemo(() => new Map(snaps.map((s) => [s.printerConfigId, s])), [snaps]);
  // relayCaps: masaüstü relay'in yetenek bildirimi (AppSetting). "r2start" yoksa relay BULUT (R2)
  // dosyayı indiremez (yalnız yerel disk okur) → bulut dosyada "Bas" hata üretirdi; kapıyla engelle.
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: getSettingsMap });
  const relayCaps = settings?.printRelayCaps ?? "";

  // Relay tazeliği — masaüstü ~10sn'de bir snapshot yazar; 90sn+ eskiyse komutlar uygulanmaz.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);
  const lastUpdate = useMemo(() => {
    let max = 0;
    for (const s of snaps) {
      const t = Date.parse(s.updatedAt);
      if (!Number.isNaN(t) && t > max) max = t;
    }
    return max;
  }, [snaps]);
  const relayStale = lastUpdate === 0 || now - lastUpdate > 90_000;

  // Gönderilen "tekrar bas" komutunun durumu (pending → done/error) — getRecentCommands ile izlenir.
  // 90 sn içinde uygulanmazsa (masaüstü kapalı) zaman aşımı mesajına düşer + yoklama durur.
  const [sent, setSent] = useState<{ id: string; name: string; at: number } | null>(null);
  const cmdTimedOut = !!sent && now - sent.at > 90_000;
  const { data: cmds = [] } = useQuery({
    queryKey: ["recent-commands"],
    queryFn: getRecentCommands,
    refetchInterval: sent && !cmdTimedOut ? 3000 : false,
    enabled: !!sent && !cmdTimedOut,
  });
  const sentCmd = sent ? cmds.find((c) => c.id === sent.id) : null;
  const cmdSettled = sentCmd?.status === "done" || sentCmd?.status === "error";
  useEffect(() => {
    if (cmdSettled || cmdTimedOut) {
      const t = setTimeout(() => setSent(null), cmdTimedOut ? 12_000 : 6000);
      return () => clearTimeout(t);
    }
  }, [cmdSettled, cmdTimedOut]);
  // Çift gönderim kilidi: bir komut beklerken yenisi gönderilmesin (iki "start" = ikinci deneme hatası).
  const cmdBusy = !!sent && !cmdSettled && !cmdTimedOut;

  const doReprint = (it: CustomPrint) => {
    Alert.alert(
      "Tekrar bas",
      `"${it.originalName}"\n${it.printerName ?? "yazıcı"} üzerinde baskı başlatılsın mı?`,
      [
        { text: "Vazgeç", style: "cancel" },
        {
          text: "Bas",
          onPress: async () => {
            try {
              const id = await sendPrintCommand(it.printerConfigId, "start", it.id);
              setSent({ id, name: it.originalName, at: Date.now() });
              qc.invalidateQueries({ queryKey: ["recent-commands"] });
            } catch {
              Alert.alert("Hata", "Komut gönderilemedi (bağlantı sorunu).");
            }
          },
        },
      ]
    );
  };

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <ScreenHeader title="Özel Baskılar" />

      {sent ? (
        <View
          style={[
            styles.banner,
            sentCmd?.status === "done" && { borderColor: ML.green + "66" },
            sentCmd?.status === "error" && { borderColor: ML.red + "66" },
          ]}
        >
          <Text
            style={[
              styles.bannerText,
              sentCmd?.status === "done" && { color: ML.green },
              (sentCmd?.status === "error" || cmdTimedOut) && { color: ML.red },
            ]}
          >
            {sentCmd?.status === "done"
              ? `✓ Baskı başladı: ${sent.name}`
              : sentCmd?.status === "error"
                ? `✕ ${sentCmd.error ?? "Başlatılamadı"}`
                : cmdTimedOut
                  ? "⚠ Uygulanmadı — masaüstü kapalı görünüyor. Komut masaüstü açılınca işlenir ya da zaman aşımına düşer."
                  : "⏳ Komut gönderildi — masaüstü uyguluyor…"}
          </Text>
        </View>
      ) : relayStale && items.length > 0 ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>
            Masaüstü çevrimdışı görünüyor — baskı komutları masaüstü açıkken uygulanır.
          </Text>
        </View>
      ) : null}

      {isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={ML.accent} />
        </View>
      ) : items.length === 0 ? (
        <View style={styles.center}>
          <SymbolView name="tray.fill" tintColor={ML.textFaint} style={{ width: 40, height: 40 }} />
          <Text style={styles.emptyTitle}>Henüz özel baskı yok</Text>
          <Text style={styles.emptyDesc}>
            Masaüstünden “Özel Baskı” ile yüklediğin (ürüne bağlı olmayan) gcode/3mf dosyaları burada
            listelenir — ait olduğu yazıcıyla tekrar basabilirsin.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.count}>{items.length} dosya</Text>
          {items.map((it) => {
            const snap = snapById.get(it.printerConfigId);
            const printerGone = !it.printerName || !it.printerEnabled;
            const isBambu = it.printerType === "bambu";
            const cloudUnsupported = !!it.isCloud && !relayCaps.includes("r2start");
            const online = !!snap?.online && !relayStale;
            const busy = snap?.status === "printing" || snap?.status === "paused";
            let reason = "";
            if (printerGone) reason = "Yazıcı yok";
            else if (isBambu) reason = "Bambu: masaüstünden";
            // Relay R2 indirmeyi bilmiyorsa bulut dosyada "Bas" kesin hata üretir → kapı.
            else if (cloudUnsupported) reason = "Masaüstünü güncelle";
            else if (relayStale) reason = "Masaüstü kapalı";
            else if (!online) reason = "Çevrimdışı";
            else if (busy) reason = "Meşgul";
            else if (cmdBusy) reason = "Komut sürüyor…";
            const canPrint = !reason;
            const meta = [
              fmtSize(it.sizeBytes),
              fmtDur(it.estPrintMin),
              it.gramaj ? `${Math.round(it.gramaj)}g` : "",
              fmtDate(it.createdAt),
            ].filter(Boolean);

            return (
              <View key={it.id} style={styles.row}>
                <View style={styles.fileIcon}>
                  <SymbolView name="doc.fill" tintColor={ML.textDim} style={{ width: 18, height: 18 }} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.name} numberOfLines={1}>
                    {it.originalName}
                  </Text>
                  <View style={styles.metaRow}>
                    <View style={[styles.pDot, { backgroundColor: it.printerAccent || "#9ca3af" }]} />
                    <Text style={styles.metaText} numberOfLines={1}>
                      {it.printerName ?? "yazıcı silinmiş"} · {meta.join(" · ")}
                    </Text>
                  </View>
                  <View style={styles.badgeRow}>
                    <View
                      style={[
                        styles.cloudBadge,
                        { backgroundColor: it.isCloud ? ML.accent + "1A" : ML.cardElevated },
                      ]}
                    >
                      <SymbolView
                        name={it.isCloud ? "cloud.fill" : "internaldrive.fill"}
                        tintColor={it.isCloud ? ML.accent : ML.textFaint}
                        style={{ width: 11, height: 11 }}
                      />
                      <Text style={[styles.cloudText, { color: it.isCloud ? ML.accent : ML.textFaint }]}>
                        {it.isCloud ? "Bulut" : "Yerel"}
                      </Text>
                    </View>
                  </View>
                </View>
                <Pressable
                  onPress={() => canPrint && doReprint(it)}
                  disabled={!canPrint}
                  style={({ pressed }) => [
                    styles.basBtn,
                    canPrint ? { borderColor: ML.accent + "77" } : styles.basBtnDisabled,
                    pressed && canPrint && { backgroundColor: ML.accent + "1A" },
                  ]}
                >
                  <SymbolView
                    name="printer.fill"
                    tintColor={canPrint ? ML.accent : ML.textFaint}
                    style={{ width: 14, height: 14 }}
                  />
                  <Text style={[styles.basText, { color: canPrint ? ML.accent : ML.textFaint }]}>
                    {canPrint ? "Bas" : reason}
                  </Text>
                </Pressable>
              </View>
            );
          })}
          <View style={{ height: 24 }} />
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: ML.bg },
  banner: {
    marginHorizontal: 16,
    marginBottom: 10,
    padding: 10,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: ML.border,
    backgroundColor: ML.card,
  },
  bannerText: { color: ML.textDim, fontSize: 12.5, fontWeight: "600" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, gap: 10 },
  emptyTitle: { color: ML.text, fontSize: 16, fontWeight: "700" },
  emptyDesc: { color: ML.textDim, fontSize: 13, textAlign: "center", lineHeight: 19 },
  list: { padding: 16, paddingTop: 4, gap: 10 },
  count: { color: ML.textFaint, fontSize: 12, fontWeight: "700", marginBottom: 2 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    backgroundColor: ML.card,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: ML.borderSoft,
    padding: 12,
  },
  fileIcon: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: ML.cardElevated,
    alignItems: "center",
    justifyContent: "center",
  },
  name: { color: ML.text, fontSize: 14, fontWeight: "700" },
  metaRow: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  pDot: { width: 7, height: 7, borderRadius: 4 },
  metaText: { color: ML.textFaint, fontSize: 11.5, flex: 1 },
  badgeRow: { flexDirection: "row", marginTop: 5 },
  cloudBadge: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 6,
  },
  cloudText: { fontSize: 10.5, fontWeight: "700" },
  basBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 5,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: 11,
    paddingVertical: 8,
    minWidth: 64,
    justifyContent: "center",
  },
  basBtnDisabled: { borderColor: ML.border, opacity: 0.7 },
  basText: { fontSize: 12.5, fontWeight: "700" },
});
