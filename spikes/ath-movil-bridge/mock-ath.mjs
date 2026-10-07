// LOCAL MOCK of the documented ATH Móvil Payment Button API (no sandbox exists:
// "We currently do not have a Testing environment" — github.com/evertec/ATHM-Payment-Button-API).
// Shapes follow that README (/payment, /business/findPayment, /authorization; statuses OPEN → CONFIRM → COMPLETED | CANCEL)
// and the webhook payload in github.com/evertec/athmovil-webhooks ("eCommerce Payment Completed").
// The fee mirrors the published 2.25% with a $0.06 minimum (ath.business/en). Not affiliated with Evertec.
import http from "node:http";
import { randomUUID } from "node:crypto";

const BASE = "/api/business-transaction/ecommerce";
const txs = new Map();
let listenerURL = null;

const body = (req) => new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => r(d ? JSON.parse(d) : {})); });
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const view = (t) => ({ ecommerceStatus: t.status, ecommerceId: t.ecommerceId, referenceNumber: t.referenceNumber, businessName: "ATH Business Test",
  total: t.total, subTotal: t.subtotal ?? t.total, tax: t.tax ?? 0, metadata1: t.metadata1, metadata2: t.metadata2, items: t.items ?? [],
  fee: t.status === "COMPLETED" ? Math.max(0.06, +(t.total * 0.0225).toFixed(2)) : 0, netAmount: null, totalRefundedAmount: 0,
  transactionDate: t.transactionDate ?? null, dailyTransactionId: t.daily ?? null });

export function startMockAth(port = 0) {
  const srv = http.createServer(async (req, res) => {
    const b = req.method === "POST" ? await body(req) : {};
    if (req.url === `${BASE}/payment`) {
      if (!b.publicToken || b.total == null) return send(res, 400, { status: "error", message: "publicToken and total are required" });
      const t = { ecommerceId: randomUUID(), auth_token: `mock.${randomUUID()}`, status: "OPEN", publicToken: b.publicToken, total: Number(b.total),
        metadata1: b.metadata1, metadata2: b.metadata2, items: b.items, phoneNumber: b.phoneNumber, created: Date.now(), timeout: Number(b.timeout ?? 600) };
      txs.set(t.ecommerceId, t);
      return send(res, 200, { status: "success", data: { ecommerceId: t.ecommerceId, auth_token: t.auth_token } });
    }
    if (req.url === `${BASE}/business/findPayment`) {
      const t = txs.get(b.ecommerceId);
      if (!t || t.publicToken !== b.publicToken) return send(res, 404, { status: "error", message: "transaction not found" });
      return send(res, 200, { status: "success", data: view(t) });
    }
    if (req.url === `${BASE}/authorization`) {
      const tok = (req.headers.authorization ?? "").replace(/^Bearer\s+/, "");
      const t = [...txs.values()].find((x) => x.auth_token === tok);
      if (!t) return send(res, 401, { status: "error", message: "invalid auth_token" });
      if (t.status !== "CONFIRM") return send(res, 409, { status: "error", message: `cannot authorize in status ${t.status}` });
      Object.assign(t, { status: "COMPLETED", referenceNumber: `ref-${randomUUID().slice(0, 8)}`, transactionDate: new Date().toISOString(), daily: txs.size });
      fire({ ...view(t), status: "COMPLETED", transactionType: "ECOMMERCE" });
      return send(res, 200, { status: "success", data: view(t) });
    }
    // Webhook subscription (documented at https://www.athmovil.com/transactions/webhook/post).
    if (req.url === "/transactions/webhook/post") { listenerURL = b.listenerURL; return send(res, 200, { status: "success" }); }
    // MOCK-ONLY: simulates the human tapping Pay (or cancelling) in the ATH Móvil app.
    if (req.url === "/__mock/customer") {
      const t = txs.get(b.ecommerceId);
      if (!t || t.status !== "OPEN") return send(res, 409, { status: "error" });
      t.status = b.action === "cancel" ? "CANCEL" : "CONFIRM";
      if (t.status === "CANCEL") fire({ ...view(t), status: "CANCEL", transactionType: "ECOMMERCE" });
      return send(res, 200, { status: "success", data: view(t) });
    }
    send(res, 404, { status: "error" });
  });
  function fire(evt) { if (listenerURL) fetch(listenerURL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(evt) }).catch(() => {}); }
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}
