"use client";
import { useState } from "react";

export function PreviewForm() {
  const [url, setUrl] = useState("");
  const [docs, setDocs] = useState("");
  const [msg, setMsg] = useState("");
  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    setMsg("Sending…");
    const r = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: url.trim() || undefined, docs: docs.trim() || undefined }),
    }).catch(() => null);
    setMsg(r && r.status === 202 ? "Received. A person reviews the draft before anything is sent." : "Could not queue the preview. Please try later.");
  }
  return (
    <form className="hp-form" onSubmit={submit}>
      <label>
        <span>API docs or OpenAPI URL</span>
        <input type="url" placeholder="https://api.example.com/openapi.json" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        <span>Or paste docs <em>max 50 KB</em></span>
        <textarea rows={6} maxLength={50000} value={docs} onChange={(e) => setDocs(e.target.value)} />
      </label>
      <button type="submit" className="hp-btn" disabled={!url.trim() && !docs.trim()}>Request a preview</button>
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
    </form>
  );
}
