"use client";

/**
 * Kök hata sınırı — layout dahil HER ŞEY çökerse devreye girer.
 * Boş ekran yerine kullanıcıya anlaşılır bir hata + "Yeniden dene" gösterir,
 * uygulama kullanılabilir kalır. (Stabilite için kritik.)
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="tr">
      <body
        style={{
          margin: 0,
          height: "100vh",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#16181F",
          color: "#fff",
          fontFamily: "-apple-system, BlinkMacSystemFont, system-ui, sans-serif",
        }}
      >
        <div style={{ maxWidth: 460, padding: 32, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h1 style={{ fontSize: 20, fontWeight: 700, margin: "0 0 8px" }}>Bir şeyler ters gitti</h1>
          <p style={{ color: "#9AA0B4", fontSize: 14, margin: "0 0 16px", lineHeight: 1.5 }}>
            Uygulama beklenmedik bir hatayla karşılaştı. Yeniden dene; sorun sürerse aşağıdaki
            mesajı ilet.
          </p>
          <pre
            style={{
              background: "#222637",
              border: "1px solid #313752",
              borderRadius: 10,
              padding: 12,
              fontSize: 12,
              color: "#F87171",
              textAlign: "left",
              overflow: "auto",
              maxHeight: 180,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error?.message || "Bilinmeyen hata"}
            {error?.digest ? `\n(digest: ${error.digest})` : ""}
          </pre>
          <button
            onClick={() => reset()}
            style={{
              marginTop: 16,
              background: "#7C5CFF",
              color: "#fff",
              border: "none",
              borderRadius: 10,
              padding: "10px 24px",
              fontSize: 15,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Yeniden dene
          </button>
        </div>
      </body>
    </html>
  );
}
