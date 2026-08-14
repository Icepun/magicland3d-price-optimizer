import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { SplashScreen } from "@/components/layout/SplashScreen";
import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { CommandPalette } from "@/components/ui/command-palette";

/**
 * Yazı tipleri REPODAN gelir, derleme anında Google'dan indirilmez.
 *
 * NEDEN: `next/font/google` yazı tipini derleme sırasında ağdan çeker. macOS derleme
 * koşucusu fonts.gstatic.com'a ulaşamayınca (14 Ağu 2026, v0.19.185) webpack "Failed to
 * fetch font file" ile düştü — aynı commit Windows'ta sorunsuz derlendi. Yani sürüm
 * yayınlamak GitHub'ın ağına bağlıydı; kod değişmeden bir dahaki sefere yine düşebilirdi.
 *
 * İki dosya da DEĞİŞKEN (variable) yazı tipi: tek dosya tüm ağırlıkları taşır
 * (Jakarta 200–800, Mono 100–900) ve Türkçe karakterler doğrulandı.
 */
const plusJakartaSans = localFont({
  src: "./fonts/PlusJakartaSans.ttf",
  variable: "--font-sans",
  weight: "200 800",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMono.ttf",
  variable: "--font-geist-mono",
  weight: "100 900",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Magicland 3D Hub",
  description: "Magicland 3D çok platformlu fiyat ve kâr yönetim aracı",
};

// Tarayıcı/pencere kromu da koyu olsun — açılışta beyaz parlama olmasın.
export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#1B1E2A",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    // `dark` sınıfı kalıcı: uygulamanın tek teması koyu.
    <html
      lang="tr"
      className={`dark ${plusJakartaSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex h-full bg-background text-foreground">
        <QueryProvider>
          <SplashScreen />
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-background min-w-0">
            {children}
          </main>
          {/* Ctrl/Cmd + K ile her sayfadan açılan hızlı arama. */}
          <CommandPalette />
          <Toaster richColors position="top-right" />
        </QueryProvider>
      </body>
    </html>
  );
}
