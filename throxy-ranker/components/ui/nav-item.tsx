"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type NavItemProps = {
  href: string;
  label: string;
};

export default function NavItem({ href, label }: NavItemProps) {
  const pathname = usePathname();
  const active =
    href === "/"
      ? pathname === "/"
      : pathname === href || pathname.startsWith(`${href}/`);
  return (
    <Link
      href={href}
      className={`px-4 py-2 rounded-lg text-sm font-medium transition
      ${active
        ? "bg-throxy-black text-white"
        : "text-muted-foreground hover:text-throxy-black"
      }`}
    >
      {label}
    </Link>
  );
}