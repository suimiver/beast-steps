// Beast Steps backend API (plain Node http, no framework).
//
// Endpoints:
//   GET  /config            -> game-config.json (the app fetches numbers from here)
//   POST /auth/nonce        { address }            -> { nonce, message }
//   POST /auth/verify       { address, signature } -> { sessionToken, holdings } | 401/403
//   POST /steps             (Bearer session) { date: "YYYY-MM-DD", steps }
//                           -> { equipped, batch } ; one batch per day, and
//                              re-submitting the same day overwrites that day,
//                              so app refreshes never double-count.
//   GET  /points            (Bearer session) -> { periodPoints, lifetimePoints,
//                              lifetimeSteps, revealed, unlockedTips, batches }
//
// State persistence (src/store.mjs): with DATABASE_URL set, nonces, sessions
// and day batches live in Postgres (Neon) and survive restarts; with DATA_FILE
// they live in a local JSON file; with neither, state is in-memory only.
// NFT ownership is re-checked at sign-in and on each steps submission, so
// selling the NFT cuts off further accrual.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyHolder } from "./nft-gate.mjs";
import {
  createAccrualBatch,
  accruedPointsAt,
  effectiveSteps,
  isRevealed,
  unlockedTipCount,
} from "./points-engine.mjs";
import { makeVerifySignature, makeCheckOwnership, signInMessage } from "./chain.mjs";
import { createStoreFromEnv, emptyState } from "./store.mjs";

export function createServer({ config, checkOwnership, verifySignature, store = null, state = null }) {
  const { nonces, sessions, userState } = state ?? emptyState();
  // nonce map: address -> nonce; sessions: token -> { address, holdings };
  // userState: address -> { days: Map<date, { batch, rawSteps }> }

  // Awaited before answering mutating requests: a completed response means
  // the new state has been handed to the storage driver (see store.mjs).
  const persist = async () => {
    if (store) await store.save({ nonces, sessions, userState });
  };

  const stateFor = (address) => {
    if (!userState.has(address)) userState.set(address, { days: new Map() });
    return userState.get(address);
  };

  // "monthly" period -> the batch dates that belong to the current UTC month.
  const currentPeriodPrefix = (nowMs) => {
    const d = new Date(nowMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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
        await persist();
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
        await persist();
        return send(res, 200, { sessionToken, holdings: result.holdings });
      }

      if (req.method === "POST" && url.pathname === "/steps") {
        const session = authed(req);
        if (!session) return send(res, 401, { error: "unauthorized" });
        // Re-check ownership on every submission: a sold NFT stops accrual.
        const holdings = await checkOwnership(session.address);
        if (!holdings || holdings.length === 0) return send(res, 403, { error: "no_nft" });
        const body = await readBody(req);
        const stepCount = Number.isFinite(body.steps) ? body.steps : body.rawSteps;
        if (
          typeof body.date !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(body.date) ||
          !Number.isFinite(stepCount) ||
          stepCount < 0
        ) {
          return send(res, 400, { error: "date_and_steps_required" });
        }
        const equipped = holdings[0];
        const batch = { ...createAccrualBatch(stepCount, equipped.tier, config, Date.now()), date: body.date };
        // One batch per day: resubmitting the same date replaces it (and its
        // 24h drip restarts), so repeated app refreshes never double-count.
        stateFor(session.address).days.set(body.date, { batch, rawSteps: stepCount });
        await persist();
        return send(res, 200, {
          equipped,
          batch: {
            date: body.date,
            rawSteps: stepCount,
            effectiveSteps: effectiveSteps(stepCount, equipped.tier, config),
            pointsAccrued: batch.totalPoints,
            startsAt: batch.startTimeMs,
            endsAt: batch.endTimeMs,
          },
        });
      }

      if (req.method === "GET" && url.pathname === "/points") {
        const session = authed(req);
        if (!session) return send(res, 401, { error: "unauthorized" });
        const state = stateFor(session.address);
        const now = Date.now();
        const periodPrefix = currentPeriodPrefix(now);
        let periodPoints = 0;
        let lifetimePoints = 0;
        let lifetimeSteps = 0;
        const batches = [];
        for (const [date, { batch, rawSteps }] of [...state.days.entries()].sort()) {
          const accrued = accruedPointsAt(batch, now);
          lifetimePoints += accrued;
          if (date.startsWith(periodPrefix)) periodPoints += accrued;
          lifetimeSteps += rawSteps;
          batches.push({
            date,
            rawSteps,
            effectiveSteps: effectiveSteps(rawSteps, batch.tier, config),
            pointsAccrued: batch.totalPoints,
            accruedPoints: accrued,
            startsAt: batch.startTimeMs,
            endsAt: batch.endTimeMs,
          });
        }
        return send(res, 200, {
          address: session.address,
          periodPoints,
          lifetimePoints,
          lifetimeSteps,
          revealed: isRevealed(lifetimeSteps, config),
          unlockedTips: unlockedTipCount(lifetimeSteps, config),
          batches,
        });
      }

      return send(res, 404, { error: "not_found" });
    } catch (e) {
      return send(res, 500, { error: "internal", detail: String(e && e.message || e) });
    }
  });
}

// Standalone entry point: `node src/server.mjs`
// Persistence is chosen from the environment (DATABASE_URL -> Postgres,
// DATA_FILE -> JSON file, neither -> in-memory); see src/store.mjs.
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = JSON.parse(readFileSync(new URL("../../config/game-config.json", import.meta.url)));
  const rpcUrl = process.env.RPC_URL || "http://127.0.0.1:8545";
  const contractAddress = process.env.NFT_CONTRACT_ADDRESS;
  if (!contractAddress) {
    console.error("NFT_CONTRACT_ADDRESS env is required");
    process.exit(1);
  }
  const store = createStoreFromEnv();
  const state = await store.load();
  const server = createServer({
    config,
    checkOwnership: makeCheckOwnership({ rpcUrl, contractAddress }),
    verifySignature: makeVerifySignature(),
    store,
    state,
  });
  const port = Number(process.env.PORT || 8787);
  server.listen(port, () =>
    console.log(
      `Beast Steps backend on :${port} (rpc ${rpcUrl}, nft ${contractAddress}, store: ${store.kind})`,
    ),
  );
}
