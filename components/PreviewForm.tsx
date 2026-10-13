"use client";
import { useState } from "react";

export function PreviewForm() {
  const [url, setUrl] = useState("");
  const [docs, setDocs] = useState("");
  const [email, setEmail] = useState("");
  const [consent, setConsent] = useState(false);
  const [msg, setMsg] = useState("");
  const emailOk = !email.trim() || consent;
  async function submit(e: { preventDefault: () => void }) {
    e.preventDefault();
    setMsg("Sending…");
    const r = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: url.trim() || undefined,
        docs: docs.trim() || undefined,
        email: email.trim() || undefined,
        consent: email.trim() ? consent : undefined,
      }),
    }).catch(() => null);
    const j = r && r.status === 202 ? ((await r.json().catch(() => null)) as { next?: string } | null) : null;
    setMsg(j?.next ? `Received. ${j.next}` : "Could not queue the preview. Please try later.");
  }
  return (
    <form className="hp-form" onSubmit={submit}>
      <label>
        <span>OpenAPI / API docs URL</span>
        <input type="url" placeholder="https://api.example.com/openapi.json" value={url} onChange={(e) => setUrl(e.target.value)} />
      </label>
      <label>
        <span>Or paste an OpenAPI spec (JSON) or docs <em>max 50 KB</em></span>
        <textarea rows={6} maxLength={50000} value={docs} onChange={(e) => setDocs(e.target.value)} />
      </label>
      <label>
        <span>Email <em>optional</em></span>
        <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      {email.trim() && (
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Email me the reviewed
          preview. My email is stored with my submission and deleted automatically after 30 days.
        </label>
      )}
      <button type="submit" className="hp-btn" disabled={(!url.trim() && !docs.trim()) || !emailOk}>Request a preview</button>
      {msg && <p style={{ fontSize: 13 }}>{msg}</p>}
    </form>
  );
}
