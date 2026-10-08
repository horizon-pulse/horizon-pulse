/**
 * Pinned Solana payTo + config parsing. The rail switches on ONLY for
 * HP_SOLANA_ENABLED === "true" with HP_SOLANA_PAYTO === the pinned string.
 */
import { describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519";
import {
  PAYAI_FACILITATOR_URL,
  SOLANA_MAINNET_CAIP2,
  SOLANA_PAYTO,
  SOLANA_PAYTO_USDC_ATA,
  USDC_SOLANA_MINT,
  base58Decode,
  base58Encode,
  getSolanaRailConfig,
  isValidSolanaPubkey,
} from "@/lib/solana-config";
import { SOLANA_MAINNET_CAIP2 as SDK_MAINNET, USDC_MAINNET_ADDRESS as SDK_USDC } from "@x402/svm";
import { PINNED_PAYTO, fillerPubkey } from "./helpers/solana-env";
import payto from "../config/payto.json";

describe("pinned Solana payTo", () => {
  it("is exactly the address Michael sent (char for char)", () => {
    expect(SOLANA_PAYTO).toBe(payto.solana.payTo); // literal pin: tests/payto-pin.test.ts
    expect(SOLANA_PAYTO).toBe(PINNED_PAYTO);
    expect(SOLANA_PAYTO.length).toBe(44);
  });

  it("is a canonical 32-byte base58 pubkey", () => {
    const bytes = base58Decode(SOLANA_PAYTO)!;
    expect(bytes.length).toBe(32);
    expect(base58Encode(bytes)).toBe(SOLANA_PAYTO);
    expect(isValidSolanaPubkey(SOLANA_PAYTO)).toBe(true);
  });

  it("is an on-curve ed25519 point (a normal wallet key, not a PDA)", () => {
    const hex = Buffer.from(base58Decode(SOLANA_PAYTO)!).toString("hex");
    expect(() => ed25519.ExtendedPoint.fromHex(hex)).not.toThrow();
  });

  it("constants match @x402/svm", () => {
    expect(SOLANA_MAINNET_CAIP2).toBe(SDK_MAINNET);
    expect(USDC_SOLANA_MINT).toBe(SDK_USDC);
    expect(USDC_SOLANA_MINT).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(SOLANA_MAINNET_CAIP2).toBe("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp");
  });
});

describe("isValidSolanaPubkey rejects bad / edited addresses", () => {
  const bad: Record<string, unknown> = {
    "empty": "",
    "one extra char": SOLANA_PAYTO + "1",
    "leading space": " " + SOLANA_PAYTO,
    "trailing newline": SOLANA_PAYTO + "\n",
    "invalid char 0": SOLANA_PAYTO.slice(0, -1) + "0",
    "invalid char O": SOLANA_PAYTO.slice(0, -1) + "O",
    "invalid char l": SOLANA_PAYTO.slice(0, -1) + "l",
    "EVM address": payto.base.payTo,
    "31 bytes": base58Encode(new Uint8Array(31).fill(7)),
    "33 bytes": base58Encode(new Uint8Array(33).fill(7)),
    "not a string": 12345,
    "undefined": undefined,
  };
  for (const [name, v] of Object.entries(bad)) {
    it(name, () => expect(isValidSolanaPubkey(v)).toBe(false));
  }
  it("NOTE: Solana base58 has no checksum, so edited/truncated variants can still be well-formed; the exact pin (below) is what rejects them", () => {
    const variants = [SOLANA_PAYTO.slice(0, -1) + "Q", "C" + SOLANA_PAYTO.slice(1), SOLANA_PAYTO.slice(0, -1)];
    for (const v of variants) {
      expect(v).not.toBe(SOLANA_PAYTO);
      expect(getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: v }).enabled).toBe(false);
    }
  });
  it("accepts other well-formed 32-byte keys (format check only)", () => {
    expect(isValidSolanaPubkey(fillerPubkey(3))).toBe(true);
    expect(isValidSolanaPubkey(USDC_SOLANA_MINT)).toBe(true);
  });
});

