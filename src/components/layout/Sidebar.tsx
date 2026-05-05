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
import { cn } from "@/lib/utils";
import { UpdateWidget } from "./UpdateWidget";

const navItems = [
  { href: "/", label: "Dashboard", icon: LayoutDashboard },
  { href: "/products", label: "Ürünler", icon: Package },
  { href: "/recommendations", label: "Öneriler", icon: Star },
  { href: "/cost-templates", label: "Maliyet Şablonları", icon: CalculatorIcon },
  { href: "/commission-rules", label: "Komisyon Kuralları", icon: Percent },
  { href: "/cargo-rules", label: "Kargo Kuralları", icon: Truck },
  { href: "/expense-rules", label: "Ek Gider Kuralları", icon: Receipt },
  { href: "/import-export", label: "İçe/Dışa Aktar", icon: ArrowUpDown },
  { href: "/api-settings", label: "Trendyol API", icon: Settings2 },
  { href: "/settings", label: "Ayarlar", icon: Settings },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 flex-col border-r bg-sidebar">
      <div className="flex h-14 items-center border-b px-4">
        <span className="text-sm font-semibold text-sidebar-foreground">
          Trendyol Price Optimizer
        </span>
      </div>
      <nav className="flex-1 overflow-y-auto p-2">
        {navItems.map(({ href, label, icon: Icon }) => {
          const isActive =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                isActive
                  ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
                  : "text-sidebar-foreground hover:bg-sidebar-accent/50"
              )}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>
      <UpdateWidget />
    </aside>
  );
}
