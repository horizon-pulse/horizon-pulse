// Runnable local demo: node spikes/ath-movil-bridge/demo.mjs  (no network, no account, no funds; everything is a local mock)
import { startMockAth } from "./mock-ath.mjs";
import { startBridge } from "./bridge.mjs";

const log = (...a) => console.log("•", ...a);
const ath = await startMockAth();
const bridge = await startBridge({ athUrl: ath.url, publicToken: "MOCK_PUBLIC_TOKEN", priceUsd: 0.25,
  resultFor: (p) => ({ route: p, data: { btc: "mock", note: "result released after a verified ATH Móvil payment" } }) });
await fetch(ath.url + "/transactions/webhook/post", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ publicToken: "MOCK_PUBLIC_TOKEN", privateToken: "MOCK_PRIVATE", listenerURL: bridge.url + "/ath/webhook",
    ecommercePaymentReceivedEvent: true, ecommercePaymentCancelledEvent: true, ecommercePaymentExpiredEvent: true }) });

async function run(action) {
  const r1 = await fetch(bridge.url + "/api/pulse"); const j1 = await r1.json();
  log(`agent GET /api/pulse -> ${r1.status}`, JSON.stringify({ amount: j1.accepts[0].amount, ecommerceId: j1.accepts[0].ecommerceId }));
  const id = j1.accepts[0].ecommerceId, H = { "x-ath-ecommerce-id": id };
  const r2 = await fetch(bridge.url + "/api/pulse", { headers: H }); log(`agent retry before approval -> ${r2.status}`, (await r2.json()).status);
  await fetch(ath.url + "/__mock/customer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ecommerceId: id, action }) });
  log(`human ${action === "cancel" ? "cancels" : "approves"} in ATH Móvil (mock)`);
  for (let i = 0; i < 5; i++) {
    const r = await fetch(bridge.url + "/api/pulse", { headers: H });
    if (r.status !== 202) { log(`agent retry -> ${r.status}`, JSON.stringify(await r.json()), r.headers.get("x-ath-reference") ?? ""); break; }
    await new Promise((s) => setTimeout(s, 200));
  }
  const o = bridge.orders.get(id); log("bridge stored (ids + status only):", JSON.stringify({ status: o.status, referenceNumber: o.referenceNumber, fee: o.fee }));
  return o.status;
}
const a = await run("approve"); const b = await run("cancel");
console.log(a === "COMPLETED" && b === "CANCEL" ? "DEMO PASS" : "DEMO FAIL");
ath.srv.close(); bridge.srv.close();
