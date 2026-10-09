"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/market", label: "시장", icon: "📈" },
  { href: "/class", label: "우리 반", icon: "🏫" },
  { href: "/account", label: "내 계좌", icon: "💰" },
  { href: "/ranking", label: "랭킹", icon: "🏆" },
];

export default function TabBar() {
  const path = usePathname();
  if (path === "/" || path.startsWith("/join")) return null;
  return (
    <nav className="fixed bottom-0 inset-x-0 z-20 border-t border-line bg-bg/95 backdrop-blur">
      <ul className="mx-auto flex max-w-md">
        {TABS.map((t) => {
          const on = path.startsWith(t.href) || (t.href === "/market" && path.startsWith("/stock"));
          return (
            <li key={t.href} className="flex-1">
              <Link href={t.href} className={`flex flex-col items-center py-2 text-[11px] ${on ? "text-ink font-bold" : "text-sub"}`}>
                <span className="text-lg leading-none">{t.icon}</span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
