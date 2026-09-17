import { createPublicClient, http, formatUnits, erc20Abi } from "viem";
import { base } from "viem/chains";
import { getPayTo, USDC_BASE } from "./config";

export type TreasuryBalance = {
  payTo: `0x${string}`;
  asset: typeof USDC_BASE;
  network: "base";
  balanceAtomic: string;
  balanceUsdc: string;
  rpc: string;
  fetchedAt: string;
};

export async function fetchTreasuryUsdcBalance(): Promise<TreasuryBalance> {
  const payTo = getPayTo();
  const rpc =
    process.env.BASE_RPC_URL?.trim() || "https://mainnet.base.org";

  const client = createPublicClient({
    chain: base,
    transport: http(rpc, { timeout: 12_000 }),
  });

  const raw = await client.readContract({
    address: USDC_BASE,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [payTo],
  });

  return {
    payTo,
    asset: USDC_BASE,
    network: "base",
    balanceAtomic: raw.toString(),
    balanceUsdc: formatUnits(raw, 6),
    rpc,
    fetchedAt: new Date().toISOString(),
  };
}
