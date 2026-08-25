import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Terminal, Play, Square, Loader2, Download, Trash2, Upload,
  Pickaxe, Zap, AlertTriangle, Brain, RefreshCw,
  TrendingUp, TrendingDown, Minus, Target, Server, Plus, X, Bell, BellOff, List,
  Copy,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

// ─── Constants ────────────────────────────────────────────────────────────────
const MAX_LOGS  = 2000;
const MAX_BATCH = 50;
const MIN_BATCH = 1;
// Phase thresholds (cards checked per BIN)
const PHASE_PROBING    = 20;   // not enough data yet
const PHASE_TRAINING   = 80;   // building confidence
// >= TRAINING threshold → OPTIMIZED

// ─── Types ────────────────────────────────────────────────────────────────────
/** Per-BIN state tracked by the UCB1 trainer */
interface BinTrainer {
  bin:       string;
  tries:     number;   // total cards checked against this BIN
  hits:      number;   // live cards found
  luhnPass:  number;   // cards that passed client-side Luhn validation
  luhnFail:  number;   // cards that failed client-side Luhn (generator bug guard)
  weight:    number;   // normalised selection probability 0–1
  fitness:   number;   // raw UCB1 score
  trend:     "rising" | "falling" | "stable" | "new";
  prevRate:  number;   // hit rate at previous epoch (for trend)
  phase:     "probing" | "training" | "optimized";
}

