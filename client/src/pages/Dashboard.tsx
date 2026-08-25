import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  Activity, CreditCard, Network, Zap, CheckCircle, XCircle, Loader2, Trash2, AlertTriangle,
  Play, Square, Bot, Download, Send, Brain, Settings, Power, FileText, Bell, Hash,
  Scissors, Upload, Copy, Sparkles, Filter, Cpu, RefreshCw, ToggleRight, ChevronDown, ChevronUp
} from "lucide-react";

const NVIDIA_MODELS = [
  { id: "meta/llama-3.1-70b-instruct",                label: "Llama 3.1 70B" },
  { id: "meta/llama-3.3-70b-instruct",                label: "Llama 3.3 70B" },
  { id: "nvidia/llama-3.3-nemotron-super-49b-v1",     label: "Nemotron Super 49B" },
  { id: "mistralai/mixtral-8x7b-instruct-v0.1",       label: "Mixtral 8x7B" },
];

function luhnCheck(num: string): boolean {
  let sum = 0, alt = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let n = parseInt(num[i], 10);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n; alt = !alt;
  }
  return sum % 10 === 0;
}

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [resetPassword, setResetPassword] = useState("");
  const [resetStatus, setResetStatus] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [sendingProxies, setSendingProxies] = useState(false);

  // ── AI Gate Reconfigurer state ──────────────────────────────────────────
  const [nvidiaKey, setNvidiaKey] = useState(() => localStorage.getItem("nvidiaApiKey") || "");
  const [aiModel, setAiModel] = useState(() => {
    const stored = localStorage.getItem("aiModel");
    return stored && NVIDIA_MODELS.some(m => m.id === stored) ? stored : NVIDIA_MODELS[0].id;
  });
  const [aiAutoMode, setAiAutoMode] = useState(false);
  const [aiPreviewMode, setAiPreviewMode] = useState(true);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const [aiResult, setAiResult] = useState<any>(null);
  const [pendingResult, setPendingResult] = useState<any>(null);
  const [selectedGateIds, setSelectedGateIds] = useState<Set<string>>(new Set());
  const [aiPanelOpen, setAiPanelOpen] = useState(true);
  const autoIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── CC Extractor state ──────────────────────────────────────────────────
  const [rawText, setRawText] = useState("");
  const [extractedCards, setExtractedCards] = useState<{ card: string; bin: string; raw: string }[]>([]);
  const [binInfo, setBinInfo] = useState<Record<string, { bank: string; type: string; scheme: string; country: string }>>({});
  const [binLoading, setBinLoading] = useState(false);
  const [extFilter, setExtFilter] = useState("");
  const [extractMode, setExtractMode] = useState<"cc" | "bin">("cc");
  const [extractedBins, setExtractedBins] = useState<{ bin: string; count: number }[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["/api/dashboard/stats"],
    refetchInterval: 5000,
  });

  const { data: fullGates } = useQuery<any[]>({
    queryKey: ["/api/gates"],
    refetchInterval: 30000,
  });

  const { data: botSettings } = useQuery({
    queryKey: ["/api/bot-settings"],
    refetchInterval: 5000,
  });

  const updateSettingsMutation = useMutation({
    mutationFn: async (data: any) => {
      const res = await apiRequest("PATCH", "/api/bot-settings", data);
      return res.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] }),
  });

  const startBotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/start");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "BOT ONLINE", description: "Telegram bot polling started." });
    },
    onError: (error: any) => {
      toast({ title: "START FAILED", description: error.message, variant: "destructive" });
    },
  });

  const stopBotMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/stop");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "BOT OFFLINE", description: "Telegram bot polling stopped.", variant: "destructive" });
    },
    onError: (error: any) => {
      toast({ title: "STOP FAILED", description: error.message, variant: "destructive" });
    },
  });

  // ── AI Gate Reconfigurer logic ───────────────────────────────────────────
  const runAiReconfigure = useCallback(async (auto = false) => {
    if (!nvidiaKey.trim()) {
      toast({ title: "API KEY MISSING", description: "Enter your NVIDIA API key first.", variant: "destructive" });
      return;
    }
    // AUTO mode: if no gates are manually selected, use ALL available gates
    const allAvailableGates: any[] = (data as any)?.gates || [];
    const effectiveGateIds = selectedGateIds.size > 0
      ? [...selectedGateIds]
      : auto
        ? allAvailableGates.map((g: any) => g.id)
        : [];
    if (effectiveGateIds.length === 0) {
      toast({ title: "NO GATES SELECTED", description: "Select at least one gate to reconfigure.", variant: "destructive" });
      return;
    }
    setAiRunning(true);
    const shouldApply = auto || !aiPreviewMode;
    try {
      const res = await apiRequest("POST", "/api/ai/reconfigure-gates", {
        nvidiaApiKey: nvidiaKey,
        model: aiModel,
        gateIds: effectiveGateIds,
        autoApply: shouldApply,
      });
      let result: any;
      try { result = await res.json(); } catch { throw new Error(`Server error ${res.status}`); }
      if (!res.ok) throw new Error(result?.message || "AI request failed");
      if (shouldApply) {
        setAiResult(result);
        setPendingResult(null);
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
        toast({
          title: auto ? "AUTO-RECONFIG DONE" : "AI APPLIED",
          description: `${result.applied ?? result.gates?.length ?? 0} gate(s) updated.`,
        });
      } else {
        setPendingResult(result);
        setAiResult(null);
        toast({
          title: "PREVIEW READY",
          description: `${result.gates?.length ?? 0} gate(s) — review changes before applying.`,
        });
      }
    } catch (err: any) {
      toast({ title: "AI ERROR", description: err.message, variant: "destructive" });
    }
    setAiRunning(false);
  }, [nvidiaKey, aiModel, selectedGateIds, aiPreviewMode, data, toast, queryClient]);

  const applyPendingChanges = useCallback(async () => {
    if (!pendingResult?.gates?.length) return;
    setAiApplying(true);
    try {
      const res = await apiRequest("POST", "/api/ai/apply-changes", {
        gates: pendingResult.gates.map((g: any) => ({ id: g.id, changes: g.changes })),
      });
      let result: any;
      try { result = await res.json(); } catch { throw new Error(`Server error ${res.status}`); }
      if (!res.ok) throw new Error(result?.message || "Apply failed");
      setAiResult({ ...pendingResult, applied: result.applied });
      setPendingResult(null);
      queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      toast({ title: "CHANGES APPLIED", description: `${result.applied} gate(s) updated successfully.` });
    } catch (err: any) {
      toast({ title: "APPLY FAILED", description: err.message, variant: "destructive" });
    }
    setAiApplying(false);
  }, [pendingResult, toast, queryClient]);

  useEffect(() => {
    localStorage.setItem("nvidiaApiKey", nvidiaKey);
  }, [nvidiaKey]);

  useEffect(() => {
    localStorage.setItem("aiModel", aiModel);
  }, [aiModel]);

  useEffect(() => {
    if (autoIntervalRef.current) clearInterval(autoIntervalRef.current);
    if (aiAutoMode) {
      autoIntervalRef.current = setInterval(() => runAiReconfigure(true), 5 * 60 * 1000);
    }
    return () => { if (autoIntervalRef.current) clearInterval(autoIntervalRef.current); };
  }, [aiAutoMode, runAiReconfigure]);

  const toggleGate = useCallback((id: string) => {
    setSelectedGateIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const toggleAllGates = useCallback(() => {
    const allGates: any[] = (fullGates as any[]) || (data as any)?.gates || [];
    const allIds = allGates.map((g: any) => g.id);
    setSelectedGateIds(prev => prev.size === allIds.length ? new Set() : new Set(allIds));
  }, [data, fullGates]);

  // ── CC Extractor logic ───────────────────────────────────────────────────
  const extractCards = useCallback((text: string) => {
    const lines = text.split(/\n/).map(l => l.trim()).filter(Boolean);
    const seen = new Set<string>();
    const cards: { card: string; bin: string; raw: string }[] = [];
    const seps = ["|", ":", ";", ",", " ", "\t"];

    for (const line of lines) {
      for (const sep of seps) {
        const parts = line.split(sep).map(p => p.trim()).filter(Boolean);
        if (parts.length < 4) continue;
        const [num, month, year, cvv] = parts;
        const clean = num.replace(/[\s-]/g, "");
        if (clean.length < 13 || clean.length > 19 || !/^\d+$/.test(clean)) continue;
        if (!/^\d{1,2}$/.test(month) || !/^\d{2,4}$/.test(year) || !/^\d{3,4}$/.test(cvv)) continue;
        if (!luhnCheck(clean)) continue;
        const mm = month.padStart(2, "0");
        const yy = year.length === 4 ? year.slice(-2) : year;
        const normalized = `${clean}|${mm}|${yy}|${cvv}`;
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        cards.push({ card: normalized, bin: clean.substring(0, 6), raw: line });
        break;
      }
    }
    return cards;
  }, []);

  const handleExtract = useCallback(() => {
    const cards = extractCards(rawText);
    setExtractedCards(cards);
    if (cards.length === 0) {
      toast({ title: "NO CARDS", description: "Could not extract any valid cards from input.", variant: "destructive" });
      return;
    }
    toast({ title: `${cards.length} CARDS EXTRACTED`, description: `${new Set(cards.map(c => c.bin)).size} unique BINs found.` });

    const uniqueBins = [...new Set(cards.map(c => c.bin))];
    setBinLoading(true);
    fetch("/api/bin-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: uniqueBins }),
    })
      .then(r => r.json())
      .then(data => setBinInfo(data))
      .catch(() => {})
      .finally(() => setBinLoading(false));
  }, [rawText, extractCards, toast]);

  const handleExtractBins = useCallback(() => {
    const matches = rawText.match(/\b\d{13,19}\b/g) || [];
    const binCount = new Map<string, number>();
    for (const m of matches) {
      if (!luhnCheck(m)) continue;
      const bin = m.substring(0, 6);
      binCount.set(bin, (binCount.get(bin) || 0) + 1);
    }
    const seps = ["|", ":", ";", ",", " ", "\t"];
    const lines = rawText.split(/\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      for (const sep of seps) {
        const parts = line.split(sep).map(p => p.trim()).filter(Boolean);
        if (parts.length < 3) continue;
        const clean = parts[0].replace(/[\s-]/g, "");
        if (clean.length < 13 || clean.length > 19 || !/^\d+$/.test(clean)) continue;
        if (!luhnCheck(clean)) continue;
        const bin = clean.substring(0, 6);
        if (!binCount.has(bin)) binCount.set(bin, 1);
        break;
      }
    }
    if (binCount.size === 0) {
      toast({ title: "NO BINS", description: "No valid card numbers found in input.", variant: "destructive" });
      return;
    }
    const sorted = [...binCount.entries()].sort((a, b) => b[1] - a[1]).map(([bin, count]) => ({ bin, count }));
    setExtractedBins(sorted);
    setExtractedCards([]);
    toast({ title: `${sorted.length} BINS EXTRACTED`, description: `From ${[...binCount.values()].reduce((a, b) => a + b, 0)} card numbers.` });

    setBinLoading(true);
    fetch("/api/bin-lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bins: sorted.map(b => b.bin) }),
    })
      .then(r => r.json())
      .then(data => setBinInfo(data))
      .catch(() => {})
      .finally(() => setBinLoading(false));
  }, [rawText, toast]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setRawText(text);
      const cards = extractCards(text);
      setExtractedCards(cards);
      if (cards.length > 0) {
        toast({ title: `${cards.length} CARDS EXTRACTED`, description: `From file: ${file.name}` });
        const uniqueBins = [...new Set(cards.map(c => c.bin))];
        setBinLoading(true);
        fetch("/api/bin-lookup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ bins: uniqueBins }),
        })
          .then(r => r.json())
          .then(data => setBinInfo(data))
          .catch(() => {})
          .finally(() => setBinLoading(false));
      } else {
        toast({ title: "NO CARDS", description: "No valid cards found in file.", variant: "destructive" });
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }, [extractCards, toast]);

  const filteredCards = useMemo(() => {
    if (!extFilter) return extractedCards;
    return extractedCards.filter(c => c.bin.startsWith(extFilter) || c.card.includes(extFilter));
  }, [extractedCards, extFilter]);

  const binBreakdown = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of extractedCards) {
      map.set(c.bin, (map.get(c.bin) || 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [extractedCards]);

  const handleDownloadExtracted = useCallback(() => {
    if (filteredCards.length === 0) return;
    const content = filteredCards.map(c => c.card).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `extracted_cc_${filteredCards.length}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast({ title: "DOWNLOADED", description: `${filteredCards.length} cards saved.` });
  }, [filteredCards, toast]);

  const handleCopyExtracted = useCallback(() => {
    if (filteredCards.length === 0) return;
    navigator.clipboard.writeText(filteredCards.map(c => c.card).join("\n"));
    toast({ title: "COPIED", description: `${filteredCards.length} cards to clipboard.` });
  }, [filteredCards, toast]);

  const handleReset = async (target: string) => {
    if (!resetPassword) {
      setResetStatus("Enter admin password first");
      return;
    }
    setResetting(true);
    setResetStatus(null);
    try {
      const resp = await fetch("/api/admin/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: resetPassword, target }),
      });
      const result = await resp.json();
      if (resp.ok) {
        setResetStatus(`${result.message}`);
        setResetPassword("");
        queryClient.invalidateQueries();
      } else {
        setResetStatus(`${result.message}`);
      }
    } catch {
      setResetStatus("Reset failed");
    }
    setResetting(false);
  };

  const handleSendProxies = async () => {
    setSendingProxies(true);
    try {
      const res = await apiRequest("POST", "/api/proxies/send-telegram");
      const result = await res.json();
      if (!res.ok) throw new Error(result?.message || "Send failed");
      toast({ title: "PROXIES SENT", description: result.message || "Live proxies sent to Telegram." });
    } catch (error: any) {
      toast({ title: "SEND FAILED", description: error.message, variant: "destructive" });
    }
    setSendingProxies(false);
  };

  const handleDownloadApproved = () => {
    window.open("/api/checks/download?status=approved", "_blank");
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  const stats = data as any;
  const settings = botSettings as any;
  const checks = stats?.checks || { total: 0, approved: 0, declined: 0 };
  const proxyStats = stats?.proxies || { total: 0, live: 0, avgLatency: 0 };
  const gates = stats?.gates || [];
  const logs = stats?.recentLogs || [];
  const hitRate = checks.total > 0 ? ((checks.approved / checks.total) * 100).toFixed(1) : "0";
  const botRunning = settings?.botRunning || false;
  const lstmAuto = settings?.lstmAutoTrain ?? true;
  const parallelMode = settings?.parallelMode ?? true;
  const proxyFileOutput = settings?.proxyFileOutput ?? true;
  const sendLiveToChannel = settings?.sendLiveToChannel ?? true;
  const defaultDailyLimit = settings?.defaultDailyLimit ?? 100;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text" data-testid="text-dashboard-title">System Status</h2>
          <p className="text-muted-foreground font-mono mt-1">Real-time metrics & performance monitoring</p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] hover:text-foreground"
            onClick={handleDownloadApproved}
            data-testid="button-download-approved"
          >
            <Download className="w-3 h-3 mr-1" /> APPROVED.TXT
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] hover:text-foreground"
            onClick={() => window.open("/api/checks/download", "_blank")}
            data-testid="button-download-all"
          >
            <FileText className="w-3 h-3 mr-1" /> ALL.TXT
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          title="Total Checks (24h)"
          value={checks.total.toLocaleString()}
          icon={Activity}
          trend={`${hitRate}% hit rate`}
          color="text-primary"
        />
        <StatCard
          title="Active Proxies"
          value={`${proxyStats.live}/${proxyStats.total}`}
          icon={Network}
          trend={proxyStats.live > 0 ? "Healthy" : "No proxies"}
          color="text-accent"
        />
        <StatCard
          title="Approved (CVV)"
          value={checks.approved.toLocaleString()}
          icon={CheckCircle}
          trend={`${hitRate}% Hit Rate`}
          color="text-primary"
        />
        <StatCard
          title="Declined/Dead"
          value={checks.declined.toLocaleString()}
          icon={XCircle}
          trend={checks.total > 0 ? `${(100 - parseFloat(hitRate)).toFixed(1)}%` : "0%"}
          color="text-destructive"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <Card className="glass-panel rounded-none lg:col-span-1">
          <CardHeader className="border-b border-white/[0.06] pb-3">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Power className="w-4 h-4 text-accent" />
              Control Panel
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 space-y-5">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground uppercase">Bot Status</span>
                <span className={`font-mono text-xs font-bold ${botRunning ? "text-primary animate-pulse" : "text-destructive"}`} data-testid="text-bot-status">
                  {botRunning ? "ONLINE" : "OFFLINE"}
                </span>
              </div>
              <Button
                onClick={() => botRunning ? stopBotMutation.mutate() : startBotMutation.mutate()}
                disabled={startBotMutation.isPending || stopBotMutation.isPending}
                className={`w-full rounded-none font-mono font-bold tracking-wider text-[11px] h-8 transition-all duration-200 ${
                  botRunning
                    ? "bg-destructive/15 text-destructive border border-destructive/30 hover:bg-destructive hover:text-white"
                    : "bg-primary text-black hover:bg-primary/90"
                }`}
                data-testid="button-toggle-bot"
              >
                {(startBotMutation.isPending || stopBotMutation.isPending) ? (
                  <Loader2 className="w-3 h-3 mr-2 animate-spin" />
                ) : botRunning ? (
                  <><Square className="w-3 h-3 mr-2" /> STOP BOT</>
                ) : (
                  <><Play className="w-3 h-3 mr-2" /> START BOT</>
                )}
              </Button>
            </div>

            <div className="border-t border-primary/10 pt-4 space-y-3">
              <div className="flex items-center justify-between">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer" htmlFor="lstm-toggle">
                  <Brain className="w-3.5 h-3.5 text-accent" />
                  LSTM Auto
                </Label>
                <Switch
                  id="lstm-toggle"
                  checked={lstmAuto}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ lstmAutoTrain: v })}
                  data-testid="switch-lstm-auto"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer" htmlFor="parallel-toggle">
                  <Zap className="w-3.5 h-3.5 text-primary" />
                  Parallel Mode
                </Label>
                <Switch
                  id="parallel-toggle"
                  checked={parallelMode}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ parallelMode: v })}
                  data-testid="switch-parallel-mode"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer" htmlFor="proxy-output-toggle">
                  <Send className="w-3.5 h-3.5 text-blue-400" />
                  Proxy Export
                </Label>
                <Switch
                  id="proxy-output-toggle"
                  checked={proxyFileOutput}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ proxyFileOutput: v })}
                  data-testid="switch-proxy-output"
                />
              </div>
              <div className="flex items-center justify-between">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5 cursor-pointer" htmlFor="live-channel-toggle">
                  <Bell className="w-3.5 h-3.5 text-yellow-400" />
                  Live → Channel
                </Label>
                <Switch
                  id="live-channel-toggle"
                  checked={sendLiveToChannel}
                  onCheckedChange={(v) => updateSettingsMutation.mutate({ sendLiveToChannel: v })}
                  data-testid="switch-live-to-channel"
                />
              </div>
            </div>

            <div className="border-t border-primary/10 pt-4 space-y-2">
              <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                <Hash className="w-3.5 h-3.5 text-accent" />
                Daily Card Limit
              </Label>
              <div className="flex gap-2">
                <Input
                  type="number"
                  min={1}
                  max={10000}
                  value={defaultDailyLimit}
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (v > 0 && v <= 10000) updateSettingsMutation.mutate({ defaultDailyLimit: v });
                  }}
                  className="h-8 rounded-none bg-background/50 border-primary/30 font-mono text-xs text-center"
                  data-testid="input-daily-limit"
                />
              </div>
            </div>

            <div className="border-t border-primary/10 pt-4 space-y-2">
              <Button
                variant="outline"
                size="sm"
                className="w-full rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] hover:text-foreground"
                onClick={handleSendProxies}
                disabled={sendingProxies || !botRunning}
                data-testid="button-send-proxies"
              >
                {sendingProxies ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
                SEND PROXIES
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="w-full rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] hover:text-foreground"
                onClick={handleDownloadApproved}
                data-testid="button-download-approved-panel"
              >
                <Download className="w-3 h-3 mr-1" /> DOWNLOAD APPROVED
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel lg:col-span-2 rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Gateway Status Matrix
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-white/[0.04]">
              {gates.length === 0 ? (
                <div className="p-8 text-center text-muted-foreground font-mono text-sm">
                  No gates configured. Add gates from the Configs page.
                </div>
              ) : (
                gates.map((gate: any) => (
                  <GateRow
                    key={gate.id}
                    name={gate.name}
                    type={`${gate.gateType} / ${gate.subType}`}
                    status={gate.active ? "ONLINE" : "OFFLINE"}
                    hasKey={gate.hasKey}
                    isOffline={!gate.active}
                  />
                ))
              )}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm">Live Feed</CardTitle>
          </CardHeader>
          <CardContent className="p-4 font-mono text-sm space-y-3 h-[300px] overflow-y-auto custom-scrollbar">
            {logs.length === 0 ? (
              <div className="text-muted-foreground text-center py-4">No logs yet</div>
            ) : (
              logs.map((log: any) => (
                <LogEntry
                  key={log.id}
                  time={log.createdAt ? new Date(log.createdAt).toLocaleTimeString() : ""}
                  level={log.level}
                  msg={log.message}
                />
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── AI Gate Reconfigurer Panel ────────────────────────────────────── */}
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06] pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="font-display tracking-widest text-lg flex items-center gap-2">
              <Cpu className="w-5 h-5 text-purple-400" />
              AI Gate Reconfigurer
              <span className="text-[10px] font-mono text-purple-400/50 font-normal tracking-normal">STRIPE RADAR OPTIMIZER</span>
            </CardTitle>
            <div className="flex items-center gap-3">
              {/* Master ON/OFF toggle */}
              <div className="flex items-center gap-2 px-3 py-1.5 border border-purple-500/30 bg-black/30">
                <Power className={`w-3.5 h-3.5 ${aiAutoMode ? "text-purple-400 animate-pulse" : "text-muted-foreground/40"}`} />
                <Label className="font-mono text-xs cursor-pointer select-none" htmlFor="ai-master-toggle">
                  AUTO
                </Label>
                <Switch
                  id="ai-master-toggle"
                  checked={aiAutoMode}
                  onCheckedChange={v => {
                    setAiAutoMode(v);
                    if (v && selectedGateIds.size === 0) {
                      // Use fullGates (complete data) first, fall back to stats
                      const all: any[] = (fullGates as any[]) || (data as any)?.gates || [];
                      if (all.length > 0) setSelectedGateIds(new Set(all.map((g: any) => g.id)));
                    }
                    toast({
                      title: v ? "AUTO ON" : "AUTO OFF",
                      description: v ? "AI will reconfigure all selected gates every 5 min." : "Auto mode disabled.",
                    });
                  }}
                />
                {aiAutoMode && <span className="text-[9px] font-mono text-purple-400 animate-pulse">ACTIVE</span>}
              </div>
              <button
                onClick={() => setAiPanelOpen(v => !v)}
                className="text-muted-foreground hover:text-foreground transition-colors"
              >
                {aiPanelOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </CardHeader>

        {aiPanelOpen && (
          <CardContent className="p-4 space-y-4">
            {/* Row 1: API key + model + preview toggle */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="md:col-span-1 space-y-1.5">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                  <Cpu className="w-3.5 h-3.5 text-purple-400" /> NVIDIA API KEY
                  <a
                    href="https://build.nvidia.com"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="ml-auto text-[9px] text-purple-400/50 hover:text-purple-400 underline"
                  >
                    get free key ↗
                  </a>
                </Label>
                <Input
                  type="password"
                  placeholder="nvapi-..."
                  value={nvidiaKey}
                  onChange={e => setNvidiaKey(e.target.value)}
                  className="h-8 rounded-none bg-background/50 border-purple-500/30 font-mono text-xs"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                  <Brain className="w-3.5 h-3.5 text-purple-400" /> AI MODEL
                </Label>
                <select
                  value={aiModel}
                  onChange={e => setAiModel(e.target.value)}
                  className="w-full h-8 rounded-none bg-background/50 border border-purple-500/30 font-mono text-xs text-foreground px-2 focus:outline-none focus:border-purple-500/60"
                >
                  {NVIDIA_MODELS.map(m => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                  <Settings className="w-3.5 h-3.5 text-purple-400" /> APPLY MODE
                </Label>
                <div className="flex items-center gap-2 h-8 px-3 border border-purple-500/20 bg-black/20">
                  <Switch
                    id="ai-preview-toggle"
                    checked={aiPreviewMode}
                    onCheckedChange={v => setAiPreviewMode(v)}
                  />
                  <Label htmlFor="ai-preview-toggle" className="font-mono text-xs cursor-pointer">
                    {aiPreviewMode
                      ? <span className="text-yellow-400">PREVIEW first</span>
                      : <span className="text-green-400">APPLY instantly</span>}
                  </Label>
                </div>
              </div>
            </div>

            {/* Row 2: Gate selector */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-purple-400" /> GATES TO RECONFIGURE
                  <span className="text-purple-400 font-bold ml-1">{selectedGateIds.size}</span>
                  <span className="text-muted-foreground/40">/{gates.length}</span>
                </Label>
                {gates.length > 0 && (
                  <button
                    onClick={toggleAllGates}
                    className="text-[10px] font-mono text-purple-400/60 hover:text-purple-400 transition-colors"
                  >
                    {selectedGateIds.size === gates.length ? "DESELECT ALL" : "SELECT ALL"}
                  </button>
                )}
              </div>
              {gates.length === 0 ? (
                <div className="text-xs font-mono text-muted-foreground/40 py-4 text-center border border-dashed border-purple-500/15">
                  No gates — add them from the Configs page
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-1.5 max-h-[240px] overflow-y-auto custom-scrollbar">
                  {gates.map((gate: any) => {
                    const fg = fullGates?.find((g: any) => g.id === gate.id);
                    const s = fg?.settings || {};
                    const hasBilling = !!(s.billingEmail || s.billingFirstName || s.billingAddress);
                    const isSelected = selectedGateIds.has(gate.id);
                    return (
                      <button
                        key={gate.id}
                        onClick={() => toggleGate(gate.id)}
                        className={`text-left border px-3 py-2 transition-all ${
                          isSelected
                            ? "border-primary/40 bg-primary/10 text-primary"
                            : "border-white/[0.06] bg-white/[0.02] hover:border-white/10 text-foreground/70"
                        }`}
                      >
                        <div className="flex items-center gap-2">
                          <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSelected ? "bg-purple-400" : "bg-muted-foreground/25"}`} />
                          <span className="font-mono text-[11px] font-bold truncate flex-1">{gate.name}</span>
                          <span className={`text-[8px] font-mono shrink-0 ${hasBilling ? "text-green-400/60" : "text-yellow-500/70"}`}>
                            {hasBilling ? "CFG" : "EMPTY"}
                          </span>
                        </div>
                        <div className="text-[9px] font-mono text-muted-foreground/40 mt-0.5 pl-3.5 truncate">
                          {gate.gateType}/{gate.subType}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Row 3: Action bar */}
            <div className="flex items-center gap-3 flex-wrap border-t border-purple-500/10 pt-3">
              <Button
                onClick={() => runAiReconfigure(false)}
                disabled={aiRunning || aiApplying || !nvidiaKey.trim() || (selectedGateIds.size === 0 && !aiAutoMode)}
                className="rounded-none bg-primary text-black hover:bg-primary/90 font-mono text-xs font-bold h-8 px-5 transition-all"
              >
                {aiRunning ? (
                  <><Loader2 className="w-3.5 h-3.5 mr-2 animate-spin" /> ANALYZING {selectedGateIds.size || "ALL"} GATE{selectedGateIds.size !== 1 ? "S" : ""}...</>
                ) : aiAutoMode && selectedGateIds.size === 0 ? (
                  <><Zap className="w-3.5 h-3.5 mr-2" /> RUN ALL GATES NOW</>
                ) : (
                  <><RefreshCw className="w-3.5 h-3.5 mr-2" /> {aiPreviewMode ? "PREVIEW" : "RECONFIGURE NOW"}</>
                )}
              </Button>

              {aiRunning && (
                <span className="text-[10px] font-mono text-purple-400/60 animate-pulse">
                  Querying {NVIDIA_MODELS.find(m => m.id === aiModel)?.label}...
                </span>
              )}
              {aiAutoMode && !aiRunning && (
                <span className="text-[10px] font-mono text-purple-400/50">
                  ● auto every 5 min
                </span>
              )}
            </div>

            {/* Row 4: Preview pending */}
            {pendingResult && (
              <div className="border border-yellow-500/30 bg-yellow-500/5 rounded-none">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-yellow-500/20 bg-yellow-500/10">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-3.5 h-3.5 text-yellow-400" />
                    <span className="font-mono text-xs text-yellow-300 font-bold">PREVIEW — {pendingResult.gates?.length ?? 0} GATE{(pendingResult.gates?.length ?? 0) !== 1 ? "S" : ""} READY</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      onClick={() => setPendingResult(null)}
                      className="h-7 px-3 rounded-none bg-transparent border border-muted-foreground/30 text-muted-foreground hover:text-foreground hover:border-foreground/50 font-mono text-[10px]"
                    >
                      DISCARD
                    </Button>
                    <Button
                      size="sm"
                      onClick={applyPendingChanges}
                      disabled={aiApplying}
                      className="h-7 px-4 rounded-none bg-green-600/20 border border-green-500 text-green-300 hover:bg-green-600 hover:text-white font-mono text-[10px] font-bold"
                    >
                      {aiApplying ? <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> APPLYING...</> : "APPLY ALL"}
                    </Button>
                  </div>
                </div>
                {pendingResult.analysis && (
                  <div className="px-4 py-2.5 border-b border-yellow-500/10">
                    <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">{pendingResult.analysis}</p>
                  </div>
                )}
                <div className="divide-y divide-yellow-500/10">
                  {(pendingResult.gates || []).map((g: any, i: number) => {
                    const fg = fullGates?.find((x: any) => x.id === g.id);
                    const before = fg?.settings || {};
                    return (
                      <AiGateDiff key={i} gate={g} before={before} mode="preview" />
                    );
                  })}
                </div>
              </div>
            )}

            {/* Row 5: Applied result */}
            {aiResult && !pendingResult && (
              <div className="border border-purple-500/20 bg-black/30 rounded-none">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-purple-500/20 bg-purple-500/5">
                  <div className="flex items-center gap-2">
                    <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                    <span className="font-mono text-xs text-green-400 font-bold">
                      {aiResult.applied !== undefined ? `APPLIED — ${aiResult.applied} gate(s) updated` : `AI ANALYSIS — ${aiResult.gates?.length ?? 0} gate(s)`}
                    </span>
                  </div>
                  <button
                    onClick={() => setAiResult(null)}
                    className="text-[10px] font-mono text-muted-foreground/50 hover:text-muted-foreground"
                  >
                    clear
                  </button>
                </div>
                {aiResult.analysis && (
                  <div className="px-4 py-2.5 border-b border-purple-500/10">
                    <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">{aiResult.analysis}</p>
                  </div>
                )}
                <div className="divide-y divide-purple-500/10">
                  {(aiResult.gates || []).map((g: any, i: number) => (
                    <AiGateDiff key={i} gate={g} before={{}} mode="applied" />
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* ── CC Extractor Panel ────────────────────────────────────────────── */}
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06]">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="font-display tracking-widest text-lg flex items-center gap-2">
              <Scissors className="w-5 h-5 text-accent" />
              CC Extractor
            </CardTitle>
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.csv,.log,.text"
                onChange={handleFileUpload}
                className="hidden"
              />
              <Button
                variant="outline"
                size="sm"
                className="rounded-none border-accent/50 text-accent font-mono text-xs hover:bg-accent/10 h-7"
                onClick={() => fileInputRef.current?.click()}
              >
                <Upload className="w-3 h-3 mr-1" /> UPLOAD TXT
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-none border-primary/50 text-primary font-mono text-xs hover:bg-primary/10 h-7"
                onClick={async () => {
                  try {
                    const text = await navigator.clipboard.readText();
                    setRawText(text);
                    toast({ title: "PASTED", description: `${text.split("\n").length} lines from clipboard.` });
                  } catch { toast({ title: "PASTE FAILED", description: "Clipboard access denied.", variant: "destructive" }); }
                }}
              >
                <Copy className="w-3 h-3 mr-1" /> PASTE
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          {/* Mode tabs */}
          <div className="flex gap-1 border-b border-primary/10 pb-2">
            <button
              onClick={() => setExtractMode("cc")}
              className={`px-3 py-1.5 font-mono text-xs font-bold tracking-wider transition-colors ${
                extractMode === "cc"
                  ? "text-accent border-b-2 border-accent bg-accent/5"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <CreditCard className="w-3 h-3 inline mr-1.5 -mt-0.5" />CC EXTRACT
            </button>
            <button
              onClick={() => setExtractMode("bin")}
              className={`px-3 py-1.5 font-mono text-xs font-bold tracking-wider transition-colors ${
                extractMode === "bin"
                  ? "text-accent border-b-2 border-accent bg-accent/5"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Hash className="w-3 h-3 inline mr-1.5 -mt-0.5" />BIN EXTRACT
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: raw input */}
            <div className="space-y-2">
              <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> RAW INPUT
                <span className="text-muted-foreground/50 ml-auto">{rawText.split("\n").filter(Boolean).length} lines</span>
              </Label>
              <Textarea
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                placeholder={extractMode === "cc"
                  ? "Paste CC list in any format:\n4111111111111111|12|25|123\n5500000000000004:03:2026:456\n4012888888881881 09 27 789\nMixed formats auto-detected..."
                  : "Paste any text containing card numbers:\n4111111111111111|12|25|123\nCC: 5500000000000004\ncard 4012888888881881 found\nExtracts unique 6-digit BINs..."}
                className="rounded-none border-primary/30 font-mono text-xs min-h-[200px] resize-none bg-black/30"
              />
              {extractMode === "cc" ? (
                <Button
                  onClick={handleExtract}
                  disabled={!rawText.trim()}
                  className="w-full rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs font-bold h-9"
                >
                  <Sparkles className="w-3.5 h-3.5 mr-1.5" /> EXTRACT & CLEAN
                </Button>
              ) : (
                <Button
                  onClick={handleExtractBins}
                  disabled={!rawText.trim()}
                  className="w-full rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs font-bold h-9"
                >
                  <Hash className="w-3.5 h-3.5 mr-1.5" /> EXTRACT BINS
                </Button>
              )}
            </div>

            {/* Right: results */}
            <div className="space-y-2">
              {extractMode === "cc" ? (
                <>
                  <div className="flex items-center justify-between">
                    <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                      <CreditCard className="w-3.5 h-3.5" /> EXTRACTED
                      <span className="text-accent font-bold ml-1">{filteredCards.length}</span>
                      {extFilter && <span className="text-muted-foreground/50">/ {extractedCards.length}</span>}
                    </Label>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6 px-2 rounded-none text-[10px] font-mono text-primary hover:bg-primary/10" onClick={handleCopyExtracted} disabled={filteredCards.length === 0}>
                        <Copy className="w-2.5 h-2.5 mr-1" /> COPY
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 rounded-none text-[10px] font-mono text-accent hover:bg-accent/10" onClick={handleDownloadExtracted} disabled={filteredCards.length === 0}>
                        <Download className="w-2.5 h-2.5 mr-1" /> TXT
                      </Button>
                    </div>
                  </div>
                  {extractedCards.length > 0 && (
                    <div className="flex items-center gap-2">
                      <Filter className="w-3 h-3 text-muted-foreground/50" />
                      <Input value={extFilter} onChange={(e) => setExtFilter(e.target.value)} placeholder="Filter by BIN or card..." className="h-6 rounded-none bg-black/20 border-primary/20 font-mono text-[10px] px-2" />
                      {extFilter && <button onClick={() => setExtFilter("")} className="text-[10px] text-muted-foreground hover:text-foreground">clear</button>}
                    </div>
                  )}
                  <div className="border border-primary/20 bg-black/30 min-h-[200px] max-h-[200px] overflow-y-auto custom-scrollbar font-mono text-[11px]">
                    {filteredCards.length === 0 ? (
                      <div className="flex items-center justify-center h-[200px] text-muted-foreground/50 text-xs">
                        {extractedCards.length === 0 ? "Paste raw text → click Extract" : "No cards match filter"}
                      </div>
                    ) : (
                      <div className="divide-y divide-primary/5">
                        {filteredCards.map((c, i) => (
                          <div key={i} className="flex items-center gap-2 px-2 py-1 hover:bg-white/5">
                            <span className="text-muted-foreground/40 w-6 text-right shrink-0">{i + 1}</span>
                            <span className="text-foreground/90 flex-1 truncate">{c.card}</span>
                            {binInfo[c.bin] && <span className="text-[9px] text-accent/70 shrink-0">{binInfo[c.bin].scheme}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center justify-between">
                    <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                      <Hash className="w-3.5 h-3.5" /> BINS FOUND
                      <span className="text-accent font-bold ml-1">{extractedBins.length}</span>
                      {binLoading && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
                    </Label>
                    <div className="flex gap-1">
                      <Button variant="ghost" size="sm" className="h-6 px-2 rounded-none text-[10px] font-mono text-primary hover:bg-primary/10"
                        disabled={extractedBins.length === 0}
                        onClick={() => {
                          navigator.clipboard.writeText(extractedBins.map(b => b.bin).join("\n"));
                          toast({ title: "COPIED", description: `${extractedBins.length} BINs to clipboard.` });
                        }}>
                        <Copy className="w-2.5 h-2.5 mr-1" /> COPY
                      </Button>
                      <Button variant="ghost" size="sm" className="h-6 px-2 rounded-none text-[10px] font-mono text-accent hover:bg-accent/10"
                        disabled={extractedBins.length === 0}
                        onClick={() => {
                          const lines = extractedBins.map(b => {
                            const info = binInfo[b.bin];
                            const detail = info ? ` | ${info.scheme} ${info.type} [${info.country || ""}] ${info.bank || ""}`.trimEnd() : "";
                            return `${b.bin} | x${b.count}${detail}`;
                          });
                          const blob = new Blob([lines.join("\n")], { type: "text/plain" });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `bins_extracted_${extractedBins.length}.txt`;
                          a.click();
                          URL.revokeObjectURL(url);
                          toast({ title: "DOWNLOADED", description: `${extractedBins.length} BINs saved.` });
                        }}>
                        <Download className="w-2.5 h-2.5 mr-1" /> TXT
                      </Button>
                    </div>
                  </div>
                  <div className="border border-primary/20 bg-black/30 min-h-[200px] max-h-[200px] overflow-y-auto custom-scrollbar font-mono text-[11px]">
                    {extractedBins.length === 0 ? (
                      <div className="flex items-center justify-center h-[200px] text-muted-foreground/50 text-xs">
                        Paste text with card numbers → click Extract BINs
                      </div>
                    ) : (
                      <div className="divide-y divide-primary/5">
                        {extractedBins.map((b, i) => {
                          const info = binInfo[b.bin];
                          return (
                            <div key={b.bin} className="flex items-center gap-2 px-2 py-1.5 hover:bg-white/5">
                              <span className="text-muted-foreground/40 w-6 text-right shrink-0">{i + 1}</span>
                              <span className="text-foreground font-bold w-16 shrink-0">{b.bin}</span>
                              <span className="text-muted-foreground text-[10px] w-8 shrink-0">x{b.count}</span>
                              {info ? (
                                <span className="text-[10px] text-muted-foreground/70 flex-1 truncate">
                                  <span className="text-accent/80">{info.scheme}</span> {info.type} {info.country ? `[${info.country}]` : ""}
                                  {info.bank && <span className="text-muted-foreground/50"> · {info.bank}</span>}
                                </span>
                              ) : binLoading ? (
                                <span className="text-[10px] text-muted-foreground/30">looking up...</span>
                              ) : null}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* BIN Breakdown */}
          {binBreakdown.length > 0 && (
            <div className="border-t border-primary/10 pt-3">
              <div className="flex items-center justify-between mb-2 flex-wrap gap-2">
                <Label className="font-mono text-xs text-muted-foreground flex items-center gap-1.5">
                  <Hash className="w-3.5 h-3.5" /> BIN BREAKDOWN
                  <span className="text-accent font-bold ml-1">{binBreakdown.length}</span>
                  <span className="text-muted-foreground/50">unique BINs</span>
                  {binLoading && <Loader2 className="w-3 h-3 animate-spin ml-1" />}
                </Label>
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 rounded-none text-[10px] font-mono text-primary hover:bg-primary/10"
                    onClick={() => {
                      const lines = binBreakdown.map(([bin]) => bin);
                      navigator.clipboard.writeText(lines.join("\n"));
                      toast({ title: "COPIED", description: `${lines.length} BINs to clipboard.` });
                    }}
                  >
                    <Copy className="w-2.5 h-2.5 mr-1" /> COPY BINS
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 rounded-none text-[10px] font-mono text-accent hover:bg-accent/10"
                    onClick={() => {
                      const lines = binBreakdown.map(([bin, count]) => {
                        const info = binInfo[bin];
                        const detail = info ? `${info.scheme} ${info.type} ${info.country ? `[${info.country}]` : ""} ${info.bank || ""}`.trim() : "";
                        return `${bin} | x${count}${detail ? ` | ${detail}` : ""}`;
                      });
                      const blob = new Blob([lines.join("\n")], { type: "text/plain" });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement("a");
                      a.href = url;
                      a.download = `bins_${binBreakdown.length}.txt`;
                      a.click();
                      URL.revokeObjectURL(url);
                      toast({ title: "DOWNLOADED", description: `${binBreakdown.length} BINs with info saved.` });
                    }}
                  >
                    <Download className="w-2.5 h-2.5 mr-1" /> BIN TXT
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-1.5">
                {binBreakdown.map(([bin, count]) => {
                  const info = binInfo[bin];
                  return (
                    <button
                      key={bin}
                      onClick={() => setExtFilter(extFilter === bin ? "" : bin)}
                      className={`text-left border px-2 py-1.5 transition-colors ${
                        extFilter === bin
                          ? "border-accent bg-accent/10 text-accent"
                          : "border-primary/15 bg-black/20 hover:border-primary/40 text-foreground/80"
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-mono text-[11px] font-bold">{bin}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">x{count}</span>
                      </div>
                      {info ? (
                        <div className="text-[9px] text-muted-foreground/70 truncate mt-0.5">
                          {info.scheme} {info.type} {info.country ? `[${info.country}]` : ""}
                        </div>
                      ) : binLoading ? (
                        <div className="text-[9px] text-muted-foreground/40 mt-0.5">loading...</div>
                      ) : null}
                      {info?.bank && (
                        <div className="text-[9px] text-accent/50 truncate">{info.bank}</div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06]">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-destructive" />
            System Reset
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-4">
          <div className="flex items-center gap-3">
            <Input
              type="password"
              placeholder="Admin password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
              className="w-48 rounded-none font-mono bg-background border-primary/30"
              data-testid="input-reset-password"
            />
            {resetStatus && (
              <span className="text-sm font-mono text-muted-foreground">{resetStatus}</span>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("checks")} disabled={resetting} data-testid="button-reset-checks">
              <Trash2 className="w-3 h-3 mr-1" /> Check Results
            </Button>
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("users")} disabled={resetting} data-testid="button-reset-users">
              <Trash2 className="w-3 h-3 mr-1" /> Bot Users
            </Button>
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("gates")} disabled={resetting} data-testid="button-reset-gates">
              <Trash2 className="w-3 h-3 mr-1" /> Gates
            </Button>
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("keys")} disabled={resetting} data-testid="button-reset-keys">
              <Trash2 className="w-3 h-3 mr-1" /> Access Keys
            </Button>
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("proxies")} disabled={resetting} data-testid="button-reset-proxies">
              <Trash2 className="w-3 h-3 mr-1" /> Proxies
            </Button>
            <Button variant="outline" size="sm" className="rounded-none border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => handleReset("logs")} disabled={resetting} data-testid="button-reset-logs">
              <Trash2 className="w-3 h-3 mr-1" /> Logs
            </Button>
            <Button variant="destructive" size="sm" className="rounded-none font-bold" onClick={() => { if (confirm("FULL RESET — This will delete ALL data including gates, users, keys, checks, proxies, and logs. Continue?")) handleReset("all"); }} disabled={resetting} data-testid="button-reset-all">
              <AlertTriangle className="w-3 h-3 mr-1" /> FULL RESET
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, trend, color, borderColor }: any) {
  return (
    <Card className="glass-panel rounded-none">
      <CardContent className="p-4">
        <div className="flex justify-between items-start">
          <div>
            <p className="text-muted-foreground font-mono text-[10px] uppercase tracking-wider mb-1">{title}</p>
            <h3 className={`text-2xl font-display font-bold ${color}`} data-testid={`text-stat-${title.replace(/\s/g, '-').toLowerCase()}`}>{value}</h3>
          </div>
          <div className={`p-2 bg-white/[0.03] rounded-none`}>
            <Icon className={`w-4 h-4 ${color}`} />
          </div>
        </div>
        <div className="mt-3 text-[10px] font-mono text-muted-foreground">
          <span className={color}>{trend}</span>
        </div>
      </CardContent>
    </Card>
  );
}

function GateRow({ name, type, status, hasKey = false, isOffline = false }: any) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors" data-testid={`row-gate-${name}`}>
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${isOffline ? 'bg-destructive' : 'bg-primary shadow-[0_0_6px_rgba(0,255,128,0.6)]'}`} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-foreground text-sm">{name}</span>
            {hasKey && (
              <span className="px-1.5 py-0.5 text-[8px] font-mono bg-primary/10 text-primary border border-primary/20">KEY</span>
            )}
          </div>
          <p className="text-[9px] font-mono text-muted-foreground">{type}</p>
        </div>
      </div>
      <div className={`px-2 py-0.5 text-[10px] font-mono shrink-0 ${
        isOffline ? 'text-destructive' : 'text-primary'
      }`}>
        {status}
      </div>
    </div>
  );
}

function AiGateDiff({ gate, before, mode }: { gate: any; before: Record<string, any>; mode: "preview" | "applied" }) {
  const changes = gate.changes || {};
  const entries = Object.entries(changes);
  const accent = mode === "preview" ? "text-yellow-300" : "text-green-400";
  const border = mode === "preview" ? "border-yellow-500/20" : "border-purple-500/20";
  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`font-mono text-[11px] font-bold ${mode === "preview" ? "text-yellow-200" : "text-purple-300"}`}>
          {gate.name || gate.id}
        </span>
        {gate.detectedCountry && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 border border-purple-500/30 text-purple-400/70 bg-purple-500/5">
            {gate.detectedCountry}
          </span>
        )}
        <span className={`text-[9px] font-mono ${mode === "preview" ? "text-yellow-400/60" : "text-green-400/60"}`}>
          {entries.length} field{entries.length !== 1 ? "s" : ""}
        </span>
        {gate.reason && (
          <span className="text-[9px] font-mono text-muted-foreground/50 flex-1 text-right truncate">{gate.reason}</span>
        )}
      </div>
      {entries.length > 0 && (
        <div className={`border ${border} grid grid-cols-1 sm:grid-cols-2 gap-0 divide-y sm:divide-y-0 sm:divide-x divide-purple-500/10`}>
          {entries.map(([k, v]) => {
            const oldVal = before[k];
            const hasOld = oldVal !== undefined && oldVal !== null && String(oldVal).trim() !== "";
            return (
              <div key={k} className="flex items-center gap-1.5 px-2 py-1 hover:bg-white/3">
                <span className="text-[9px] font-mono text-muted-foreground/35 w-28 shrink-0 truncate">{k}</span>
                {hasOld ? (
                  <span className="text-[9px] font-mono text-red-400/50 line-through truncate max-w-[5rem]">{String(oldVal)}</span>
                ) : (
                  <span className="text-[9px] font-mono text-muted-foreground/20">—</span>
                )}
                <span className="text-[9px] font-mono text-muted-foreground/40">→</span>
                <span className={`text-[9px] font-mono ${accent} truncate flex-1`}>{String(v)}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function LogEntry({ time, level, msg }: any) {
  const getLevelColor = () => {
    switch(level) {
      case 'INFO': return 'text-accent';
      case 'SUCCESS': return 'text-primary';
      case 'WARN': return 'text-[hsl(45_100%_50%)]';
      case 'ERROR': return 'text-destructive';
      default: return 'text-foreground';
    }
  };

  return (
    <div className="flex gap-3">
      <span className="text-muted-foreground opacity-50 shrink-0">[{time}]</span>
      <span className={`${getLevelColor()} font-bold shrink-0 w-20`}>{level}</span>
      <span className="text-foreground/80">{msg}</span>
    </div>
  );
}
