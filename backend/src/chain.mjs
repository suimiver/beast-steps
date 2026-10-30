// Real chain access for the NFT gate, built on ethers v6.
// The message format below is the contract between app and backend: the app asks
// the wallet to sign exactly this string (via WalletConnect), the backend recovers
// the signer from it. No seed phrases, no approvals, no gas for the user.
import { ethers } from "ethers";

export const NFT_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function ownerOf(uint256) view returns (address)",
  "function tierOf(uint256) view returns (string)",
  "function nextTokenId() view returns (uint256)",
];

export function signInMessage(address, nonce) {
  return `Beast Steps sign-in\nAddress: ${address}\nNonce: ${nonce}`;
}

export function makeVerifySignature() {
  return async ({ address, signature, nonce }) => {
    try {
      return ethers.verifyMessage(signInMessage(address, nonce), signature);
    } catch {
      return null;
    }
  };
}

// Mock contract has no enumeration extension, so holdings are found by scanning
// token ids 1..nextTokenId-1. Fine at mock scale; the real NFT will be read via
// an indexer or Transfer-event scan instead — the gate's interface won't change.
export function makeCheckOwnership({ rpcUrl, contractAddress }) {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const contract = new ethers.Contract(contractAddress, NFT_ABI, provider);
  return async (address) => {
    const balance = await contract.balanceOf(address);
    if (balance === 0n) return [];
    const next = Number(await contract.nextTokenId());
    const holdings = [];
    for (let tokenId = 1; tokenId < next; tokenId++) {
      if ((await contract.ownerOf(tokenId)).toLowerCase() === address.toLowerCase()) {
        holdings.push({ tokenId, tier: await contract.tierOf(tokenId) });
        if (holdings.length >= Number(balance)) break;
      }
    }
    return holdings;
  };
}
