// Beast Steps points engine.
// All gameplay numbers come from config/game-config.json — nothing is hard-coded here,
// so masa can retune tiers, caps, reveal threshold and the monthly pool without code changes.

export function effectiveSteps(rawSteps, tier, config) {
  const t = config.tiers[tier];
  if (!t) throw new Error(`unknown tier: ${tier}`);
  const plausible = Math.min(rawSteps, config.antiCheat.maxPlausibleStepsPerDay);
  return Math.min(plausible, t.dailyStepCap);
}

export function pointsForSteps(rawSteps, tier, config) {
  const t = config.tiers[tier];
  if (!t) throw new Error(`unknown tier: ${tier}`);
  return effectiveSteps(rawSteps, tier, config) * t.efficiency;
}

// A batch is created when a day's steps are synced. Its points drip linearly
// over accrualWindowHours instead of being granted all at once.
export function createAccrualBatch(rawSteps, tier, config, startTimeMs) {
  const totalPoints = pointsForSteps(rawSteps, tier, config);
  const windowMs = config.points.accrualWindowHours * 3600 * 1000;
  return {
    startTimeMs,
    endTimeMs: startTimeMs + windowMs,
    totalPoints,
    rawSteps,
    tier,
  };
}

export function accruedPointsAt(batch, nowMs) {
  if (nowMs <= batch.startTimeMs) return 0;
  if (nowMs >= batch.endTimeMs) return batch.totalPoints;
  const fraction = (nowMs - batch.startTimeMs) / (batch.endTimeMs - batch.startTimeMs);
  return batch.totalPoints * fraction;
}

export function totalAccruedPoints(batches, nowMs) {
  return batches.reduce((sum, b) => sum + accruedPointsAt(b, nowMs), 0);
}

// Monthly distribution: fixed pool split pro-rata by period points.
// Period points reset each period; lifetime points are tracked separately and never reset.
export function distributePool(periodPointsByUser, config) {
  const pool = config.points.monthlyPoolCap;
  const total = Object.values(periodPointsByUser).reduce((a, b) => a + b, 0);
  if (total <= 0) return {};
  const out = {};
  for (const [user, pts] of Object.entries(periodPointsByUser)) {
    out[user] = (pts / total) * pool;
  }
  return out;
}

export function isRevealed(cumulativeSteps, config) {
  return cumulativeSteps >= config.reveal.cumulativeStepsRequired;
}

export function unlockedTipCount(cumulativeSteps, config) {
  return Math.floor(cumulativeSteps / config.tips.unlockEveryCumulativeSteps);
}
