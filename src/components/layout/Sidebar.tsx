"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Search,
  LayoutDashboard,
  BarChart3,
  Package,
  ClipboardList,
  Printer,
  Boxes,
  Disc3,
  Factory,
  CalculatorIcon,
  Percent,
  Truck,
  Receipt,
  Settings2,
  Settings,
} from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { UpdateWidget } from "./UpdateWidget";
import { NotificationBell } from "./NotificationBell";
import { openCommandPalette } from "@/components/ui/command-palette";
import { useIsClient } from "@/lib/client-state";

const navItems = [
  { href: "/",                 label: "Panel",              icon: LayoutDashboard },
  { href: "/reports",          label: "Raporlar",           icon: BarChart3 },
  { href: "/products",         label: "Ürünler",            icon: Package },
  { href: "/orders",           label: "Siparişler",         icon: ClipboardList },
  { href: "/printers",         label: "Yazıcılar",          icon: Printer },
  { href: "/models",           label: "Modeller",           icon: Boxes },
  { href: "/cost-templates",   label: "Maliyet & Paketleme", icon: CalculatorIcon },
  { href: "/spools",           label: "Filament",           icon: Disc3 },
  { href: "/planner",          label: "Üretim",             icon: Factory },
  { href: "/commission-rules", label: "Komisyonlar",        icon: Percent },
  { href: "/cargo-rules",      label: "Kargo",              icon: Truck },
  { href: "/expenses",         label: "Gider Ödemeleri",    icon: Receipt },
  { href: "/api-settings",     label: "Entegrasyonlar",     icon: Settings2 },
  { href: "/settings",         label: "Ayarlar",            icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();
  // Kısayol etiketi cihaza göre değişir; ilk çizimde Ctrl yazılır, tarayıcıya geçilince
  // Mac'te ⌘ olur (hidrasyon uyuşmazlığı olmasın diye istemci beklenir).
  const isClient = useIsClient();
  const macKisayolu = isClient && /mac/i.test(navigator.userAgent);

  return (
    <aside
      className="flex h-screen w-60 flex-col bg-sidebar shrink-0 relative"
      style={{ boxShadow: "inset -1px 0 0 oklch(1 0 0 / 7%)" }}
    >
      {/* Ambient glow — subtle mor halo */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-80"
        style={{
          background:
            "radial-gradient(ellipse 200px 120px at 50% 0%, oklch(0.55 0.22 278 / 18%), transparent 70%)",
        }}
      />

      {/* Logo + uygulama adı */}
      <div
        className="flex flex-col items-center justify-center px-4 py-5 shrink-0 relative"
        style={{ borderBottom: "1px solid var(--sidebar-border)" }}
      >
        {/* Koyu zeminde görünen açık logo varyantı. */}
        <Image
          src="/logo-dark.png"
          alt="Magicland 3D"
          width={120}
          height={120}
          priority
          className="object-contain select-none block"
          style={{ filter: "drop-shadow(0 2px 14px oklch(0.72 0.16 278 / 45%))" }}
        />
        <div className="mt-3 text-center">
          <p className="text-[10px] uppercase tracking-[0.30em] text-sidebar-foreground/60 font-semibold">
            Hub
          </p>
        </div>
      </div>

      {/* Hızlı arama — kısayolun varlığı görünür olsun diye düğme olarak duruyor. */}
      <div className="px-2 pt-3">
        <button
          type="button"
          onClick={openCommandPalette}
          title="Ürün, sipariş, makara ve sayfa ara"
          className="group flex w-full items-center gap-2 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/30 px-2.5 py-1.5 text-[12px] text-sidebar-foreground/60 transition-all duration-200 hover:border-primary/40 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground active:scale-[0.98]"
        >
          <Search className="h-3.5 w-3.5 shrink-0 transition-colors group-hover:text-primary" />
          <span className="flex-1 text-left">Ara</span>
          <kbd className="rounded border border-sidebar-border/70 px-1 py-0.5 text-[9px] font-medium tabular-nums text-sidebar-foreground/55">
            {macKisayolu ? "⌘K" : "Ctrl K"}
          </kbd>
        </button>
      </div>

      {/* Navigasyon */}
      <nav className="flex-1 overflow-y-auto p-2 pt-2 space-y-0.5 relative">
        {navItems.map(({ href, label, icon: Icon }, index) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              prefetch={false}
              className={cn(
                "group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13px] transition-all duration-200",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-semibold shadow-[inset_0_1px_0_oklch(1_0_0_/_5%)]"
                  : "text-sidebar-foreground/65 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
              )}
              style={{
                animation: `nav-slide-in 280ms ease forwards`,
                animationDelay: `${index * 35}ms`,
                opacity: 0,
                animationFillMode: "forwards",
              } as React.CSSProperties}
            >
              {/* Aktif item için sol kenar mor çizgi */}
              {isActive && (
                <span
                  className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary"
                  style={{
                    boxShadow: "0 0 12px oklch(0.66 0.20 278 / 60%)",
                  }}
                />
              )}
              <Icon
                className={cn(
                  "h-[15px] w-[15px] shrink-0 transition-all duration-200",
                  isActive
                    ? "text-primary"
                    : "text-sidebar-foreground/70 group-hover:text-sidebar-foreground"
                )}
                strokeWidth={isActive ? 2.2 : 1.8}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      <div
        className="px-3 py-2 flex items-center justify-between gap-2"
        style={{ borderTop: "1px solid var(--sidebar-border)" }}
      >
        <NotificationBell />
      </div>

      <UpdateWidget />
    </aside>
  );
}
