import type { Metadata } from "next";
import { Plus_Jakarta_Sans, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/Sidebar";
import { SplashScreen } from "@/components/layout/SplashScreen";
import { Toaster } from "@/components/ui/sonner";
import { QueryProvider } from "@/components/providers/QueryProvider";

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
  title: "Magicland 3D — Fiyat Optimizasyonu",
  description: "Trendyol satıcıları için fiyat ve kâr optimizasyon aracı",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="tr"
      className={`${plusJakartaSans.variable} ${geistMono.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="flex h-full bg-background text-foreground">
        <QueryProvider>
          <SplashScreen />
          <Sidebar />
          <main className="flex-1 overflow-y-auto bg-background">
            {children}
          </main>
          <Toaster richColors position="top-right" />
        </QueryProvider>
      </body>
    </html>
  );
}
