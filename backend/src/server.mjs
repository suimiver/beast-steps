// Beast Steps backend API (plain Node http, no framework).
//
// Endpoints:
//   GET  /config            -> game-config.json (the app fetches numbers from here)
//   POST /auth/nonce        { address }            -> { nonce, message }
//   POST /auth/verify       { address, signature } -> { sessionToken, holdings } | 401/403
//   POST /steps             (Bearer session) { rawSteps } -> accrual batch summary
//   GET  /points            (Bearer session) -> accrued points, reveal progress, tips
//
// State is in-memory for now (dev stage); sessions/batches move to a real DB
// before production. NFT ownership is re-checked at sign-in and on each steps
// submission, so selling the NFT cuts off further accrual.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyHolder } from "./nft-gate.mjs";
import {
  createAccrualBatch,
  totalAccruedPoints,
  isRevealed,
  unlockedTipCount,
} from "./points-engine.mjs";
import { makeVerifySignature, makeCheckOwnership, signInMessage } from "./chain.mjs";

export function createServer({ config, checkOwnership, verifySignature }) {
  const nonces = new Map(); // address -> nonce
  const sessions = new Map(); // token -> { address, holdings }
  const userState = new Map(); // address -> { batches: [], lifetimeSteps: number }

  const stateFor = (address) => {
    if (!userState.has(address)) userState.set(address, { batches: [], lifetimeSteps: 0 });
    return userState.get(address);
  };

  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(e);
        }
      });
    });

  const send = (res, code, obj) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(obj));
  };

  const authed = (req) => {
    const token = (req.headers.authorization || "").replace(/^Bearer /, "");
    return sessions.get(token) || null;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && url.pathname === "/") {
        return send(res, 200, { ok: true, service: "beast-steps-backend" });
      }

      if (req.method === "GET" && url.pathname === "/config") {
        return send(res, 200, config);
      }

      if (req.method === "POST" && url.pathname === "/auth/nonce") {
        const { address } = await readBody(req);
        if (!address) return send(res, 400, { error: "address_required" });
        const nonce = randomBytes(16).toString("hex");
        nonces.set(address.toLowerCase(), nonce);
        return send(res, 200, { nonce, message: signInMessage(address, nonce) });
      }

      if (req.method === "POST" && url.pathname === "/auth/verify") {
        const { address, signature } = await readBody(req);
        const nonce = address ? nonces.get(address.toLowerCase()) : null;
        if (!nonce) return send(res, 400, { error: "nonce_not_requested" });
        const result = await verifyHolder({ address, signature, nonce, checkOwnership, verifySignature });
        if (!result.ok) {
          const code = result.reason === "no_nft" ? 403 : 401;
          return send(res, code, { error: result.reason });
        }
        nonces.delete(address.toLowerCase());
        const sessionToken = randomBytes(24).toString("hex");
        sessions.set(sessionToken, { address, holdings: result.holdings });
        return send(res, 200, { sessionToken, holdings: result.holdings });
      }

      if (req.method === "POST" && url.pathname === "/steps") {
        const session = authed(req);
        if (!session) return send(res, 401, { error: "unauthorized" });
        // Re-check ownership on every submission: a sold NFT stops accrual.
        const holdings = await checkOwnership(session.address);
        if (!holdings || holdings.length === 0) return send(res, 403, { error: "no_nft" });
        const { rawSteps } = await readBody(req);
        if (!Number.isFinite(rawSteps) || rawSteps < 0) return send(res, 400, { error: "rawSteps_required" });
        const equipped = holdings[0];
        const batch = createAccrualBatch(rawSteps, equipped.tier, config, Date.now());
        const state = stateFor(session.address);
        state.batches.push(batch);
        state.lifetimeSteps += rawSteps;
        return send(res, 200, {
          equipped,
          batchTotalPoints: batch.totalPoints,
          effectiveSteps: Math.round(batch.totalPoints / config.tiers[equipped.tier].efficiency),
          accrualEndsAt: batch.endTimeMs,
        });
      }

      if (req.method === "GET" && url.pathname === "/points") {
        const session = authed(req);
        if (!session) return send(res, 401, { error: "unauthorized" });
        const state = stateFor(session.address);
        const now = Date.now();
        return send(res, 200, {
          address: session.address,
          accruedPoints: totalAccruedPoints(state.batches, now),
          lifetimeSteps: state.lifetimeSteps,
          revealed: isRevealed(state.lifetimeSteps, config),
          unlockedTips: unlockedTipCount(state.lifetimeSteps, config),
        });
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      return send(res, 500, { error: "internal", detail: String(e && e.message || e) });
    }
  });
}

// Standalone entry point: `node src/server.mjs`
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(readFileSync(new URL("../../config/game-config.json", import.meta.url)));
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const contractAddress = process.env.NFT_CONTRACT_ADDRESS;
  if (!contractAddress) {
    console.error("NFT_CONTRACT_ADDRESS env is required");
    process.exit(1);
  }
  const server = createServer({
    config,
    checkOwnership: makeCheckOwnership({ rpcUrl, contractAddress }),
    verifySignature: makeVerifySignature(),
  });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () => console.log(`Beast Steps backend on :${port} (rpc ${rpcUrl}, nft ${contractAddress})`));
}
