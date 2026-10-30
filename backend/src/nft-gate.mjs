// NFT gate (backend is the source of truth — never trust the app alone for this).
//
// Intended production flow:
// 1. App connects a wallet via WalletConnect and requests a one-time nonce from the backend.
// 2. User signs the nonce message in their wallet (SIWE-style). No seed phrase, no token approval, no gas.
// 3. Backend verifies the signature recovers the claimed address.
// 4. Backend checks on-chain (Base RPC, ERC-721 balanceOf / ownerOf) that the address
//    holds the Beast Steps NFT, and reads which token is equipped.
// 5. Backend issues a session token. Ownership is re-checked periodically and on
//    sensitive actions, so selling the NFT revokes access.
//
// `checkOwnership` is injected so tests and the mock NFT can run without a live RPC.

export async function verifyHolder({ address, signature, nonce, checkOwnership, verifySignature }) {
  const recovered = await verifySignature({ address, signature, nonce });
  if (!recovered || recovered.toLowerCase() !== address.toLowerCase()) {
    return { ok: false, reason: "signature_mismatch" };
  }
  const holdings = await checkOwnership(address);
  if (!holdings || holdings.length === 0) {
    return { ok: false, reason: "no_nft" };
  }
  return { ok: true, address, holdings };
}
