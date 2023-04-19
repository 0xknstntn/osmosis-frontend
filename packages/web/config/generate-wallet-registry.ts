/* eslint-disable import/no-extraneous-dependencies */
import type { Wallet } from "@cosmos-kit/core";
import { cosmostationExtensionInfo } from "@cosmos-kit/cosmostation-extension";
import { cosmostationMobileInfo } from "@cosmos-kit/cosmostation-mobile";
import { frontierExtensionInfo } from "@cosmos-kit/frontier-extension";
import { keplrExtensionInfo } from "@cosmos-kit/keplr-extension";
import { keplrMobileInfo } from "@cosmos-kit/keplr-mobile";
import { leapExtensionInfo } from "@cosmos-kit/leap-extension";
import { omniMobileInfo } from "@cosmos-kit/omni-mobile";
import { terrastationExtensionInfo } from "@cosmos-kit/terrastation-extension";
import { trustMobileInfo } from "@cosmos-kit/trust-mobile";
import { xdefiExtensionInfo } from "@cosmos-kit/xdefi-extension";
import * as fs from "fs";
import * as prettier from "prettier";

const WalletRegistry: (Wallet & {
  lazyInstallUrl: string;
  walletClassName: string;
})[] = [
  {
    ...keplrExtensionInfo,
    logo: "/wallets/keplr.svg",
    lazyInstallUrl: "@cosmos-kit/keplr-extension",
    walletClassName: "KeplrExtensionWallet",
  },
  {
    ...keplrMobileInfo,
    logo: "/wallets/keplr.svg",
    lazyInstallUrl: "@cosmos-kit/keplr-mobile",
    walletClassName: "KeplrMobileWallet",
  },
  {
    ...leapExtensionInfo,
    logo: "/wallets/leap.png",
    lazyInstallUrl: "@cosmos-kit/leap-extension",
    walletClassName: "LeapExtensionWallet",
  },
  {
    ...cosmostationExtensionInfo,
    logo: "/wallets/cosmostation.png",
    lazyInstallUrl: "@cosmos-kit/cosmostation-extension",
    walletClassName: "CosmostationExtensionWallet",
  },
  {
    ...cosmostationMobileInfo,
    logo: "/wallets/cosmostation.png",
    lazyInstallUrl: "@cosmos-kit/cosmostation-mobile",
    walletClassName: "CosmostationMobileWallet",
  },
  {
    ...frontierExtensionInfo,
    logo: "/wallets/frontier.png",
    lazyInstallUrl: "@cosmos-kit/frontier-extension",
    walletClassName: "FrontierExtensionWallet",
  },

  {
    ...terrastationExtensionInfo,
    logo: "/wallets/terrastation.svg",
    lazyInstallUrl: "@cosmos-kit/terrastation-extension",
    walletClassName: "TerrastationExtensionWallet",
  },
  {
    ...trustMobileInfo,
    logo: "/wallets/trust.png",
    lazyInstallUrl: "@cosmos-kit/trust-mobile",
    walletClassName: "TrustMobileWallet",
  },
  {
    ...xdefiExtensionInfo,
    logo: "/wallets/xdefi.png",
    lazyInstallUrl: "@cosmos-kit/xdefi-extension",
    walletClassName: "XDEFIExtensionWallet",
  },
  {
    ...omniMobileInfo,
    logo: "/wallets/omni.webp",
    lazyInstallUrl: "@cosmos-kit/omni-mobile",
    walletClassName: "OmniMobileWallet",
  },
];

/**
 * Convert a wallet object to a stringified version. It replaces the lazyInstallUrl with a function
 * to lazy load the wallet. We avoid JSON.stringify because it can't serialize functions.
 * @param wallet Wallet object
 * @example
 * {
 *  ...walletData,
 *  lazyInstall: () => import("wallet-lazy-install-url").then(m => m.wallets),
 * }
 */
const getStringifiedWallet = (wallet: (typeof WalletRegistry)[number]) => {
  const body = Object.entries(wallet).reduce((acc, [key, value]) => {
    if (key === "walletClassName") return acc;
    if (key === "lazyInstallUrl") {
      return `${acc}lazyInstall: () => import("${value}").then(m => m.${wallet.walletClassName}),`;
    }
    return `${acc}${key}: ${JSON.stringify(value)},`;
  }, "");
  return "{" + body + "}";
};

/**
 * Generate a TypeScript file called wallet-registry.ts containing all approved wallets.
 * We need to generate the file in order to not include wallets size in our main bundle.
 */
async function generateWalletRegistry() {
  const content = `  
      /* eslint-disable import/no-extraneous-dependencies */
      import type { Wallet } from "@cosmos-kit/core";
      export const WalletRegistry: (Wallet & { lazyInstall: Function })[] = [${WalletRegistry.map(
        getStringifiedWallet
      ).join(",")}];
    `;

  const prettierConfig = await prettier.resolveConfig("./");
  const formatted = prettier.format(content, {
    ...prettierConfig,
    parser: "typescript",
  });

  try {
    fs.writeFileSync("config/wallet-registry.ts", formatted, {
      encoding: "utf8",
      flag: "w",
    });
    console.log("Successfully wrote wallet-registry.ts");
  } catch (e) {
    console.log(`Error writing wallet-registry.ts: ${e}`);
  }
}

generateWalletRegistry().catch((e) => {
  console.error(e);
  process.exit(1);
});
