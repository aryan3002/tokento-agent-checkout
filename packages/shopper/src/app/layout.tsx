import type { Metadata } from "next";
import Script from "next/script";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

// Same type and themes as the store dashboard, so both sides read as one product.
const sans = Geist({ variable: "--font-body", subsets: ["latin"], display: "swap" });
const mono = Geist_Mono({ variable: "--font-mono-ui", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Tokento Shopper",
  description: "An AI shopping agent that spends your store rewards, pays with PayPal, and earns your next reward.",
};

// Runs before the first paint so a saved dark/light choice never flashes the other theme.
const THEME_SCRIPT = `try{var t=localStorage.getItem('tokento.theme');if(t==='dark'||t==='light'){document.documentElement.dataset.theme=t}}catch(e){}`;

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen bg-surface-0 text-text-primary antialiased">
        <Script id="tokento-theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>
        {children}
      </body>
    </html>
  );
}
