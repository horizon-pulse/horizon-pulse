"use client";
import { useState } from "react";

export function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="hp-copy">
      <span><b>$</b> {text}</span>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard?.writeText(text).then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          });
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
