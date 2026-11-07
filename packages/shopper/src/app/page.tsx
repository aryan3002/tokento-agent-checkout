"use client";

import { useEffect, useState } from "react";

export default function ShopperHome() {
  const [name, setName] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/demo", { method: "POST" })
      .then((res) => res.json())
      .then((data) => setName(data.session?.name ?? null))
      .catch(() => setName(null));
  }, []);

  return (
    <main className="mx-auto max-w-2xl px-4 py-16">
      <h1 className="text-3xl">Tokento Shopper</h1>
      <p className="mt-2 text-text-secondary">{name ? `Shopping for ${name}.` : "Starting your session..."}</p>
    </main>
  );
}
