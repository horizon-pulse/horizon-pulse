import { describe, expect, it } from "vitest";
import { isValidClassicAddress } from "xrpl";
import * as xrplPkg from "@x402/xrpl";
import {
  RLUSD_CURRENCY_HEX,
  RLUSD_MAINNET_ISSUER,
  X402_ORG_FACILITATOR_URL,
  encodeXrplClassicAddress,
  getXrplRailConfig,
  isValidXrplClassicAddress,
  usdcAtomicToRlusdValue,
} from "@/lib/xrpl-config";
import * as cfg from "@/lib/config";
import { badChecksumAddress, validTestAddress } from "./helpers/xrpl-addresses";

const PAYTO = validTestAddress(7);

describe("XRPL classic address validation", () => {
  it("agrees with xrpl.js on derived addresses", () => {
    for (const fill of [0, 1, 7, 42, 128, 255]) {
      const a = validTestAddress(fill);
      expect(isValidXrplClassicAddress(a)).toBe(true);
      expect(isValidClassicAddress(a)).toBe(true);
      const bad = badChecksumAddress(fill);
      expect(isValidXrplClassicAddress(bad)).toBe(false);
      expect(isValidClassicAddress(bad)).toBe(false);
    }
  });
  it("accepts the public RLUSD issuer constants (format check)", () => {
    expect(isValidXrplClassicAddress(RLUSD_MAINNET_ISSUER)).toBe(true);
    expect(isValidXrplClassicAddress(xrplPkg.RLUSD_TESTNET_ISSUER)).toBe(true);
  });
  it("rejects non-classic inputs", () => {
    for (const v of ["", "r", "0x5b32c973596078a967562ca652761404f19be0e9", PAYTO.slice(0, -2), `X${PAYTO.slice(1)}`, ` ${PAYTO}`, 42, null, undefined]) {
      expect(isValidXrplClassicAddress(v)).toBe(false);
    }
  });
  it("encoder requires 20 bytes", () => {
    expect(() => encodeXrplClassicAddress(new Uint8Array(19))).toThrow();
  });
});

describe("flag parsing", () => {
  it("is off by default", () => {
    expect(getXrplRailConfig({})).toMatchObject({ enabled: false, misconfigured: false });
  });
  it("is on only for exactly 'true' + valid payTo; defaults to testnet + x402.org", () => {
    const r = getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO });
    expect(r).toEqual({
      enabled: true,
      config: { network: "xrpl:1", payTo: PAYTO, facilitatorUrl: X402_ORG_FACILITATOR_URL, assetTransferMethod: undefined, initTimeoutMs: 2500 },
    });
  });
  it.each(["TRUE", "True", "1", "yes", " true", "true ", "on", ""])("flag %j is off", (flag) => {
    expect(getXrplRailConfig({ HP_XRPL_ENABLED: flag, HP_XRPL_PAYTO: PAYTO }).enabled).toBe(false);
  });
  it("invalid r-address => off (misconfigured)", () => {
    for (const payTo of [undefined, "", badChecksumAddress(7), "0x5b32c973596078a967562ca652761404f19be0e9", "rNOTANADDRESS", RLUSD_MAINNET_ISSUER]) {
      const r = getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: payTo });
      expect(r).toMatchObject({ enabled: false, misconfigured: true });
    }
  });
  it("mainnet requires an explicit https facilitator URL", () => {
    expect(getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_NETWORK: "xrpl:0" }).enabled).toBe(false);
    expect(
      getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_NETWORK: "xrpl:0", HP_XRPL_FACILITATOR_URL: "http://insecure.example" }).enabled,
    ).toBe(false);
    const r = getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_NETWORK: "mainnet", HP_XRPL_FACILITATOR_URL: "https://facilitator.example/" });
    expect(r).toMatchObject({ enabled: true, config: { network: "xrpl:0", facilitatorUrl: "https://facilitator.example" } });
  });
  it("rejects devnet/unknown networks and bad transfer methods", () => {
    for (const net of ["xrpl:2", "xrpl:9", "eip155:8453", "devnet"]) {
      expect(getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_NETWORK: net }).enabled).toBe(false);
    }
    expect(getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_ASSET_TRANSFER_METHOD: "memo" }).enabled).toBe(false);
    expect(getXrplRailConfig({ HP_XRPL_ENABLED: "true", HP_XRPL_PAYTO: PAYTO, HP_XRPL_ASSET_TRANSFER_METHOD: "ticketSequence" })).toMatchObject({
      enabled: true,
      config: { assetTransferMethod: "ticketSequence" },
    });
  });
});

describe("pricing: same USD price as an RLUSD decimal value (no decimals field)", () => {
  const pairs: [string, string][] = [
    [cfg.PULSE_PRICE_ATOMIC, cfg.PULSE_PRICE_USD],
    [cfg.SIGNALS_PRICE_ATOMIC, cfg.SIGNALS_PRICE_USD],
    [cfg.YIELD_PRICE_ATOMIC, cfg.YIELD_PRICE_USD],
    [cfg.PORTFOLIO_PRICE_ATOMIC, cfg.PORTFOLIO_PRICE_USD],
    [cfg.GAS_PRICE_ATOMIC, cfg.GAS_PRICE_USD],
    [cfg.FUNDING_PRICE_ATOMIC, cfg.FUNDING_PRICE_USD],
    [cfg.FETCH_PRICE_ATOMIC, cfg.FETCH_PRICE_USD],
    [cfg.HTTP_PRICE_ATOMIC, cfg.HTTP_PRICE_USD],
    [cfg.EXTRACT_PRICE_ATOMIC, cfg.EXTRACT_PRICE_USD],
    [cfg.X402_CHECK_PRICE_ATOMIC, cfg.X402_CHECK_PRICE_USD],
    [cfg.SCREENSHOT_PRICE_ATOMIC, cfg.SCREENSHOT_PRICE_USD],
    [cfg.SEARCH_PRICE_ATOMIC, cfg.SEARCH_PRICE_USD],
    [cfg.PDF_PRICE_ATOMIC, cfg.PDF_PRICE_USD],
  ];
  it.each(pairs)("%s atomic -> %s", (atomic, usd) => {
    expect(usdcAtomicToRlusdValue(atomic)).toBe(usd.replace(/^\$/, ""));
  });
  it("edge cases", () => {
    expect(usdcAtomicToRlusdValue("1000000")).toBe("1");
    expect(usdcAtomicToRlusdValue("1500000")).toBe("1.5");
    expect(usdcAtomicToRlusdValue("1")).toBe("0.000001");
    expect(() => usdcAtomicToRlusdValue("0")).toThrow();
    expect(() => usdcAtomicToRlusdValue("1.5")).toThrow();
  });
});

describe("constants match @x402/xrpl 2.27.0", () => {
  it("RLUSD issuer + currency", () => {
    expect(RLUSD_MAINNET_ISSUER).toBe(xrplPkg.RLUSD_MAINNET_ISSUER);
    expect(RLUSD_CURRENCY_HEX).toBe(xrplPkg.RLUSD_CURRENCY);
    expect(xrplPkg.XRPL_MAINNET).toBe("xrpl:0");
    expect(xrplPkg.XRPL_TESTNET).toBe("xrpl:1");
  });
});
