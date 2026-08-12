import type { Metadata, Viewport } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { SplashScreen } from "@/components/layout/SplashScreen";
import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/components/providers/QueryProvider";
import { CommandPalette } from "@/components/ui/command-palette";

const plusJakartaSans = Plus_Jakarta_Sans({
  variable: "--font-sans",
  subsets: ["latin-ext"],
  weight: ["400", "500", "600", "700", "800"],
  display: "swap",
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
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
