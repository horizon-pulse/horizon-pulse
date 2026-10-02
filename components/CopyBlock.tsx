"use client";
import { useState } from "react";

export function CopyBlock({ title, code, copy = true }: { title: string; code: string; copy?: boolean }) {
  const [done, setDone] = useState(false);
  return (
    <div className="hp-code">
      <div className="hp-code-h">
        <span>{title}</span>
        {copy && (
          <button
            type="button"
            className="hp-code-copy"
            onClick={() => {
              navigator.clipboard?.writeText(code).then(() => {
                setDone(true);
                setTimeout(() => setDone(false), 1500);
              });
            }}
          >
            {done ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <pre>{code}</pre>
    </div>
  );
}
