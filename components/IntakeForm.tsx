"use client";
import { useState } from "react";
import { intakeHost, intakeMailto, INTAKE_SUBJECT_PREFIX } from "@/lib/agent-promotion";

/**
 * Agent promotion intake. Builds a prefilled mailto in the browser; nothing is
 * sent to or stored by horizonpulse.dev (no backend, no network request).
 */
export function IntakeForm() {
  const [f, setF] = useState({ apiUrl: "", email: "", description: "", routes: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const ready = f.apiUrl.trim() && f.email.trim() && f.description.trim();
  return (
    <form className="hp-form" onSubmit={(e) => e.preventDefault()}>
      <label>
        <span>API URL <em>required</em></span>
        <input type="url" placeholder="https://api.example.com" value={f.apiUrl} onChange={set("apiUrl")} required />
      </label>
      <label>
        <span>Contact email <em>required</em></span>
        <input type="email" placeholder="you@example.com" value={f.email} onChange={set("email")} required />
      </label>
      <label>
        <span>Short description <em>required</em></span>
        <textarea rows={4} placeholder="What your API does and who calls it" value={f.description} onChange={set("description")} required />
      </label>
      <label>
        <span>Number of paid routes <em>optional</em></span>
        <input type="number" min={0} inputMode="numeric" placeholder="e.g. 6" value={f.routes} onChange={set("routes")} />
      </label>
      <div className="hp-form-foot">
        <a className={`hp-btn primary${ready ? "" : " off"}`} href={intakeMailto(f)} aria-disabled={!ready}>
          Open the intake email
        </a>
        <span>
          Subject: <code>{INTAKE_SUBJECT_PREFIX}{intakeHost(f.apiUrl)}</code>
        </span>
      </div>
    </form>
  );
}
