import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import "./globals.css";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import NavItem from "@/components/ui/nav-item";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Throxy Ranker",
  description: "Throxy Ranker - AI-powered ranking application",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased h-full overflow-x-hidden`}>
        <div className="grid min-h-dvh h-dvh grid-rows-[auto_1fr_auto] w-full max-w-full">
          <header className="bg-throxy-pink text-throxy-black py-3 px-4 sm:px-6 lg:px-8 flex items-center gap-4 shrink-0">
            <Link href="/" className="flex items-center shrink-0" aria-label="Throxy home">
              <Image
                src="/throxy-logo.png"
                alt="Throxy"
                width={48}
                height={48}
                className="h-9 w-auto object-contain"
                priority
              />
            </Link>
            <nav className="flex gap-4">
              <NavItem href="/" label="Ranker" />
              <NavItem href="/prompts" label="Prompts" />
            </nav>
          </header>
          <main className="min-h-0 overflow-y-auto overflow-x-hidden px-4 py-6 sm:px-6 sm:py-8 lg:px-8 bg-background">
            <div className="mx-auto w-full max-w-full sm:max-w-7xl">
              {children}
            </div>
          </main>
          <footer className="bg-throxy-black text-sm text-white py-3 px-4 sm:px-6 lg:px-8 shrink-0">
            &copy; {new Date().getFullYear()} Throxy Ranker
          </footer>
        </div>
        <Toaster />
      </body>
    </html>
  );
}
