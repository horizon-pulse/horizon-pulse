/** Streams a request body and stops once it passes `max` bytes (same pattern as the Trade Gate handler). */
/** Sentinel NOTE-3 (10/23): an invalid Content-Length is rejected (null -> 400), as Trade Gate does, instead of ignored. */
export async function readCapped(req: Request, max: number): Promise<string | "too_large" | null> {
  const declared = req.headers.get("content-length");
  if (declared !== null && !/^\d+$/.test(declared.trim())) return null;
  if (declared !== null && Number(declared) > max) return "too_large";
  try {
    if (!req.body) return "";
    const reader = req.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return "too_large";
      }
      chunks.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
}
