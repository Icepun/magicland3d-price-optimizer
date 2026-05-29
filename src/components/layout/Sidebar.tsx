"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
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
import { ThemeToggle } from "./ThemeToggle";

const navItems = [
  { href: "/",                 label: "Panel",              icon: LayoutDashboard },
  { href: "/products",         label: "Ürünler",            icon: Package },
  { href: "/cost-templates",   label: "Maliyet & Paketleme", icon: CalculatorIcon },
  { href: "/commission-rules", label: "Komisyonlar",        icon: Percent },
  { href: "/cargo-rules",      label: "Kargo",              icon: Truck },
  { href: "/expense-rules",    label: "Ek Giderler",        icon: Receipt },
  { href: "/api-settings",     label: "Entegrasyonlar",     icon: Settings2 },
  { href: "/settings",         label: "Ayarlar",            icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="flex h-screen w-60 flex-col bg-sidebar shrink-0 relative"
      style={{ boxShadow: "inset -1px 0 0 oklch(1 0 0 / 7%)" }}
    >
      {/* Ambient glow — subtle mor halo (her tema) */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-40 opacity-50 dark:opacity-80"
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
        <Image
          src="/logo.png"
          alt="Magicland 3D"
          width={120}
          height={48}
          priority
          className="object-contain select-none"
          style={{
            filter:
              "drop-shadow(0 2px 12px oklch(0.66 0.20 278 / 35%))",
          }}
        />
        <div className="mt-3 text-center">
          <p className="text-[10px] uppercase tracking-[0.30em] text-sidebar-foreground/60 font-semibold">
            Hub
          </p>
        </div>
      </div>

      {/* Navigasyon */}
      <nav className="flex-1 overflow-y-auto p-2 pt-3 space-y-0.5 relative">
        {navItems.map(({ href, label, icon: Icon }, index) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
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
        <span className="text-[10px] uppercase tracking-wider text-sidebar-foreground/55">
          Tema
        </span>
        <ThemeToggle />
      </div>

      <UpdateWidget />
    </aside>
  );
}
