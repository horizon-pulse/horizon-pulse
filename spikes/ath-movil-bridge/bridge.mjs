// Agent-pay bridge (SPIKE, local only). An agent calls a paid route and gets a 402 whose body carries an ATH Móvil payment request.
// The human approves in the ATH Móvil app. The bridge sees CONFIRM (by webhook or polling findPayment), calls /authorization, and the
// funds move from the customer straight to the MERCHANT's own ATH Business account. The bridge never holds, pools or routes funds:
// it stores only ids and statuses. Webhooks have no documented signature, so they are only a hint: the bridge always re-reads
// status with findPayment before it treats a payment as paid.
import http from "node:http";

const BASE = "/api/business-transaction/ecommerce";
export function startBridge({ athUrl, publicToken, port = 0, priceUsd = 0.25, resultFor = () => ({ ok: true }) }) {
  const orders = new Map(); // ecommerceId -> { auth_token, path, status, result }
  const ath = (p, b, h = {}) => fetch(athUrl + BASE + p, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...h }, body: JSON.stringify(b ?? {}) }).then((r) => r.json());
  const send = (res, code, obj, h = {}) => { res.writeHead(code, { "content-type": "application/json", ...h }); res.end(JSON.stringify(obj, null, 2)); };

  async function settle(id) {
    const o = orders.get(id); if (!o) return null;
    if (o.status === "COMPLETED" || o.status === "CANCEL") return o;
    const f = await ath("/business/findPayment", { ecommerceId: id, publicToken });       // source of truth
    const s = f?.data?.ecommerceStatus;
    if (s === "CONFIRM") {
      const a = await ath("/authorization", {}, { authorization: `Bearer ${o.auth_token}` }); // merchant finalizes; ATH debits the customer
      if (a?.data?.ecommerceStatus === "COMPLETED") Object.assign(o, { status: "COMPLETED", referenceNumber: a.data.referenceNumber, fee: a.data.fee, result: resultFor(o.path) });
    } else if (s === "COMPLETED" && !o.result) Object.assign(o, { status: "COMPLETED", referenceNumber: f.data.referenceNumber, fee: f.data.fee, result: resultFor(o.path) });
    else if (s) o.status = s;
    return o;
  }

  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if (req.method === "POST" && u.pathname === "/ath/webhook") {        // webhook = hint only, then verify
      let d = ""; for await (const c of req) d += c;
      const evt = JSON.parse(d || "{}"); if (evt.ecommerceId) await settle(evt.ecommerceId);
      return send(res, 200, { received: true });
    }
    if (u.pathname.startsWith("/api/")) {
      const id = req.headers["x-ath-ecommerce-id"];
      if (!id) {                                                         // 1) no payment yet -> 402 with an ATH Móvil request
        const p = await ath("/payment", { env: "production", publicToken, total: priceUsd.toFixed(2), subtotal: priceUsd.toFixed(2), tax: "0", timeout: "600",
          metadata1: "horizon-pulse", metadata2: u.pathname, items: [{ name: u.pathname, description: "API call", quantity: "1", price: priceUsd.toFixed(2), tax: "0", metadata: "agent" }] });
        orders.set(p.data.ecommerceId, { auth_token: p.data.auth_token, path: u.pathname, status: "OPEN" });
        return send(res, 402, { error: "payment_required", accepts: [{ scheme: "athmovil-button", network: "athmovil", currency: "USD", amount: priceUsd.toFixed(2),
          payTo: "merchant ATH Business account (funds go directly to the merchant)", ecommerceId: p.data.ecommerceId, expiresInSeconds: 600,
          humanAction: "Approve the payment request in the ATH Móvil app", retry: { header: "X-ATH-ECOMMERCE-ID", value: p.data.ecommerceId } }] });
      }
      const o = await settle(id);                                        // 2) retry with the id
      if (!o || o.path !== u.pathname) return send(res, 404, { error: "unknown_order" });
      if (o.status === "COMPLETED") return send(res, 200, o.result, { "x-ath-reference": o.referenceNumber ?? "" });
      if (o.status === "CANCEL") return send(res, 410, { error: "payment_cancelled_or_expired" });
      return send(res, 202, { status: o.status, message: "waiting for the human to approve in ATH Móvil", retryAfterSeconds: 2 }, { "retry-after": "2" });
    }
    send(res, 404, { error: "not_found" });
  });
  return new Promise((r) => srv.listen(port, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}`, orders })));
}
