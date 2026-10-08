/**
 * Syntactically valid XRPL classic addresses derived at runtime from a fixed
 * filler byte. They are NOT wallets: no key pair exists for them in this repo,
 * nothing is generated, funded, or sent to any network.
 */
import { encodeXrplClassicAddress } from "@/lib/xrpl-config";

export function validTestAddress(fill: number): string {
  return encodeXrplClassicAddress(new Uint8Array(20).fill(fill));
}

/** Same address with its last character changed, so the checksum fails. */
export function badChecksumAddress(fill: number): string {
  const a = validTestAddress(fill);
  const last = a[a.length - 1];
  return a.slice(0, -1) + (last === "z" ? "y" : "z");
}
