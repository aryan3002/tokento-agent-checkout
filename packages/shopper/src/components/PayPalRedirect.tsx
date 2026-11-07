"use client";

// PayPal sends the shopper here after the approval page (redirect flow, when
// the popup isn't used). Capture or cancel, then go back to the chat.
import { useEffect, useRef } from "react";
import { finishRedirect } from "@/lib/chat/client";

export function PayPalRedirect({ page }: { page: "return" | "cancel" }) {
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void finishRedirect(page, window.location.search, (url, init) => fetch(url, init)).then((target) => window.location.replace(target));
  }, [page]);

  return (
    <main className="mx-auto max-w-md px-4 py-24">
      <div className="glass p-6">
        <p className="text-sm font-medium">Tokento Shopper · PayPal</p>
        <p className="mt-2 flex items-center gap-2 text-text-secondary">
          <span className="dot dot-warning pulse-dot" aria-hidden />
          {page === "return" ? "Confirming your payment with PayPal…" : "Cancelling the payment…"}
        </p>
      </div>
    </main>
  );
}
