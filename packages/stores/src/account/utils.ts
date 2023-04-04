import { ChainName, Endpoints, Logger } from "@cosmos-kit/core";
import { chains } from "chain-registry";

interface AccountMsgOpt {
  shareCoinDecimals?: number;
  gas: number;
}

export const createMsgOpts = <Dict extends Record<string, AccountMsgOpt>>(
  dict: Dict
) => dict;

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const logger = new Logger("WARN");

export const endpoints = chains.reduce((endpoints, chain) => {
  const newEndpoints: Record<ChainName, Endpoints> = {
    ...endpoints,
    [chain.chain_name]: {
      rpc: chain.apis?.rpc?.map(({ address }) => address) ?? [],
      rest: chain.apis?.rest?.map(({ address }) => address) ?? [],
      isLazy: true,
    },
  };
  return newEndpoints;
}, {} as Record<ChainName, Endpoints>);

export const CosmosKitLocalStorageKey = "cosmos-kit@1:core//accounts";
