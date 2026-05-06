"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Package,
  Star,
  CalculatorIcon,
  Percent,
  Truck,
  Receipt,
  ArrowUpDown,
  Settings2,
  Settings,
} from "lucide-react";
import Image from "next/image";
import { cn } from "@/lib/utils";
import { UpdateWidget } from "./UpdateWidget";

const navItems = [
  { href: "/",                 label: "Dashboard",          icon: LayoutDashboard },
  { href: "/products",         label: "Ürünler",            icon: Package },
  { href: "/recommendations",  label: "Öneriler",           icon: Star },
  { href: "/cost-templates",   label: "Maliyet Ayarları",   icon: CalculatorIcon },
  { href: "/commission-rules", label: "Komisyon Kuralları", icon: Percent },
  { href: "/cargo-rules",      label: "Kargo Kuralları",    icon: Truck },
  { href: "/expense-rules",    label: "Ek Gider Kuralları", icon: Receipt },
  { href: "/import-export",    label: "İçe/Dışa Aktar",    icon: ArrowUpDown },
  { href: "/api-settings",     label: "Trendyol API",       icon: Settings2 },
  { href: "/settings",         label: "Ayarlar",            icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside
      className="flex h-screen w-60 flex-col bg-sidebar shrink-0"
      style={{ boxShadow: "inset -1px 0 0 oklch(1 0 0 / 6%)" }}
    >
      {/* Logo alanı */}
      <div
        className="flex h-16 items-center justify-center px-4 shrink-0"
        style={{ borderBottom: "1px solid oklch(1 0 0 / 6%)" }}
      >
        <Image
          src="/logo.png"
          alt="Magicland 3D"
          width={130}
          height={52}
          priority
          className="object-contain select-none"
          style={{
            filter:
              "drop-shadow(0 1px 6px oklch(0.62 0.20 278 / 22%))",
          }}
        />
      </div>

      {/* Navigasyon */}
      <nav className="flex-1 overflow-y-auto p-2 pt-3 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon }, index) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "group flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-200",
                "border-l-2",
                isActive
                  ? "border-primary bg-sidebar-accent text-sidebar-accent-foreground font-semibold"
                  : "border-transparent text-sidebar-foreground/60 hover:bg-sidebar-accent/40 hover:text-sidebar-foreground hover:border-sidebar-border"
              )}
              style={{
                animation: `nav-slide-in 280ms ease forwards`,
                animationDelay: `${index * 35}ms`,
                opacity: 0,
                animationFillMode: "forwards",
              } as React.CSSProperties}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors duration-200",
                  isActive
                    ? "text-primary"
                    : "text-muted-foreground group-hover:text-sidebar-foreground"
                )}
              />
              {label}
            </Link>
          );
        })}
      </nav>

      <UpdateWidget />
    </aside>
  );
}