describe("getSolanaRailConfig", () => {
  it("on: exact flag + exact payTo", () => {
    expect(getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO })).toEqual({
      enabled: true,
      config: {
        network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
        payTo: payto.solana.payTo,
        asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        facilitatorUrl: "https://facilitator.payai.network",
        rpcUrl: "https://api.mainnet-beta.solana.com",
        initTimeoutMs: 2500,
      },
    });
    expect(PAYAI_FACILITATOR_URL).toBe("https://facilitator.payai.network");
  });

  it("on: explicit mainnet network is accepted", () => {
    const r = getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_NETWORK: SOLANA_MAINNET_CAIP2 });
    expect(r.enabled).toBe(true);
  });

  const offCases: Record<string, Record<string, string | undefined>> = {
    "unset": {},
    "flag TRUE": { HP_SOLANA_ENABLED: "TRUE", HP_SOLANA_PAYTO: SOLANA_PAYTO },
    "flag 1": { HP_SOLANA_ENABLED: "1", HP_SOLANA_PAYTO: SOLANA_PAYTO },
    "flag ' true'": { HP_SOLANA_ENABLED: " true", HP_SOLANA_PAYTO: SOLANA_PAYTO },
    "payTo missing": { HP_SOLANA_ENABLED: "true" },
    "payTo edited": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO.slice(0, -1) + "Q" },
    "payTo truncated": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO.slice(0, 43) },
    "payTo trailing space (no trimming)": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO + " " },
    "payTo another valid key (no substitution)": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: fillerPubkey(5) },
    "devnet network": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_NETWORK: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" },
    "RPC URL not https": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_RPC_URL: "http://api.mainnet-beta.solana.com" },
    "RPC URL garbage": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_RPC_URL: "not a url" },
    "v1 network name": { HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_NETWORK: "solana" },
  };
  for (const [name, env] of Object.entries(offCases)) {
    it(`off: ${name}`, () => {
      const r = getSolanaRailConfig(env);
      expect(r.enabled).toBe(false);
      if (!r.enabled) expect(r.misconfigured).toBe(env.HP_SOLANA_ENABLED === "true");
    });
  }

  it("allow-listed https RPC URL accepted (stored parsed + normalised)", () => {
    const r = getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_RPC_URL: "https://api.mainnet-beta.solana.com" });
    expect(r).toMatchObject({ enabled: true, config: { rpcUrl: "https://api.mainnet-beta.solana.com/" } });
  });

  it("pinned payTo USDC token account = SDK/kit derivation", async () => {
    const { __loadRealSolanaModulesForTests } = await import("@/lib/solana-rail");
    const mods = await __loadRealSolanaModulesForTests();
    expect(await mods.deriveUsdcAta(SOLANA_PAYTO, USDC_SOLANA_MINT)).toBe(SOLANA_PAYTO_USDC_ATA);
    expect(SOLANA_PAYTO_USDC_ATA).toBe(payto.solana.usdcAta); // literal pin: tests/payto-pin.test.ts
    const { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } = await import("@solana-program/token");
    const { address } = await import("@solana/kit");
    const [ata] = await findAssociatedTokenPda({ owner: address(SOLANA_PAYTO), mint: address(USDC_SOLANA_MINT), tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(ata.toString()).toBe(SOLANA_PAYTO_USDC_ATA);
  });

  it("init timeout: bounded parse", () => {
    const on = (t: string) => getSolanaRailConfig({ HP_SOLANA_ENABLED: "true", HP_SOLANA_PAYTO: SOLANA_PAYTO, HP_SOLANA_INIT_TIMEOUT_MS: t });
    expect(on("150")).toMatchObject({ config: { initTimeoutMs: 150 } });
    expect(on("999999")).toMatchObject({ config: { initTimeoutMs: 2500 } });
    expect(on("abc")).toMatchObject({ config: { initTimeoutMs: 2500 } });
  });
});
