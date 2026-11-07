import type { Metadata } from "next";
import { Newsreader, Public_Sans, JetBrains_Mono } from "next/font/google";
import "./globals.css";

const display = Newsreader({ variable: "--font-display", subsets: ["latin"], style: ["normal", "italic"], weight: ["400", "500", "600"], display: "swap" });
const body = Public_Sans({ variable: "--font-body", subsets: ["latin"], weight: ["400", "500", "600"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-mono-ui", subsets: ["latin"], weight: ["400", "500"], display: "swap" });

export const metadata: Metadata = {
  title: "Tokento Shopper",
  description: "A Claude shopping agent that spends your store rewards, pays with PayPal, and earns your next reward.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable} ${mono.variable}`}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
