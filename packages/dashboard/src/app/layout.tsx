import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Geist for everything, Geist Mono for ids and figures.
const sans = Geist({ variable: "--font-body", subsets: ["latin"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-mono-ui", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Tokento — Store dashboard",
  description: "See what AI shopping agents bought from your store, how PayPal paid for it, and what you are owed.",
};

// Runs before the first paint so a saved dark/light choice never flashes the other theme.
const THEME_SCRIPT = `try{var t=localStorage.getItem('tokento.theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col bg-surface-0 text-text-primary">
        <Script id="tokento-theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        {children}
      </body>
    </html>
  );
}