// ─── Luhn (client-side double-check) ─────────────────────────────────────────
function luhnCheck(num: string): boolean {
  let sum = 0, double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

// ─── UCB1 adaptive selector ───────────────────────────────────────────────────
/**
 * Upper Confidence Bound 1 score.
 * Balances exploitation (high hit rate) with exploration (few tries → high bonus).
 * Un-tried BINs return Infinity so they're always explored first.
 */
function ucb1(t: BinTrainer, totalRounds: number): number {
  if (t.tries === 0) return Number.MAX_SAFE_INTEGER;
  const exploitation = t.hits / t.tries;
  const exploration  = Math.sqrt(2 * Math.log(Math.max(totalRounds, 1)) / t.tries);
  return exploitation + exploration;
}

/** Pick the BIN with the highest UCB1 score this round */
function selectTrainer(trainers: BinTrainer[], totalRounds: number): BinTrainer {
  return trainers.reduce((best, t) =>
    ucb1(t, totalRounds) > ucb1(best, totalRounds) ? t : best
  );
}

/** Recompute weights + trend + phase for all trainers after each batch */
function recomputeTrainers(
  trainers: BinTrainer[],
  totalRounds: number,
  updates: Record<string, { tries: number; hits: number; luhnPass: number; luhnFail: number }>,
): BinTrainer[] {
  const updated = trainers.map(t => {
    const u = updates[t.bin];
    if (!u) return t;
    const newTries = t.tries + u.tries;
    const newHits  = t.hits  + u.hits;
    const newRate  = newTries > 0 ? newHits / newTries : 0;
    const trend: BinTrainer["trend"] =
      newTries < PHASE_PROBING ? "new" :
      newRate > t.prevRate + 0.008 ? "rising" :
      newRate < t.prevRate - 0.008 ? "falling" : "stable";
    const phase: BinTrainer["phase"] =
      newTries < PHASE_PROBING  ? "probing" :
      newTries < PHASE_TRAINING ? "training" : "optimized";
    return {
      ...t,
      tries:    newTries,
      hits:     newHits,
      luhnPass: t.luhnPass + u.luhnPass,
      luhnFail: t.luhnFail + u.luhnFail,
      prevRate: newRate,
      trend,
      phase,
    };
  });

  // Compute fitness + normalised weights
  const scores = updated.map(t => ucb1(t, totalRounds));
  const total  = scores.reduce((a, b) => (isFinite(b) ? a + b : a), 0);
  return updated.map((t, i) => ({
    ...t,
    fitness: scores[i],
    weight:  isFinite(scores[i]) && total > 0 ? scores[i] / total : 1 / updated.length,
  }));
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function parseBins(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map(l => l.trim().replace(/\D/g, ""))
    .filter(b => b.length >= 6 && b.length <= 9);
}

function formatCpm(cpm: number): string {
  if (cpm < 1)     return "< 1/min";
  if (cpm >= 1000) return `${(cpm / 1000).toFixed(1)}k/min`;
  return `${Math.round(cpm)}/min`;
}

function pctStr(hits: number, tries: number): string {
  return tries > 0 ? ((hits / tries) * 100).toFixed(2) + "%" : "–";
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// ─── Server Miner panel ───────────────────────────────────────────────────────
function ServerMinerPanel() {
  const { toast }      = useToast();
  const queryClient    = useQueryClient();
  const [newBin, setNewBin] = useState("");
  const [massBinMode, setMassBinMode] = useState(false);
  const [massBinText, setMassBinText] = useState("");

  const { data: miner, isLoading } = useQuery<any>({
    queryKey: ["/api/miner"],
    refetchInterval: (query) => (query.state.data?.isRunning ? 2000 : false),
  });
  const { data: gatesData } = useQuery<any[]>({ queryKey: ["/api/gates"] });
  const gates = (gatesData || []).filter((g: any) => g.active);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/miner"] });

  const startMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/miner/start").then(r => r.json()),
    onSuccess: (d: any) => { if (d?.message) toast({ title: "Cannot Start", description: d.message, variant: "destructive" }); invalidate(); },
    onError:   (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const stopMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/miner/stop").then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  const updateMut = useMutation({
    mutationFn: (data: Record<string, any>) => apiRequest("PUT", "/api/miner", data).then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  const addBinMut = useMutation({
    mutationFn: (bin: string) => apiRequest("POST", "/api/miner/bins", { bin }).then(r => r.json()),
    onSuccess: () => { setNewBin(""); invalidate(); },
    onError: (e: any) => toast({ title: "Cannot add BIN", description: e.message, variant: "destructive" }),
  });

  const removeBinMut = useMutation({
    mutationFn: (bin: string) => apiRequest("DELETE", "/api/miner/bins", { bin }).then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  const bulkBinMut = useMutation({
    mutationFn: (bins: string) => apiRequest("POST", "/api/miner/bins/bulk", { bins }).then(r => r.json()),
    onSuccess: (d: any) => {
      setMassBinText("");
      setMassBinMode(false);
      invalidate();
      toast({ title: "BINs Imported", description: `Added ${d.added} BIN(s)${d.duplicates > 0 ? `, ${d.duplicates} duplicate(s) skipped` : ""}` });
    },
    onError: (e: any) => toast({ title: "Import Failed", description: e.message, variant: "destructive" }),
  });

  const clearAllBinsMut = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/miner/bins/all").then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  if (isLoading || !miner) return null;

  const bins      = (miner.binList as string[]) || [];
  const running   = miner.isRunning as boolean;
  const rate      = miner.totalTried > 0
    ? ((miner.totalApproved / miner.totalTried) * 100).toFixed(2) : "0.00";

  return (
    <Card className="glass-panel rounded-none border-2 border-primary/30">
      <CardHeader className="border-b border-white/[0.06] py-3">
        <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
          <Server className="w-4 h-4 text-primary" />
          Server Miner
          <span className={`ml-2 text-xs font-mono font-normal px-2 py-0.5 border ${running ? "text-green-400 border-green-500/40 bg-green-500/10 animate-pulse" : "text-muted-foreground border-white/10"}`}>
            {running ? "● RUNNING" : "○ STOPPED"}
          </span>
          {running && (
            <span className="ml-auto text-[10px] font-mono font-normal text-muted-foreground">
              Current BIN: <span className="text-primary">{miner.currentBin || "—"}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {/* Stats strip */}
        {(miner.totalTried > 0 || running) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 text-center font-mono">
            {[
              { label: "TRIED",    value: miner.totalTried,    color: "text-muted-foreground" },
              { label: "LIVE",     value: miner.totalApproved, color: "text-green-400 font-bold" },
              { label: "RATE",     value: `${rate}%`,          color: miner.totalApproved > 0 ? "text-primary font-bold" : "text-muted-foreground" },
              { label: "DELAY",    value: `${miner.delaySecs}s`, color: "text-muted-foreground" },
            ].map(s => (
              <div key={s.label} className="border border-white/[0.06] bg-white/[0.02] py-1.5 sm:py-2">
                <div className={`text-xs sm:text-sm ${s.color}`}>{s.value}</div>
                <div className="text-[8px] sm:text-[9px] text-muted-foreground/40 mt-0.5 tracking-widest">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Gate + settings row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="sm:col-span-2">
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Gate</Label>
            <Select
              value={miner.gateId || ""}
              onValueChange={v => updateMut.mutate({ gateId: v })}
              disabled={running}
            >
              <SelectTrigger className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9">
                <SelectValue placeholder="— Select gate —" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random Rotation (per card)</SelectItem>
                {gates.map((g: any) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                    <span className="opacity-40 ml-1 text-[10px]">({g.gateType})</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Delay (s)</Label>
            <Input
              type="number" min="1" max="60"
              defaultValue={miner.delaySecs}
              disabled={running}
              onBlur={e => updateMut.mutate({ delaySecs: parseInt(e.target.value) || 3 })}
              className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
            />
          </div>
        </div>

        {/* Max per BIN + parallel gates */}
        <div className="grid grid-cols-3 gap-3 items-end">
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Max / BIN</Label>
            <Input
              type="number" min="1" max="500"
              defaultValue={miner.maxCardsPerBin}
              disabled={running}
              onBlur={e => updateMut.mutate({ maxCardsPerBin: parseInt(e.target.value) || 50 })}
              className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
            />
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Parallel Gates</Label>
            <Input
              type="number" min="1" max="5"
              defaultValue={miner.parallelGates ?? 1}
              disabled={running}
              onBlur={e => updateMut.mutate({ parallelGates: parseInt(e.target.value) || 1 })}
              className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
            />
            <p className="text-[9px] text-muted-foreground/35 mt-0.5 font-mono">gates/card</p>
          </div>
          <div className="flex items-center gap-3 border border-primary/20 p-2 h-9">
            {miner.notifyEnabled
              ? <Bell className="w-4 h-4 text-primary" />
              : <BellOff className="w-4 h-4 text-muted-foreground" />}
            <span className="font-mono text-xs text-muted-foreground">Notify</span>
            <Switch
              checked={miner.notifyEnabled}
              onCheckedChange={v => updateMut.mutate({ notifyEnabled: v })}
              className="ml-auto"
            />
          </div>
        </div>

        {/* BIN manager */}
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider">
              BINs ({bins.length})
            </Label>
            {!running && (
              <div className="flex items-center gap-1">
                {bins.length > 0 && (
                  <button
                    onClick={() => clearAllBinsMut.mutate()}
                    className="text-[9px] font-mono text-destructive/50 hover:text-destructive tracking-wider"
                  >
                    CLEAR ALL
                  </button>
                )}
                <span className="text-muted-foreground/20 mx-1">|</span>
                <button
                  onClick={() => setMassBinMode(!massBinMode)}
                  className={`text-[9px] font-mono tracking-wider flex items-center gap-1 ${massBinMode ? "text-primary" : "text-muted-foreground/50 hover:text-muted-foreground"}`}
                >
                  <List className="w-3 h-3" />
                  {massBinMode ? "SINGLE MODE" : "MASS IMPORT"}
                </button>
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-1.5 min-h-[32px] border border-white/[0.06] bg-background/30 p-2 mb-2">
            {bins.length === 0 && (
              <span className="text-[10px] text-muted-foreground/30 font-mono self-center">No BINs — add below or use Mass Import</span>
            )}
            {bins.map(bin => (
              <span
                key={bin}
                className="inline-flex items-center gap-1 bg-primary/10 border border-primary/30 text-primary font-mono text-[11px] px-1.5 py-0.5"
              >
                {bin}
                {!running && (
                  <button
                    onClick={() => removeBinMut.mutate(bin)}
                    className="text-muted-foreground hover:text-destructive ml-0.5"
                  >
                    <X className="w-3 h-3" />
                  </button>
                )}
              </span>
            ))}
          </div>
          {!running && !massBinMode && (
            <div className="flex gap-2">
              <Input
                placeholder="Add BIN (6+ digits)"
                value={newBin}
                onChange={e => setNewBin(e.target.value.replace(/\D/g, ""))}
                onKeyDown={e => { if (e.key === "Enter" && newBin.length >= 6) addBinMut.mutate(newBin); }}
                maxLength={9}
                className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9 flex-1"
              />
              <Button
                onClick={() => addBinMut.mutate(newBin)}
                disabled={newBin.length < 6 || addBinMut.isPending}
                size="sm"
                className="rounded-none border border-primary/50 text-primary bg-primary/10 hover:bg-primary hover:text-black h-9 px-3"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
          )}
          {!running && massBinMode && (
            <div className="space-y-2">
              <Textarea
                className="h-28 resize-none bg-background/50 rounded-none border-white/[0.08] font-mono text-sm focus-visible:ring-primary text-primary placeholder:text-muted-foreground/25"
                placeholder={"Paste BINs here (one per line)\n453211\n523456\n411111\n622588\n\nAlso accepts comma/space separated"}
                value={massBinText}
                onChange={e => setMassBinText(e.target.value)}
              />
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-mono text-muted-foreground/40">
                  {(() => {
                    const parsed = massBinText.split(/[\r\n,;|\t ]+/).map(b => b.trim().replace(/\D/g, "")).filter(b => b.length >= 6 && b.length <= 9);
                    return parsed.length > 0 ? `${parsed.length} valid BIN(s) detected` : "No valid BINs yet";
                  })()}
                </span>
                <Button
                  onClick={() => bulkBinMut.mutate(massBinText)}
                  disabled={bulkBinMut.isPending || !massBinText.trim()}
                  size="sm"
                  className="rounded-none border border-primary/50 text-primary bg-primary/10 hover:bg-primary hover:text-black h-8 px-4 font-mono text-xs"
                >
                  {bulkBinMut.isPending ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Upload className="w-3 h-3 mr-1.5" />}
                  IMPORT ALL
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Start / Stop */}
        <div className="grid grid-cols-2 gap-3">
          <Button
            onClick={() => startMut.mutate()}
            disabled={running || startMut.isPending || !miner.gateId || bins.length === 0}
            className="rounded-none font-display font-bold tracking-widest bg-primary text-black hover:bg-primary hover:text-black"
          >
            {startMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            START SERVER
          </Button>
          <Button
            onClick={() => stopMut.mutate()}
            disabled={!running || stopMut.isPending}
            variant="outline"
            className="rounded-none font-display font-bold tracking-widest border-destructive/30 text-destructive hover:bg-destructive/10"
          >
            <Square className="w-4 h-4 mr-2" /> STOP SERVER
          </Button>
        </div>

        <p className="text-[10px] font-mono text-muted-foreground/40 text-center">
          Server miner runs 24/7 even when browser is closed · Control via Telegram /miner
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Range Miner panel ───────────────────────────────────────────────────────
function RangeMinerPanel() {
  const { toast }      = useToast();
  const queryClient    = useQueryClient();
  const [startBin, setStartBin]   = useState("");
  const [endBin, setEndBin]       = useState("");

  const { data: mine, isLoading } = useQuery<any>({
    queryKey: ["/api/mine"],
    refetchInterval: (query) => (query.state.data?.isRunning ? 2000 : false),
  });
  const { data: gatesData } = useQuery<any[]>({ queryKey: ["/api/gates"] });
  const gates = (gatesData || []).filter((g: any) => g.active);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/mine"] });

  const updateMut = useMutation({
    mutationFn: (data: Record<string, any>) => apiRequest("PUT", "/api/mine", data).then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  const startMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/mine/start").then(r => r.json()),
    onSuccess: (d: any) => { if (d?.message) toast({ title: "Cannot Start", description: d.message, variant: "destructive" }); invalidate(); },
    onError:   (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const stopMut = useMutation({
    mutationFn: () => apiRequest("POST", "/api/mine/stop").then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  const addBinMut = useMutation({
    mutationFn: (bin: string) => apiRequest("POST", "/api/mine/bin", { bin }).then(r => r.json()),
    onSuccess: () => { setStartBin(""); invalidate(); },
    onError: (e: any) => toast({ title: "Cannot add BIN", description: e.message, variant: "destructive" }),
  });

  const removeBinMut = useMutation({
    mutationFn: (bin: string) => apiRequest("DELETE", "/api/mine/bin", { bin }).then(r => r.json()),
    onSuccess: () => invalidate(),
  });

  if (isLoading || !mine) return null;

  const running    = mine.isRunning as boolean;
  const range      = mine.startBin && mine.endBin ? `${mine.startBin}→${mine.endBin}` : "Not set";
  const extraBins  = (mine.extraBins as string[]) || [];
  const rate       = mine.totalTried > 0 ? ((mine.totalApproved / mine.totalTried) * 100).toFixed(2) : "0.00";
  const gateLabel  = mine.gateName || (mine.gateId === "random" ? "Random" : "Not set");

  const TYPE_FILTERS = ["all", "credit", "prepaid", "debit"] as const;

  return (
    <Card className="glass-panel rounded-none border-2 border-accent/30">
      <CardHeader className="border-b border-accent/20 bg-accent/5 py-3">
        <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
          <Target className="w-5 h-5 text-accent" />
          Range Miner
          <span className={`ml-2 text-xs font-mono font-normal px-2 py-0.5 border ${running ? "text-green-400 border-green-500/40 bg-green-500/10 animate-pulse" : "text-muted-foreground border-white/10"}`}>
            {running ? "● RUNNING" : "○ STOPPED"}
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="p-4 space-y-4">
        {/* Stats strip */}
        {(mine.totalTried > 0 || running) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2 text-center font-mono">
            {[
              { label: "TRIED",  value: mine.totalTried,    color: "text-muted-foreground" },
              { label: "LIVE",   value: mine.totalApproved, color: "text-green-400 font-bold" },
              { label: "RATE",   value: `${rate}%`,         color: mine.totalApproved > 0 ? "text-accent font-bold" : "text-muted-foreground" },
              { label: "RANGE",  value: range,              color: "text-accent text-[9px] sm:text-[10px]" },
            ].map(s => (
              <div key={s.label} className="border border-white/[0.06] bg-white/[0.02] py-1.5 sm:py-2">
                <div className={`text-xs sm:text-sm ${s.color}`}>{s.value}</div>
                <div className="text-[8px] sm:text-[9px] text-muted-foreground/40 mt-0.5 tracking-widest">{s.label}</div>
              </div>
            ))}
          </div>
        )}

        {/* BIN Range */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Start BIN (4-16 digits)</Label>
            <Input
              placeholder="400000"
              value={startBin}
              onChange={e => setStartBin(e.target.value.replace(/\D/g, "").slice(0, 16))}
              disabled={running}
              className="rounded-none border-accent/30 bg-background font-mono text-sm h-9"
            />
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">End BIN (4-16 digits)</Label>
            <Input
              placeholder="400010"
              value={endBin}
              onChange={e => setEndBin(e.target.value.replace(/\D/g, "").slice(0, 16))}
              disabled={running}
              className="rounded-none border-accent/30 bg-background font-mono text-sm h-9"
            />
          </div>
        </div>
        {!running && startBin && endBin && (
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground/50">
              {(() => {
                const maxLen = Math.max(startBin.length, endBin.length);
                const s = parseInt(startBin.padEnd(maxLen, "0"), 10);
                const e = parseInt(endBin.padEnd(maxLen, "0"), 10);
                const count = e - s + 1;
                return count > 0 && count <= 500 ? `${count} BINs will be generated` : count > 500 ? "Range too large (max 500)" : "";
              })()}
            </span>
            <Button
              size="sm"
              disabled={!startBin || !endBin || addBinMut.isPending}
              onClick={() => { updateMut.mutate({ startBin, endBin }); setStartBin(""); setEndBin(""); }}
              className="rounded-none border border-accent/50 text-accent bg-accent/10 hover:bg-accent hover:text-black h-7 px-3 font-mono text-[10px]"
            >
              SET RANGE
            </Button>
          </div>
        )}

        {/* Expiry + Type + Gate */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Month</Label>
            <Select value={mine.month || "random"} onValueChange={v => updateMut.mutate({ month: v })} disabled={running}>
              <SelectTrigger className="rounded-none border-accent/30 bg-background font-mono text-sm h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random</SelectItem>
                {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map(m => (
                  <SelectItem key={m} value={m}>{m}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Year</Label>
            <Select value={mine.year || "random"} onValueChange={v => updateMut.mutate({ year: v })} disabled={running}>
              <SelectTrigger className="rounded-none border-accent/30 bg-background font-mono text-sm h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random</SelectItem>
                {[2024, 2025, 2026, 2027, 2028, 2029, 2030].map(y => (
                  <SelectItem key={y} value={String(y)}>{y}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Type</Label>
            <Select value={mine.typeFilter || "all"} onValueChange={v => updateMut.mutate({ typeFilter: v })} disabled={running}>
              <SelectTrigger className="rounded-none border-accent/30 bg-background font-mono text-sm h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_FILTERS.map(t => (
                  <SelectItem key={t} value={t}>{t.toUpperCase()}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Gate</Label>
            <Select value={mine.gateId || "random"} onValueChange={v => updateMut.mutate({ gateId: v })} disabled={running}>
              <SelectTrigger className="rounded-none border-accent/30 bg-background font-mono text-sm h-9">
                <SelectValue placeholder="Select gate" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="random">Random Rotation</SelectItem>
                {gates.map((g: any) => (
                  <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {/* Delay + Max + Notify */}
        <div className="grid grid-cols-3 gap-3 items-end">
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Delay (s)</Label>
            <Input type="number" min="1" max="60" defaultValue={mine.delaySecs} disabled={running}
              onBlur={e => updateMut.mutate({ delaySecs: parseInt(e.target.value) || 3 })}
              className="rounded-none border-accent/30 bg-background font-mono text-sm h-9" />
          </div>
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Max / BIN</Label>
            <Input type="number" min="1" max="500" defaultValue={mine.maxCardsPerBin} disabled={running}
              onBlur={e => updateMut.mutate({ maxCardsPerBin: parseInt(e.target.value) || 50 })}
              className="rounded-none border-accent/30 bg-background font-mono text-sm h-9" />
          </div>
          <div className="flex items-center gap-3 border border-accent/20 p-2 h-9">
            {mine.notifyEnabled ? <Bell className="w-4 h-4 text-accent" /> : <BellOff className="w-4 h-4 text-muted-foreground" />}
            <span className="font-mono text-xs text-muted-foreground">Notify</span>
            <Switch checked={mine.notifyEnabled} onCheckedChange={v => updateMut.mutate({ notifyEnabled: v })} className="ml-auto" />
          </div>
        </div>

        {/* Extra BINs */}
        {extraBins.length > 0 && (
          <div>
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1">Extra BINs ({extraBins.length})</Label>
            <div className="flex flex-wrap gap-1.5 min-h-[28px] border border-white/[0.06] bg-background/30 p-2">
              {extraBins.map(bin => (
                <span key={bin} className="inline-flex items-center gap-1 bg-accent/10 border border-accent/30 text-accent font-mono text-[11px] px-1.5 py-0.5">
                  {bin}
                  {!running && (
                    <button onClick={() => removeBinMut.mutate(bin)} className="text-muted-foreground hover:text-destructive ml-0.5">
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Start / Stop */}
        <div className="grid grid-cols-2 gap-3">
          <Button onClick={() => startMut.mutate()} disabled={running || startMut.isPending || !mine.startBin || !mine.endBin}
            className="rounded-none font-display font-bold tracking-widest bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black">
            {startMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Play className="w-4 h-4 mr-2" />}
            START RANGE
          </Button>
          <Button onClick={() => stopMut.mutate()} disabled={!running || stopMut.isPending} variant="outline"
            className="rounded-none font-display font-bold tracking-widest border-destructive/30 text-destructive hover:bg-destructive/10">
            <Square className="w-4 h-4 mr-2" /> STOP RANGE
          </Button>
        </div>

        <p className="text-[10px] font-mono text-muted-foreground/40 text-center">
          Range miner cycles through BIN range continuously · Control via Telegram /mine
        </p>
      </CardContent>
    </Card>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function Miner() {
  // ── Config state ─────────────────────────────────────────────────────────
  const [binInput,     setBinInput]     = useState("");
  const [selectedGate, setSelectedGate] = useState("auto");
  const [batchSize,    setBatchSize]    = useState("10");
  const [targetCount,  setTargetCount]  = useState("0");
  const [delayMs,      setDelayMs]      = useState("300");

  // ── Runtime state ─────────────────────────────────────────────────────────
  const [isMining, setIsMining] = useState(false);
  const [trainers, setTrainers] = useState<BinTrainer[]>([]);
  const [logs, setLogs] = useState<string[]>([
    "> CC Miner + UCB1 Neural Selector ready.",
    "> Enter BINs (one per line, 6–9 digits) and press START.",
    "> The trainer learns which BINs produce live cards and adapts.",
  ]);
  const [globalStats, setGlobalStats] = useState({
    lives: 0, deads: 0, errors: 0, generated: 0,
    luhnPass: 0, luhnFail: 0, cpm: 0, rounds: 0,
  });
  const [liveCards, setLiveCards] = useState<string[]>([]);

  // ── Refs ─────────────────────────────────────────────────────────────────
  const miningRef    = useRef(false);
  const stopRef      = useRef(false);
  const startTimeRef = useRef(0);
  const roundsRef    = useRef(0);  // total batch rounds completed
  const consoleRef   = useRef<HTMLDivElement>(null);

  const { toast } = useToast();
  const { data: gatesData } = useQuery<any[]>({ queryKey: ["/api/gates"] });
  const gates = gatesData || [];

  // ── Auto-scroll console ───────────────────────────────────────────────────
  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  // ── Log helpers ───────────────────────────────────────────────────────────
  const addLog = useCallback((entry: string) => {
    setLogs(prev => {
      const next = [...prev, entry];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  const addLogs = useCallback((entries: string[]) => {
    if (!entries.length) return;
    setLogs(prev => {
      const next = [...prev, ...entries];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  // ── START ─────────────────────────────────────────────────────────────────
  const handleStart = async () => {
    if (miningRef.current) return;

    const bins = parseBins(binInput);
    if (bins.length === 0) {
      toast({ title: "NO VALID BINS", description: "Enter at least one BIN (6–9 digits per line).", variant: "destructive" });
      return;
    }

    const batch  = Math.min(Math.max(parseInt(batchSize)  || 10, MIN_BATCH), MAX_BATCH);
    const target = Math.max(parseInt(targetCount) || 0, 0);
    const delay  = Math.max(parseInt(delayMs)     || 0, 0);

    // Initialise trainer state for each BIN (fresh start)
    const initTrainers: BinTrainer[] = bins.map(b => ({
      bin: b, tries: 0, hits: 0, luhnPass: 0, luhnFail: 0,
      weight: 1 / bins.length, fitness: Number.MAX_SAFE_INTEGER,
      trend: "new", prevRate: 0, phase: "probing",
    }));

    miningRef.current  = true;
    stopRef.current    = false;
    startTimeRef.current = Date.now();
    roundsRef.current  = 0;

    setIsMining(true);
    setTrainers(initTrainers);
    setLiveCards([]);
    setGlobalStats({ lives: 0, deads: 0, errors: 0, generated: 0, luhnPass: 0, luhnFail: 0, cpm: 0, rounds: 0 });

    const gateName =
      selectedGate === "auto"   ? "Auto" :
      selectedGate === "random" ? "Random" :
      gates.find(g => g.id === selectedGate)?.name || selectedGate;

    addLog(`> Neural Selector initialised · ${bins.length} BINs · Batch: ${batch} · Target: ${target || "∞"} · Gate: ${esc(gateName)}`);
    addLog(`> Phase 1 — PROBING: exploring all BINs equally (first ${PHASE_PROBING} checks each)`);

    // Working copy of trainers (avoids stale closure issues with React state)
    let localTrainers = [...initTrainers];

    // Global counters
    let gLives = 0, gDeads = 0, gErrors = 0, gGenerated = 0;
    let gLuhnPass = 0, gLuhnFail = 0;

    try {
      while (!stopRef.current) {
        if (target > 0 && gGenerated >= target) break;

        const roundTotal = roundsRef.current;

        // ── Select BIN via UCB1 ─────────────────────────────────────────────
        const trainer = selectTrainer(localTrainers, roundTotal);
        const currentBin = trainer.bin;

        const remaining = target > 0
          ? Math.min(batch, target - gGenerated)
          : batch;

        // ── Resolve gate for this round ─────────────────────────────────────
        let activeGateId: string | undefined;
        if (selectedGate === "random" && gates.length > 0) {
          activeGateId = gates[Math.floor(Math.random() * gates.length)].id;
        } else if (selectedGate !== "auto") {
          activeGateId = selectedGate;
        }

        // ── Step 1: Generate cards ──────────────────────────────────────────
        let generated: any[] = [];
        try {
          const genRes = await apiRequest("POST", "/api/generate", {
            bin: currentBin, count: remaining,
          });
          generated = await genRes.json();
        } catch (e: any) {
          addLog(
            `<span class="text-yellow-500">[ERR]</span> Generate BIN ` +
            `<span class="text-primary">${esc(currentBin)}</span>: ` +
            `<span class="text-yellow-400/70">${esc(e.message || "network error")}</span>`
          );
          if (delay > 0 && !stopRef.current) await sleep(delay);
          continue;
        }

        if (!Array.isArray(generated) || generated.length === 0) {
          if (delay > 0 && !stopRef.current) await sleep(delay);
          continue;
        }

        // ── Step 2: Client-side Luhn validation ─────────────────────────────
        let batchLuhnPass = 0, batchLuhnFail = 0;
        const validCards: string[] = [];
        const skippedCards: string[] = [];

        for (const c of generated) {
          const cardStr = `${c.number}|${c.expiryMonth}|${c.expiryYear}|${c.cvv}`;
          if (luhnCheck(c.number)) {
            validCards.push(cardStr);
            batchLuhnPass++;
          } else {
            skippedCards.push(cardStr);
            batchLuhnFail++;
          }
        }

        gLuhnPass += batchLuhnPass;
        gLuhnFail += batchLuhnFail;

        if (batchLuhnFail > 0) {
          addLog(
            `<span class="text-yellow-400/60">[LUHN]</span> ` +
            `BIN <span class="text-primary">${esc(currentBin)}</span>: ` +
            `${batchLuhnPass} passed, ` +
            `<span class="text-red-400">${batchLuhnFail} failed — skipped</span>`
          );
        }

        if (validCards.length === 0) {
          if (delay > 0 && !stopRef.current) await sleep(delay);
          continue;
        }

        gGenerated += validCards.length;

        // ── Step 3: Check via gate ──────────────────────────────────────────
        let batchTries = 0, batchHits = 0;
        try {
          const checkRes = await apiRequest("POST", "/api/checks", {
            cards: validCards,
            gate:  activeGateId,
          });
          const results: any[] = await checkRes.json();
          batchTries = results.length;

          const newLogs: string[]  = [];
          const newLives: string[] = [];

          for (const r of results) {
            const resp  = r.response || "";
            const main  = esc(resp.split("|")[0]?.trim() || resp);
            const eCard = esc(r.card || "");
            const eGate = esc(r.gate || gateName);
            const eLat  = esc(String(r.latency ?? 0));
            const meta  = `<span class="opacity-35 text-[10px]">${eGate} · ${eLat}ms</span>`;

            if (r.status === "approved") {
              gLives++;
              batchHits++;
              newLives.push(r.card);
              newLogs.push(
                `<span class="text-green-400 font-bold">[LIVE]</span> ` +
                `<span class="text-green-300">${main}</span> · ` +
                `<span class="text-white font-mono">${eCard}</span> · ` +
                `<span class="text-primary text-[10px]">BIN:${esc(currentBin)}</span> · ${meta}`
              );
            } else if (r.status === "error") {
              gErrors++;
              newLogs.push(
                `<span class="text-yellow-500/80 font-bold">[ERR]</span> ` +
                `<span class="text-white/50">${eCard}</span> · ` +
                `<span class="text-yellow-400/60">${esc(resp)}</span>`
              );
            } else {
              gDeads++;
              newLogs.push(
                `<span class="text-red-600/50 font-bold">[DEAD]</span> ` +
                `<span class="text-red-400/40">${main}</span> · ` +
                `<span class="text-white/25">${eCard}</span> · ${meta}`
              );
            }
          }

          addLogs(newLogs);
          if (newLives.length > 0) setLiveCards(prev => [...prev, ...newLives]);
        } catch (e: any) {
          gErrors += validCards.length;
          batchTries = validCards.length;
          addLog(
            `<span class="text-yellow-500">[ERR]</span> Check batch failed: ` +
            `<span class="text-yellow-400/70">${esc(e.message || "network error")}</span>`
          );
        }

        // ── Step 4: Update trainer (UCB1 weight recalculation) ──────────────
        roundsRef.current++;
        const batchUpdates: Record<string, { tries: number; hits: number; luhnPass: number; luhnFail: number }> = {
          [currentBin]: {
            tries:    batchTries,
            hits:     batchHits,
            luhnPass: batchLuhnPass,
            luhnFail: batchLuhnFail,
          },
        };
        localTrainers = recomputeTrainers(localTrainers, roundsRef.current, batchUpdates);

        // Phase log milestones
        const updatedTrainer = localTrainers.find(t => t.bin === currentBin);
        if (updatedTrainer) {
          if (updatedTrainer.tries === PHASE_PROBING) {
            addLog(
              `> <span class="text-yellow-400">BIN ${esc(currentBin)} → TRAINING phase</span> ` +
              `(${updatedTrainer.hits} live so far, rate: ${pctStr(updatedTrainer.hits, updatedTrainer.tries)})`
            );
          } else if (updatedTrainer.tries === PHASE_TRAINING) {
            const color = updatedTrainer.hits > 0 ? "text-primary" : "text-red-400";
            addLog(
              `> <span class="${color}">BIN ${esc(currentBin)} → OPTIMIZED</span> ` +
              `(fitness: ${updatedTrainer.fitness.toFixed(3)}, ` +
              `weight: ${(updatedTrainer.weight * 100).toFixed(1)}%)`
            );
          }
        }

        // Update global stats in React state
        const elapsedMin = (Date.now() - startTimeRef.current) / 60000;
        const cpm = elapsedMin > 0 ? Math.round(gGenerated / elapsedMin) : 0;
        setGlobalStats({
          lives: gLives, deads: gDeads, errors: gErrors, generated: gGenerated,
          luhnPass: gLuhnPass, luhnFail: gLuhnFail, cpm, rounds: roundsRef.current,
        });
        setTrainers([...localTrainers]);

        if (delay > 0 && !stopRef.current) await sleep(delay);
      }
    } finally {
      miningRef.current = false;
      setIsMining(false);
      const hitRate = gGenerated > 0 ? ((gLives / gGenerated) * 100).toFixed(2) : "0.00";
      const bestBin = localTrainers
        .filter(t => t.tries > 0)
        .sort((a, b) => (b.hits / b.tries) - (a.hits / a.tries))[0];
      addLog(
        `> Mining stopped · Generated: ${gGenerated} · Lives: ${gLives} · ` +
        `Deads: ${gDeads} · Errors: ${gErrors} · Hit Rate: ${hitRate}%` +
        (bestBin ? ` · Best BIN: ${esc(bestBin.bin)} (${pctStr(bestBin.hits, bestBin.tries)})` : "")
      );
    }
  };

  // ── STOP ──────────────────────────────────────────────────────────────────
  const handleStop = () => {
    if (!miningRef.current) return;
    stopRef.current = true;
    addLog("> STOP signal sent — finishing current batch…");
  };

  // ── Download lives ────────────────────────────────────────────────────────
  const handleDownloadLives = () => {
    if (!liveCards.length) return;
    const blob = new Blob([liveCards.join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href     = url;
    a.download = `miner_lives_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // ── Derived ───────────────────────────────────────────────────────────────
  const bins        = parseBins(binInput);
  const target      = Math.max(parseInt(targetCount) || 0, 0);
  const progressPct = target > 0 && globalStats.generated > 0
    ? Math.min(100, Math.round((globalStats.generated / target) * 100))
    : 0;
  const hitRate     = globalStats.generated > 0
    ? ((globalStats.lives / globalStats.generated) * 100).toFixed(2)
    : "0.00";
  const luhnPassRate = (globalStats.luhnPass + globalStats.luhnFail) > 0
    ? ((globalStats.luhnPass / (globalStats.luhnPass + globalStats.luhnFail)) * 100).toFixed(1)
    : "–";

  // Best BIN by hit rate (at least 10 tries)
  const bestBin = useMemo(() =>
    [...trainers]
      .filter(t => t.tries >= 10)
      .sort((a, b) => (b.hits / b.tries) - (a.hits / a.tries))[0],
    [trainers]
  );

  // Overall training confidence: fraction of BINs in "optimized" phase
  const trainingConfidence = trainers.length > 0
    ? Math.round((trainers.filter(t => t.phase === "optimized").length / trainers.length) * 100)
    : 0;

  // ─── Phase badge helper ───────────────────────────────────────────────────
  function PhaseBadge({ phase }: { phase: BinTrainer["phase"] }) {
    const cfg = {
      probing:   { cls: "text-muted-foreground/60 border-white/10",  label: "PROBING"   },
      training:  { cls: "text-yellow-400 border-yellow-500/30",       label: "TRAINING"  },
      optimized: { cls: "text-primary border-primary/40",             label: "OPTIMIZED" },
    }[phase];
    return (
      <span className={`font-mono text-[9px] px-1 py-0.5 border tracking-widest ${cfg.cls}`}>
        {cfg.label}
      </span>
    );
  }

  // ─── Trend icon helper ────────────────────────────────────────────────────
  function TrendIcon({ trend }: { trend: BinTrainer["trend"] }) {
    if (trend === "rising")  return <TrendingUp   className="w-3 h-3 text-green-400" />;
    if (trend === "falling") return <TrendingDown className="w-3 h-3 text-red-400"   />;
    if (trend === "new")     return <span className="text-muted-foreground/40 font-mono text-[10px]">NEW</span>;
    return <Minus className="w-3 h-3 text-muted-foreground/40" />;
  }

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-6">

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h2 className="text-2xl sm:text-3xl font-display font-bold text-foreground glitch-text">CC Miner</h2>
          <p className="text-muted-foreground font-mono mt-1 text-xs sm:text-sm">
            BIN generation · Range mining · UCB1 neural selection
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          {liveCards.length > 0 && (
            <>
              <Button
                variant="outline"
                className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-primary/10"
                onClick={() => {
                  navigator.clipboard.writeText(liveCards.join("\n"));
                  toast({ title: "Copied", description: `${liveCards.length} live cards copied` });
                }}
              >
                <Copy className="w-3 h-3 mr-2" />
                COPY ({liveCards.length})
              </Button>
              <Button
                variant="outline"
                className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-primary/10"
                onClick={handleDownloadLives}
              >
                <Download className="w-3 h-3 mr-2" />
                EXPORT
              </Button>
            </>
          )}
        </div>
      </div>

      {/* ── Server Miner ────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <ServerMinerPanel />
        <RangeMinerPanel />
      </div>

      {/* ── Local Miner divider ─────────────────────────────────────────── */}
      <div className="flex items-center gap-3 pt-2">
        <div className="flex-1 h-px bg-white/5" />
        <span className="text-[10px] font-mono text-muted-foreground/40 tracking-widest uppercase flex items-center gap-1.5">
          <Brain className="w-3 h-3" /> Local Miner — UCB1 Neural (Browser Session)
        </span>
        <div className="flex-1 h-px bg-white/5" />
      </div>

      {/* ── Stats row ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 sm:gap-1.5">
        {[
          { label: "LIVES",    value: globalStats.lives,    color: "text-primary",       border: "border-primary/25",    bg: "bg-primary/5"    },
          { label: "DEADS",    value: globalStats.deads,    color: "text-red-400",        border: "border-red-500/20",    bg: "bg-red-500/5"    },
          { label: "ERRORS",   value: globalStats.errors,   color: "text-yellow-400",     border: "border-yellow-500/20", bg: "bg-yellow-500/5" },
          { label: "GEN",      value: globalStats.generated,color: "text-muted-foreground",border: "border-white/[0.06]",     bg: "bg-white/[0.03]"      },
          { label: "LUHN",    value: `${luhnPassRate}%`,   color: globalStats.luhnFail > 0 ? "text-yellow-400" : "text-emerald-400", border: "border-emerald-500/20", bg: "bg-emerald-500/5" },
          { label: "RATE",     value: formatCpm(globalStats.cpm), color: isMining ? "text-accent" : "text-muted-foreground", border: "border-accent/20", bg: "bg-accent/5" },
        ].map(s => (
          <div key={s.label} className={`border ${s.border} ${s.bg} p-1.5 sm:p-2.5 text-center font-mono`}>
            <div className={`text-xs sm:text-lg font-bold tabular-nums leading-tight ${s.color}`}>{s.value}</div>
            <div className="text-[7px] sm:text-[9px] opacity-50 tracking-widest mt-0.5 sm:mt-1 uppercase">{s.label}</div>
          </div>
        ))}
      </div>

      {/* ── Main grid ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── LEFT: config ──────────────────────────────────────────────── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Pickaxe className="w-4 h-4 text-primary" />
              Miner Config
              {isMining && (
                <span className="ml-auto flex items-center gap-1.5 text-yellow-400 text-xs font-mono font-normal">
                  <Zap className="w-3 h-3 animate-pulse" /> MINING
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-4">

            {/* BIN textarea */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <Label className="font-mono text-xs text-muted-foreground uppercase tracking-wider">
                  BIN Numbers
                </Label>
                <span className={`font-mono text-[10px] tabular-nums ${bins.length === 0 ? "text-muted-foreground/30" : "text-primary"}`}>
                  {bins.length} BIN{bins.length !== 1 ? "s" : ""}
                </span>
              </div>
              <Textarea
                className="h-24 resize-none bg-background/50 rounded-none border-white/[0.08] font-mono text-sm focus-visible:ring-primary text-primary placeholder:text-muted-foreground/25"
                placeholder={"453211\n523456\n411111\n\n(one per line, 6–9 digits)"}
                value={binInput}
                onChange={e => setBinInput(e.target.value)}
                disabled={isMining}
              />
              {binInput.trim() !== "" && bins.length === 0 && (
                <p className="text-red-400 text-[10px] font-mono mt-1 flex items-center gap-1">
                  <AlertTriangle className="w-3 h-3" />
                  No valid BINs — need 6–9 digits per line
                </p>
              )}
            </div>

            {/* Gate selector */}
            <div>
              <Label className="font-mono text-xs text-muted-foreground uppercase tracking-wider block mb-1.5">
                Gate
              </Label>
              <Select value={selectedGate} onValueChange={setSelectedGate} disabled={isMining}>
                <SelectTrigger className="rounded-none border-white/[0.08] bg-background font-mono text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">Auto-Select (best active gate)</SelectItem>
                  <SelectItem value="random">🎲 Random Rotation (per batch)</SelectItem>
                  {gates.map((g: any) => (
                    <SelectItem key={g.id} value={g.id}>
                      {g.name}
                      <span className="opacity-40 ml-1 text-[10px]">({g.gateType})</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedGate === "random" && (
                <p className="text-accent/70 text-[10px] font-mono mt-1 flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" />
                  Gate changes every batch round
                </p>
              )}
            </div>

            {/* Options */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1.5">Batch</Label>
                <Input
                  type="number" min={MIN_BATCH} max={MAX_BATCH}
                  value={batchSize} onChange={e => setBatchSize(e.target.value)}
                  disabled={isMining}
                  className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
                />
                <p className="text-[9px] text-muted-foreground/35 mt-0.5 font-mono">cards/round</p>
              </div>
              <div>
                <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1.5">Target</Label>
                <Input
                  type="number" min="0"
                  value={targetCount} onChange={e => setTargetCount(e.target.value)}
                  disabled={isMining}
                  className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
                />
                <p className="text-[9px] text-muted-foreground/35 mt-0.5 font-mono">total (0 = ∞)</p>
              </div>
              <div>
                <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider block mb-1.5">Delay</Label>
                <Input
                  type="number" min="0" max="30000"
                  value={delayMs} onChange={e => setDelayMs(e.target.value)}
                  disabled={isMining}
                  className="rounded-none border-white/[0.08] bg-background font-mono text-sm h-9"
                />
                <p className="text-[9px] text-muted-foreground/35 mt-0.5 font-mono">ms/batch</p>
              </div>
            </div>

            {/* Progress bar when target set */}
            {target > 0 && globalStats.generated > 0 && (
              <div>
                <div className="flex justify-between text-[10px] font-mono text-muted-foreground mb-1">
                  <span className="tabular-nums">{globalStats.generated.toLocaleString()} / {target.toLocaleString()}</span>
                  <span className="text-primary">{progressPct}%</span>
                </div>
                <div className="h-1.5 bg-primary/10">
                  <div className="h-1.5 bg-primary transition-all duration-500" style={{ width: `${progressPct}%` }} />
                </div>
              </div>
            )}

            {/* Hit rate + training confidence strip */}
            {globalStats.generated > 0 && (
              <div className="border border-white/6 bg-white/[0.02] grid grid-cols-3 divide-x divide-white/6 text-center py-2 font-mono">
                <div>
                  <div className={`text-base font-bold tabular-nums ${globalStats.lives > 0 ? "text-primary" : "text-muted-foreground/40"}`}>
                    {hitRate}%
                  </div>
                  <div className="text-[9px] text-muted-foreground/40 mt-0.5">HIT RATE</div>
                </div>
                <div>
                  <div className="text-base font-bold tabular-nums text-muted-foreground/70">
                    {globalStats.rounds}
                  </div>
                  <div className="text-[9px] text-muted-foreground/40 mt-0.5">EPOCHS</div>
                </div>
                <div>
                  <div className={`text-base font-bold tabular-nums ${trainingConfidence > 50 ? "text-accent" : "text-muted-foreground/70"}`}>
                    {trainingConfidence}%
                  </div>
                  <div className="text-[9px] text-muted-foreground/40 mt-0.5">CONFIDENCE</div>
                </div>
              </div>
            )}

            {/* Action buttons */}
            <div className="grid grid-cols-2 gap-3">
              <Button
                onClick={handleStart}
                disabled={isMining || bins.length === 0}
                className="rounded-none font-display font-bold tracking-widest bg-primary text-black hover:bg-primary hover:text-black"
              >
                {isMining
                  ? <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  : <Play className="w-4 h-4 mr-2" />}
                {isMining ? "MINING…" : "START"}
              </Button>
              <Button
                onClick={handleStop}
                disabled={!isMining}
                variant="outline"
                className="rounded-none font-display font-bold tracking-widest border-destructive/30 text-destructive hover:bg-destructive/10"
              >
                <Square className="w-4 h-4 mr-2" /> STOP
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── RIGHT: console ────────────────────────────────────────────── */}
        <Card className="glass-panel rounded-none flex flex-col h-[400px] sm:h-[560px] lg:h-auto lg:min-h-[560px]">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between shrink-0">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              Mining Console
            </CardTitle>
            <div className="flex items-center gap-3">
              {isMining && (
                <div className="flex items-center gap-1 text-[10px] font-mono text-muted-foreground">
                  <Brain className="w-3 h-3 text-accent animate-pulse" />
                  <span className="text-accent">UCB1 active</span>
                </div>
              )}
              <button
                onClick={() => setLogs(["> Console cleared."])}
                className="text-muted-foreground/35 hover:text-muted-foreground p-1 transition-colors"
                title="Clear console"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 bg-[#080808] overflow-hidden relative">
            <div
              ref={consoleRef}
              className="absolute inset-0 p-4 font-mono text-xs overflow-y-auto space-y-1 pb-10 custom-scrollbar"
            >
              {logs.map((log, i) => (
                <div
                  key={i}
                  className={
                    log.startsWith(">")
                      ? "text-primary mt-3 border-l-2 border-primary/25 pl-2 py-0.5"
                      : "text-muted-foreground/70 leading-relaxed"
                  }
                  dangerouslySetInnerHTML={{ __html: log }}
                />
              ))}
              {isMining && <div className="text-primary animate-pulse mt-1">▊</div>}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── UCB1 trainer table ───────────────────────────────────────────── */}
      {trainers.length > 0 && (
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06] py-3">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Brain className="w-4 h-4 text-accent" />
              UCB1 Neural Trainer — Per-BIN Intelligence
              {bestBin && globalStats.generated > 0 && (
                <span className="ml-auto text-[10px] font-mono font-normal text-muted-foreground">
                  Best:
                  <span className="text-primary ml-1">{bestBin.bin}</span>
                  <span className="text-muted-foreground/50 ml-1">
                    ({pctStr(bestBin.hits, bestBin.tries)})
                  </span>
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {/* Column headers */}
            <div className="overflow-x-auto">
              <div className="grid grid-cols-[1fr_auto_auto_auto_2fr_auto_auto] gap-x-2 sm:gap-x-4 px-3 sm:px-4 py-2 border-b border-white/5 text-[8px] sm:text-[9px] font-mono text-muted-foreground/40 uppercase tracking-widest min-w-[400px] sm:min-w-[500px]">
                <span>BIN</span>
                <span className="text-right">Gen</span>
                <span className="text-right">Live</span>
                <span className="text-right">Hit%</span>
                <span>Neural Weight</span>
                <span>Phase</span>
                <span>Trend</span>
              </div>

              <div className="max-h-60 sm:max-h-72 overflow-y-auto custom-scrollbar divide-y divide-white/4">
                {[...trainers]
                  .sort((a, b) => b.weight - a.weight)
                  .map(t => {
                    const hitPct = t.tries > 0 ? (t.hits / t.tries) * 100 : 0;
                    const weightPct = Math.round(t.weight * 100);

                    return (
                      <div
                        key={t.bin}
                        className="grid grid-cols-[1fr_auto_auto_auto_2fr_auto_auto] gap-x-2 sm:gap-x-4 px-3 sm:px-4 py-2 sm:py-2.5 items-center text-[10px] sm:text-[11px] font-mono hover:bg-white/[0.03] transition-colors min-w-[400px] sm:min-w-[500px]"
                      >
                      {/* BIN */}
                      <span className="text-primary font-bold tracking-wider">{t.bin}</span>

                      {/* Generated */}
                      <span className="text-right text-muted-foreground/60 tabular-nums">{t.luhnPass + t.luhnFail}</span>

                      {/* Lives */}
                      <span className={`text-right tabular-nums font-bold ${t.hits > 0 ? "text-green-400" : "text-muted-foreground/40"}`}>
                        {t.hits}
                      </span>

                      {/* Hit rate */}
                      <span className={`text-right tabular-nums ${hitPct >= 5 ? "text-primary font-bold" : hitPct > 0 ? "text-green-400/70" : "text-muted-foreground/35"}`}>
                        {t.tries > 0 ? hitPct.toFixed(1) + "%" : "–"}
                      </span>

                      {/* Weight bar */}
                      <div className="flex items-center gap-1.5 sm:gap-2">
                        <div className="flex-1 h-1.5 sm:h-2 bg-white/5 overflow-hidden">
                          <div
                            className={`h-1.5 sm:h-2 transition-all duration-700 ${
                              t.phase === "optimized" ? "bg-primary" :
                              t.phase === "training"  ? "bg-yellow-400" :
                              "bg-muted-foreground/30"
                            }`}
                            style={{ width: `${Math.max(2, weightPct)}%` }}
                          />
                        </div>
                        <span className="text-[8px] sm:text-[9px] text-muted-foreground/40 tabular-nums w-7 sm:w-8 text-right">
                          {weightPct}%
                        </span>
                      </div>

                      {/* Phase */}
                      <PhaseBadge phase={t.phase} />

                      {/* Trend */}
                      <div className="flex justify-center">
                        <TrendIcon trend={t.trend} />
                      </div>
                    </div>
                  );
                })}
            </div>
            </div>

            {/* Luhn summary footer */}
            {(globalStats.luhnPass + globalStats.luhnFail) > 0 && (
              <div className="border-t border-white/5 px-4 py-2 flex items-center justify-between text-[10px] font-mono text-muted-foreground/40">
                <div className="flex items-center gap-4">
                  <span>
                    Luhn ✓ <span className="text-emerald-400 font-bold">{globalStats.luhnPass}</span>
                  </span>
                  {globalStats.luhnFail > 0 && (
                    <span>
                      Luhn ✗ <span className="text-red-400 font-bold">{globalStats.luhnFail}</span>
                    </span>
                  )}
                  <span>Pass rate <span className="text-primary font-bold">{luhnPassRate}%</span></span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Target className="w-3 h-3" />
                  <span>{globalStats.rounds} training epochs</span>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* ── Live cards grid ──────────────────────────────────────────────── */}
      {liveCards.length > 0 && (
        <Card className="glass-panel rounded-none border-primary/30">
          <CardHeader className="border-b border-white/[0.06] py-3">
            <CardTitle className="font-display tracking-widest text-sm flex items-center justify-between">
              <div className="flex items-center gap-2 text-primary">
                <span className="w-2 h-2 rounded-full bg-primary animate-pulse shadow-[0_0_6px_rgba(0,255,128,0.8)]" />
                LIVE CARDS ({liveCards.length})
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary hover:bg-primary/10 font-mono text-xs h-7 px-3 rounded-none"
                onClick={handleDownloadLives}
              >
                <Download className="w-3 h-3 mr-1.5" /> DOWNLOAD .TXT
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-3">
            <div className="max-h-40 overflow-y-auto custom-scrollbar grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
              {liveCards.map((card, i) => (
                <div
                  key={i}
                  className="font-mono text-[10px] text-green-400 bg-green-400/5 border border-green-400/20 px-2 py-1.5 truncate cursor-default"
                  title={card}
                >
                  {card}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
