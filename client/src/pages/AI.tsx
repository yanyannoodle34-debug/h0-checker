import { useState, useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Switch } from "@/components/ui/switch";
import { Sparkles, Key, Eye, EyeOff, Save, Trash2, Loader2, Send, AlertCircle, CheckCircle, Activity, MessageSquare, FlaskConical, Play, ChevronDown, ChevronUp, Zap } from "lucide-react";

interface AIStatus {
  configured: boolean;
  masked: string;
  source: "env" | "file" | "none";
  envVarPresent: boolean;
  canEdit: boolean;
  recentCount: number;
  recentEvents: Array<{ source: string; message: string; level: string; createdAt: string }>;
}

type ChatMsg = { role: "user" | "assistant"; content: string };

export default function AIConsole() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newKey, setNewKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [keyProvider, setKeyProvider] = useState<"nvidia" | "deepseek">("deepseek");
  const [chat, setChat] = useState<ChatMsg[]>(() => {
    try { return JSON.parse(localStorage.getItem("ai-chat-history") || "[]"); } catch { return []; }
  });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: status } = useQuery<AIStatus>({
    queryKey: ["/api/ai/status"],
    refetchInterval: 15_000,
  });
  const { data: providersData } = useQuery<any>({
    queryKey: ["/api/ai/providers"],
    refetchInterval: 15_000,
  });

  // Selected-provider view (drives the key form + status chips)
  const providerList = (providersData?.providers || []) as Array<{
    id: string; keyStatus: "env" | "file" | "none"; masked: string; models: string[]; default: string; baseUrl: string;
  }>;
  const selectedProv = providerList.find(p => p.id === keyProvider);
  const selSource = selectedProv?.keyStatus || "none";
  const selMasked = selectedProv?.masked || "—";
  const envVarName = keyProvider === "nvidia" ? "NVIDIA_API_KEY" : "DEEPSEEK_API_KEY";
  const canEdit = selSource !== "env";

  useEffect(() => {
    try { localStorage.setItem("ai-chat-history", JSON.stringify(chat.slice(-40))); } catch {}
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chat]);

  const saveKey = useMutation({
    mutationFn: async ({ key, provider }: { key: string; provider: string }) => {
      const r = await apiRequest("PUT", `/api/ai/providers/${provider}/key`, { key });
      return r.json();
    },
    onSuccess: () => {
      setNewKey("");
      queryClient.invalidateQueries({ queryKey: ["/api/ai/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/providers"] });
      toast({ title: "KEY SAVED", description: `${keyProvider} key updated. Telegram bot will pick it up on the next /ai or /aiconfig.` });
    },
    onError: (e: any) => toast({ title: "SAVE FAILED", description: e.message, variant: "destructive" }),
  });

  const removeKey = useMutation({
    mutationFn: async (provider: string) => {
      const r = await apiRequest("DELETE", `/api/ai/providers/${provider}/key`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/providers"] });
      toast({ title: "KEY REMOVED", description: `${keyProvider} key file deleted.` });
    },
    onError: (e: any) => toast({ title: "REMOVE FAILED", description: e.message, variant: "destructive" }),
  });

  const testKey = useMutation({
    mutationFn: async (provider: string) => {
      const r = await apiRequest("POST", `/api/ai/providers/${provider}/test`);
      return r.json();
    },
    onSuccess: (data: any) => {
      if (data.ok) {
        toast({ title: "KEY VALID", description: `Provider: ${data.provider} · Model: ${data.model}` });
      } else {
        toast({ title: "KEY INVALID", description: data.message, variant: "destructive" });
      }
    },
    onError: (e: any) => toast({ title: "TEST FAILED", description: e.message, variant: "destructive" }),
  });

  const send = async () => {
    if (!draft.trim() || sending) return;
    if (!status?.configured) {
      toast({ title: "KEY MISSING", description: "Set the AI key first.", variant: "destructive" });
      return;
    }
    const next: ChatMsg[] = [...chat, { role: "user", content: draft.trim() }];
    setChat(next);
    setDraft("");
    setSending(true);
    try {
      const r = await apiRequest("POST", "/api/ai/chat", { messages: next });
      const data = await r.json();
      setChat([...next, { role: "assistant", content: data.reply || "(empty)" }]);
    } catch (e: any) {
      setChat([...next, { role: "assistant", content: `❌ ${e.message}` }]);
    } finally {
      setSending(false);
    }
  };

  const clearChat = () => {
    if (!chat.length) return;
    if (!confirm("Clear chat history?")) return;
    setChat([]);
    localStorage.removeItem("ai-chat-history");
  };

  return (
    <div className="p-4 space-y-6">
      <div className="flex items-center gap-3">
        <Sparkles className="w-7 h-7 text-primary" />
        <h1 className="font-display text-2xl tracking-widest text-primary">AI CONSOLE</h1>
        <span className={`ml-auto text-[10px] font-mono px-2 py-1 border ${status?.configured ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/5" : "border-red-500/40 text-red-400 bg-red-500/5"}`}>
          {status?.configured ? `● ${status.source.toUpperCase()} · ${status.masked}` : "○ NOT CONFIGURED"}
        </span>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* ── Key management ─────────────────────────────────────────────── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
              <Key className="w-4 h-4 text-primary" /> API Key
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            {/* Provider selector */}
            <div className="flex items-center gap-2">
              <p className="text-[10px] font-mono uppercase text-muted-foreground/60">Provider</p>
              <div className="flex gap-1 ml-auto">
                {providerList.map(p => (
                  <button
                    key={p.id}
                    onClick={() => setKeyProvider(p.id as "nvidia" | "deepseek")}
                    className={`font-mono text-[10px] px-2.5 py-1 border rounded-none transition-colors ${
                      keyProvider === p.id
                        ? "border-primary bg-primary/20 text-primary"
                        : "border-primary/20 text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {p.id === "nvidia" ? "NVIDIA" : "DeepSeek"}
                    {p.keyStatus !== "none" && <span className="ml-1 text-emerald-400">●</span>}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1">
              <p className="text-[10px] font-mono uppercase text-muted-foreground/60">Current ({keyProvider})</p>
              <div className="flex items-center justify-between font-mono text-xs border border-white/[0.06] bg-white/[0.02] px-3 py-2">
                <span className="text-foreground/80">{selMasked}</span>
                <span className={`text-[10px] uppercase ${selSource === "env" ? "text-yellow-400" : selSource === "file" ? "text-emerald-400" : "text-red-400/70"}`}>
                  {selSource === "env" ? "ENV VAR" : selSource === "file" ? "FILE" : "NONE"}
                </span>
              </div>
              {selSource === "env" && (
                <p className="text-[10px] text-yellow-400/80 font-mono flex items-start gap-1.5 mt-2">
                  <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
                  {envVarName} env var is set — it overrides any key saved here. Unset it on the server to manage the key from this page.
                </p>
              )}
            </div>

            <div className="space-y-1.5">
              <label className="text-[10px] font-mono uppercase text-muted-foreground/60">Update Key</label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={showKey ? "text" : "password"}
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder={keyProvider === "nvidia" ? "nvapi-..." : "sk-..."}
                    disabled={!canEdit || saveKey.isPending}
                    className="rounded-none border-primary/20 font-mono text-xs bg-white/[0.02] pr-9"
                  />
                  <button
                    type="button"
                    onClick={() => setShowKey(!showKey)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    aria-label="Toggle visibility"
                  >
                    {showKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
                <Button
                  onClick={() => newKey.trim() && saveKey.mutate({ key: newKey.trim(), provider: keyProvider })}
                  disabled={!newKey.trim() || !canEdit || saveKey.isPending}
                  className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-9 px-4"
                >
                  {saveKey.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
                  SAVE
                </Button>
                <Button
                  onClick={() => testKey.mutate(keyProvider)}
                  disabled={selSource === "none" || testKey.isPending}
                  variant="outline"
                  className="rounded-none border-accent/30 text-accent hover:bg-accent/10 font-mono text-xs h-9 px-3"
                >
                  {testKey.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Zap className="w-3 h-3 mr-1" />}
                  TEST
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground/50 font-mono">
                Saved to <code>data/.{keyProvider}-key</code> (mode 0600). Shared with the Telegram bot.
              </p>
            </div>

            <div className="pt-3 border-t border-primary/10 flex items-center justify-between gap-2">
              <p className="text-[10px] font-mono text-muted-foreground/60">
                {selSource === "file" ? `Remove the saved ${keyProvider} key file` : "Nothing to remove"}
              </p>
              <Button
                onClick={() => {
                  if (confirm(`Delete the saved ${keyProvider} AI key?`)) removeKey.mutate(keyProvider);
                }}
                disabled={!canEdit || selSource !== "file" || removeKey.isPending}
                variant="outline"
                size="sm"
                className="rounded-none border-red-500/30 text-red-400 hover:bg-red-500/10 font-mono text-xs h-8 px-3"
              >
                {removeKey.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Trash2 className="w-3 h-3 mr-1" />}
                REMOVE
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* ── Status / Usage ────────────────────────────────────────────── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
              <Activity className="w-4 h-4 text-cyan-400" /> Status &amp; Recent Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="p-5 space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Model" value="Llama-3.1-70B" />
              <Stat label="Provider" value="NVIDIA NIM" />
              <Stat label="Recent calls" value={String(status?.recentCount ?? 0)} />
            </div>
            <div>
              <p className="text-[10px] font-mono uppercase text-muted-foreground/60 mb-2">Recent events (log source: ai-*)</p>
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {status?.recentEvents?.length ? (
                  status.recentEvents.map((ev, i) => (
                    <div key={i} className="text-[10px] font-mono border border-primary/10 bg-white/[0.02] px-2 py-1.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className={`uppercase ${ev.level === "ERROR" ? "text-red-400" : ev.level === "SUCCESS" ? "text-emerald-400" : "text-cyan-400"}`}>
                          {ev.source}
                        </span>
                        <span className="text-muted-foreground/50 text-[9px]">
                          {new Date(ev.createdAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <div className="text-foreground/70 truncate" title={ev.message}>{ev.message}</div>
                    </div>
                  ))
                ) : (
                  <p className="text-[10px] font-mono text-muted-foreground/40 italic">No AI activity yet</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Inline chat ──────────────────────────────────────────────────── */}
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06]">
          <div className="flex items-center justify-between">
            <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" /> Chat
            </CardTitle>
            <Button onClick={clearChat} disabled={!chat.length} variant="outline" size="sm"
              className="rounded-none border-red-500/30 text-red-400 hover:bg-red-500/10 font-mono text-[10px] h-7 px-2">
              CLEAR
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div ref={scrollRef} className="max-h-[400px] min-h-[200px] overflow-y-auto p-4 space-y-3 bg-black/10">
            {chat.length === 0 ? (
              <p className="text-center text-[11px] font-mono text-muted-foreground/40 py-12">
                Ask the AI anything — gate config questions, error log analysis, code snippets.<br />
                History is saved locally and stays within this browser.
              </p>
            ) : (
              chat.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] px-3 py-2 font-mono text-xs whitespace-pre-wrap break-words ${
                    msg.role === "user"
                      ? "bg-primary/10 text-foreground border border-primary/30"
                      : "bg-white/[0.03] text-foreground/90 border border-cyan-500/20"
                  }`}>
                    {msg.content}
                  </div>
                </div>
              ))
            )}
            {sending && (
              <div className="flex justify-start">
                <div className="bg-white/[0.03] text-cyan-400 border border-cyan-500/20 px-3 py-2 font-mono text-xs">
                  <Loader2 className="w-3 h-3 animate-spin inline mr-2" /> thinking…
                </div>
              </div>
            )}
          </div>
          <div className="border-t border-primary/20 p-3 flex gap-2 bg-white/[0.02]">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              placeholder={status?.configured ? "Type a question, Shift+Enter for newline…" : "Set the AI key above to start chatting"}
              disabled={!status?.configured || sending}
              rows={2}
              className="rounded-none border-primary/20 font-mono text-xs bg-white/[0.03] resize-none flex-1"
            />
            <Button
              onClick={send}
              disabled={!status?.configured || !draft.trim() || sending}
              className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-auto px-4"
            >
              {sending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Classifier mode (strict-decline global toggle) ──────────────── */}
      <ClassifierModePanel />

      {/* ── Gate Reconfigurer (multi-select, preview/apply) ────────────── */}
      <ReconfigurerPanel keyConfigured={!!status?.configured} />

      {/* ── Analyzer (background learning loop) ─────────────────────────── */}
      <AnalyzerPanel keyConfigured={!!status?.configured} />

      {/* ── Quick links ─────────────────────────────────────────────────── */}
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06]">
          <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
            <CheckCircle className="w-4 h-4 text-emerald-400" /> AI Workflows
          </CardTitle>
        </CardHeader>
        <CardContent className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3 text-[11px] font-mono">
          <div className="border border-white/[0.06] bg-white/[0.02] p-3 space-y-1">
            <p className="text-primary text-[10px] uppercase">Gate Reconfigurer</p>
            <p className="text-foreground/70">Same flow as above — also available on the System Status dashboard with an AUTO mode that re-runs every 5 minutes.</p>
            <a href="/" className="text-cyan-400 hover:underline">→ Open System Status</a>
          </div>
          <div className="border border-white/[0.06] bg-white/[0.02] p-3 space-y-1">
            <p className="text-primary text-[10px] uppercase">Telegram /aiconfig</p>
            <p className="text-foreground/70">One-tap analyzer in the Telegram bot. Re-detects URL, scrapes hints, asks the LLM, previews before applying.</p>
            <span className="text-muted-foreground/50">Run from your Telegram chat with the bot.</span>
          </div>
          <div className="border border-white/[0.06] bg-white/[0.02] p-3 space-y-1">
            <p className="text-primary text-[10px] uppercase">Telegram /ai</p>
            <p className="text-foreground/70">Same chat as above, but from your phone. Multi-turn, capped at 20 messages per admin.</p>
            <span className="text-muted-foreground/50">Use /ai &lt;question&gt; in Telegram.</span>
          </div>
          <div className="border border-white/[0.06] bg-white/[0.02] p-3 space-y-1">
            <p className="text-primary text-[10px] uppercase">Failure Pattern Analysis</p>
            <p className="text-foreground/70">Per-gate "Analyze" button surfaces rule-based fixes from the last 200 check results. Lives in the gate edit dialog.</p>
            <a href="/configs" className="text-cyan-400 hover:underline">→ Open Gate Configs</a>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function ClassifierModePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ strictDeclineMode: boolean; updatedAt: string | null; strictCodes: string[] }>({
    queryKey: ["/api/classifier/mode"],
  });
  const toggle = useMutation({
    mutationFn: async (on: boolean) => {
      const r = await apiRequest("POST", "/api/classifier/mode", { strictDeclineMode: on });
      return r.json();
    },
    onSuccess: (d: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/classifier/mode"] });
      toast({ title: d.strictDeclineMode ? "STRICT MODE ON" : "STRICT MODE OFF", description: d.strictDeclineMode ? "Ambiguous declines now classify as DEAD globally." : "Default (lenient) classifier behavior restored." });
    },
    onError: (e: any) => toast({ title: "TOGGLE FAILED", description: e.message, variant: "destructive" }),
  });
  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-yellow-400" /> Strict Decline Mode
            {data?.strictDeclineMode && (
              <span className="text-[9px] font-mono text-red-400 border border-red-500/40 bg-red-500/5 px-1.5 py-0.5 ml-1">ON</span>
            )}
          </CardTitle>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-mono text-muted-foreground">
              {data?.strictDeclineMode ? "ON" : "OFF"}
            </span>
            <Switch
              checked={data?.strictDeclineMode === true}
              disabled={toggle.isPending}
              onCheckedChange={(v) => toggle.mutate(v)}
              className="data-[state=checked]:bg-red-500"
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-3">
        <p className="text-[11px] font-mono text-muted-foreground/80 leading-relaxed">
          When <span className="text-red-400 font-bold">ON</span>, these decline codes are forced to <span className="text-red-400 font-bold">DEAD</span> globally instead of CCN LIVE. Useful for a high-precision live pool where you want to drop ambiguous bank refusals.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {(data?.strictCodes || []).map(c => (
            <span key={c} className={`text-[10px] font-mono border px-2 py-0.5 ${data?.strictDeclineMode ? "border-red-500/40 bg-red-500/5 text-red-400" : "border-white/[0.06] bg-white/[0.02] text-muted-foreground"}`}>
              {c}
            </span>
          ))}
        </div>
        <div className="text-[10px] font-mono text-muted-foreground/60 space-y-0.5 border-t border-primary/10 pt-2">
          <p>• Per-gate <span className="text-cyan-400">liveOverrides</span> / <span className="text-cyan-400">deadOverrides</span> still win over this global setting.</p>
          <p>• <span className="text-cyan-400">insufficient_funds</span>, <span className="text-cyan-400">incorrect_cvc</span>, <span className="text-cyan-400">incorrect_zip</span>, and other specific bank signals stay LIVE regardless.</p>
          <p>• When ON, response strings get a <span className="text-cyan-400">(strict)</span> suffix so you can audit which declines were policy-flipped.</p>
          {data?.updatedAt && <p className="opacity-60">Last changed: {new Date(data.updatedAt).toLocaleString()}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

function ReconfigurerPanel({ keyConfigured }: { keyConfigured: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: gates } = useQuery<any[]>({ queryKey: ["/api/gates"] });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<any>(null);
  const [model] = useState("meta/llama-3.1-70b-instruct");

  const gateList = (gates as any[]) || [];
  const activeGates = gateList.filter(g => g.active);

  const run = useMutation({
    mutationFn: async ({ apply }: { apply: boolean }) => {
      const ids = selected.size > 0 ? [...selected] : activeGates.map((g: any) => g.id);
      if (ids.length === 0) throw new Error("No gates available");
      const r = await apiRequest("POST", "/api/ai/reconfigure-gates", {
        model,
        gateIds: ids,
        autoApply: apply,
      });
      return r.json();
    },
    onSuccess: (result: any, vars) => {
      if (vars.apply) {
        setPreview(null);
        queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
        toast({ title: "APPLIED", description: `${result.applied ?? result.gates?.length ?? 0} gate(s) reconfigured` });
      } else {
        setPreview(result);
        toast({ title: "PREVIEW READY", description: `${result.gates?.length ?? 0} gate(s) — review then APPLY` });
      }
    },
    onError: (e: any) => toast({ title: "AI ERROR", description: e.message, variant: "destructive" }),
  });

  const applyPreview = useMutation({
    mutationFn: async () => {
      if (!preview?.gates?.length) throw new Error("Nothing to apply");
      const r = await apiRequest("POST", "/api/ai/apply-changes", {
        gates: preview.gates.map((g: any) => ({ id: g.id, changes: g.changes })),
      });
      return r.json();
    },
    onSuccess: (result: any) => {
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      toast({ title: "APPLIED", description: `${result.applied} gate(s) updated` });
    },
    onError: (e: any) => toast({ title: "APPLY FAILED", description: e.message, variant: "destructive" }),
  });

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };
  const selectAll = () => setSelected(new Set(activeGates.map(g => g.id)));
  const selectNone = () => setSelected(new Set());

  const effectiveCount = selected.size > 0 ? selected.size : activeGates.length;

  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" /> Gate Reconfigurer
          </CardTitle>
          <span className="text-[10px] font-mono text-muted-foreground">
            {selected.size > 0 ? `${selected.size} selected` : `all ${activeGates.length} active`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">
          AI fills in billing identity, currency, proxy country, platform settings, etc. to maximize approval rate and minimize Stripe Radar risk score for each gate. Country is inferred from the URL TLD.
        </p>

        {/* Selection list */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <p className="text-[10px] font-mono uppercase text-muted-foreground/60">Select gates</p>
            <div className="flex gap-2">
              <Button onClick={selectAll} size="sm" variant="ghost" className="h-6 px-2 text-[10px] font-mono">ALL</Button>
              <Button onClick={selectNone} size="sm" variant="ghost" className="h-6 px-2 text-[10px] font-mono">NONE</Button>
            </div>
          </div>
          <div className="max-h-44 overflow-y-auto border border-white/[0.06] bg-white/[0.02] divide-y divide-primary/5">
            {activeGates.length === 0 ? (
              <p className="text-[10px] font-mono text-muted-foreground/40 italic p-3">No active gates</p>
            ) : (
              activeGates.map((g: any) => {
                const isOn = selected.has(g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => toggle(g.id)}
                    className={`w-full flex items-center gap-2 px-2.5 py-1.5 text-left hover:bg-primary/5 font-mono text-[10px] ${isOn ? "bg-primary/10" : ""}`}
                  >
                    <span className={`w-3 h-3 border ${isOn ? "border-emerald-500 bg-emerald-500/20" : "border-primary/30"} flex items-center justify-center shrink-0`}>
                      {isOn && <CheckCircle className="w-2 h-2 text-emerald-400" />}
                    </span>
                    <span className="text-foreground/90 truncate flex-1">{g.name}</span>
                    <span className="text-muted-foreground/50 text-[9px] uppercase">{g.gateType}</span>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex gap-2 flex-wrap">
          <Button
            onClick={() => run.mutate({ apply: false })}
            disabled={!keyConfigured || run.isPending || activeGates.length === 0}
            variant="outline"
            className="rounded-none border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 font-mono text-xs h-9 px-4"
          >
            {run.isPending && !run.variables?.apply ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Eye className="w-3 h-3 mr-1" />}
            PREVIEW
          </Button>
          <Button
            onClick={() => run.mutate({ apply: true })}
            disabled={!keyConfigured || run.isPending || activeGates.length === 0}
            className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-9 px-4"
          >
            {run.isPending && run.variables?.apply ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
            RUN + APPLY
          </Button>
          <span className="text-[10px] font-mono text-muted-foreground self-center ml-2">
            target: {effectiveCount} gate(s)
          </span>
        </div>

        {!keyConfigured && (
          <div className="border border-yellow-500/20 bg-yellow-500/5 text-yellow-400 font-mono text-[10px] px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
            Set the AI key above to use the reconfigurer.
          </div>
        )}

        {/* Preview output */}
        {preview && (
          <div className="space-y-2">
            <div className="flex items-center justify-between border-b border-primary/10 pb-1">
              <p className="text-[10px] font-mono uppercase text-cyan-400">Preview · {preview.gates?.length || 0} gate(s)</p>
              <div className="flex gap-2">
                <Button onClick={() => applyPreview.mutate()} disabled={applyPreview.isPending} size="sm"
                  className="h-6 px-3 rounded-none bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 font-mono text-[10px]">
                  {applyPreview.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                  APPLY ALL
                </Button>
                <Button onClick={() => setPreview(null)} size="sm" variant="ghost"
                  className="h-6 px-2 rounded-none text-muted-foreground hover:text-foreground font-mono text-[10px]">
                  DISCARD
                </Button>
              </div>
            </div>
            {preview.analysis && (
              <p className="text-[11px] font-mono text-foreground/80 border border-white/[0.06] bg-white/[0.02] p-2">{preview.analysis}</p>
            )}
            <div className="space-y-1 max-h-72 overflow-y-auto">
              {(preview.gates || []).map((g: any) => (
                <div key={g.id} className="border border-white/[0.06] bg-white/[0.02] p-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <span className="font-mono text-xs text-foreground">{g.name}</span>
                    <span className="font-mono text-[9px] text-muted-foreground/60">
                      detected: {g.detectedCountry || "?"} · {Object.keys(g.changes || {}).length} field(s)
                    </span>
                  </div>
                  {g.reason && <p className="font-mono text-[10px] text-yellow-400/80 mt-1">{g.reason}</p>}
                  <div className="flex items-center gap-1 flex-wrap mt-1">
                    {Object.entries(g.changes || {}).slice(0, 8).map(([k, v]: any) => (
                      <span key={k} className="border border-primary/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[9px]">
                        <span className="text-cyan-400">{k}</span>
                        <span className="text-muted-foreground">=</span>
                        <span className="text-foreground/80">{String(v) || "(empty)"}</span>
                      </span>
                    ))}
                    {Object.keys(g.changes || {}).length > 8 && (
                      <span className="font-mono text-[9px] text-muted-foreground/50">+{Object.keys(g.changes).length - 8} more</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface AnalyzerStatus {
  enabled: boolean;
  lastRunAt: string | null;
  lastRunStatus: string;
  cycleCount: number;
  suggestionCount: number;
  pendingCount: number;
}

interface AISuggestion {
  id: string;
  gateId: string;
  gateName: string;
  createdAt: string;
  status: "pending" | "applied" | "dismissed";
  failureRate: number;
  sampleCount: number;
  samples: string[];
  analysis: string;
  changes: Record<string, any>;
  confidence: number;
  reason: string;
}

function AnalyzerPanel({ keyConfigured }: { keyConfigured: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const { data: analyzer } = useQuery<AnalyzerStatus>({
    queryKey: ["/api/ai/analyzer/status"],
    refetchInterval: 10_000,
  });
  const { data: suggestionsData } = useQuery<{ suggestions: AISuggestion[] }>({
    queryKey: ["/api/ai/suggestions"],
    refetchInterval: 15_000,
  });

  const toggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const r = await apiRequest("POST", "/api/ai/analyzer/toggle", { enabled });
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/analyzer/status"] });
      toast({ title: data.enabled ? "ANALYZER ON" : "ANALYZER OFF", description: data.enabled ? "Background loop will scan every 10 minutes." : "Background loop stopped." });
    },
    onError: (e: any) => toast({ title: "TOGGLE FAILED", description: e.message, variant: "destructive" }),
  });

  const runNow = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", "/api/ai/analyzer/run", {});
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/analyzer/status"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ai/suggestions"] });
      toast({ title: "ANALYSIS COMPLETE", description: `${data.scanned} scanned · ${data.suggested} new suggestion(s)` });
    },
    onError: (e: any) => toast({ title: "RUN FAILED", description: e.message, variant: "destructive" }),
  });

  const apply = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("POST", `/api/ai/suggestions/${id}/apply`, {});
      return r.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/suggestions"] });
      queryClient.invalidateQueries({ queryKey: ["/api/gates"] });
      toast({ title: "APPLIED", description: `${data.applied} field(s) merged into gate settings.` });
    },
    onError: (e: any) => toast({ title: "APPLY FAILED", description: e.message, variant: "destructive" }),
  });

  const dismiss = useMutation({
    mutationFn: async (id: string) => {
      const r = await apiRequest("POST", `/api/ai/suggestions/${id}/dismiss`, {});
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/ai/suggestions"] });
      toast({ title: "DISMISSED" });
    },
    onError: (e: any) => toast({ title: "DISMISS FAILED", description: e.message, variant: "destructive" }),
  });

  const suggestions = suggestionsData?.suggestions || [];

  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <CardTitle className="font-display tracking-widest text-base flex items-center gap-2">
            <FlaskConical className="w-4 h-4 text-yellow-400" /> AI Analyzer
            {analyzer?.enabled && <span className="text-[9px] font-mono text-emerald-400 border border-emerald-500/40 bg-emerald-500/5 px-1.5 py-0.5 ml-1">RUNNING</span>}
          </CardTitle>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => runNow.mutate()}
              disabled={!keyConfigured || runNow.isPending}
              variant="outline"
              size="sm"
              className="rounded-none border-cyan-500/40 text-cyan-400 hover:bg-cyan-500/10 font-mono text-[10px] h-7 px-2"
              title="Run a cycle right now without waiting for the next scheduled tick"
            >
              {runNow.isPending ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Play className="w-3 h-3 mr-1" />}
              RUN NOW
            </Button>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-mono text-muted-foreground">
                {analyzer?.enabled ? "ON" : "OFF"}
              </span>
              <Switch
                checked={analyzer?.enabled === true}
                disabled={!keyConfigured || toggle.isPending}
                onCheckedChange={(v) => toggle.mutate(v)}
                className="data-[state=checked]:bg-emerald-500"
              />
            </div>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        <p className="text-[11px] font-mono text-muted-foreground/70 leading-relaxed">
          When ON, the analyzer samples raw failure responses from every active gate every 10 minutes and asks the LLM what setting changes would unblock each. Suggestions appear below — review and APPLY one click at a time.
          <br />
          <span className="text-muted-foreground/50">Never auto-applies. Cost-capped at 5 LLM calls per cycle. Skips gates that have any recent approval.</span>
        </p>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <Stat label="Cycles" value={String(analyzer?.cycleCount ?? 0)} />
          <Stat label="Suggestions" value={String(analyzer?.suggestionCount ?? 0)} />
          <Stat label="Pending" value={String(analyzer?.pendingCount ?? 0)} />
          <Stat label="Last run" value={analyzer?.lastRunAt ? new Date(analyzer.lastRunAt).toLocaleTimeString() : "—"} />
        </div>

        {analyzer?.lastRunStatus && analyzer.lastRunStatus !== "idle" && (
          <p className="text-[10px] font-mono text-muted-foreground/50 italic">Last: {analyzer.lastRunStatus}</p>
        )}

        {!keyConfigured && (
          <div className="border border-yellow-500/20 bg-yellow-500/5 text-yellow-400 font-mono text-[10px] px-3 py-2 flex items-start gap-2">
            <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
            Set the AI key above to enable the analyzer.
          </div>
        )}

        <div className="space-y-2">
          <p className="text-[10px] font-mono uppercase text-muted-foreground/60 border-b border-primary/10 pb-1">
            Suggestions ({suggestions.filter(s => s.status === "pending").length} pending, {suggestions.length} total)
          </p>
          {suggestions.length === 0 ? (
            <p className="text-[10px] font-mono text-muted-foreground/40 italic py-4">
              No suggestions yet. Toggle the analyzer ON or click RUN NOW.
            </p>
          ) : (
            suggestions.map(sug => {
              const isExpanded = expanded[sug.id] === true;
              return (
                <div
                  key={sug.id}
                  className={`border ${sug.status === "pending" ? "border-yellow-500/20 bg-yellow-500/5" : sug.status === "applied" ? "border-emerald-500/20 bg-emerald-500/5" : "border-primary/10 bg-white/[0.02] opacity-60"} p-3 space-y-2`}
                >
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-mono font-bold text-foreground truncate">{sug.gateName}</span>
                        <span className="text-[9px] font-mono uppercase text-muted-foreground/60">
                          fail {(sug.failureRate * 100).toFixed(0)}% · conf {(sug.confidence * 100).toFixed(0)}% · {new Date(sug.createdAt).toLocaleTimeString()}
                        </span>
                        {sug.status === "applied" && <span className="text-[9px] font-mono text-emerald-400 uppercase">applied</span>}
                        {sug.status === "dismissed" && <span className="text-[9px] font-mono text-muted-foreground uppercase">dismissed</span>}
                      </div>
                      <p className="text-[11px] font-mono text-foreground/80 mt-1">{sug.analysis}</p>
                      <p className="text-[10px] font-mono text-yellow-400/80 mt-1">{sug.reason}</p>
                    </div>
                    {sug.status === "pending" && (
                      <div className="flex gap-1 shrink-0">
                        <Button onClick={() => apply.mutate(sug.id)} disabled={apply.isPending} size="sm"
                          className="h-6 px-2 rounded-none bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 hover:bg-emerald-500/30 font-mono text-[10px]">
                          APPLY
                        </Button>
                        <Button onClick={() => dismiss.mutate(sug.id)} disabled={dismiss.isPending} size="sm" variant="ghost"
                          className="h-6 px-2 rounded-none text-red-400 hover:bg-red-500/10 font-mono text-[10px]">
                          DISMISS
                        </Button>
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
                    {Object.entries(sug.changes).map(([k, v]) => (
                      <span key={k} className="border border-white/[0.06] bg-white/[0.02] px-1.5 py-0.5">
                        <span className="text-cyan-400">{k}</span>
                        <span className="text-muted-foreground">=</span>
                        <span className="text-foreground/80">{Array.isArray(v) ? v.join(",") : String(v) || "(empty)"}</span>
                      </span>
                    ))}
                  </div>
                  <button
                    onClick={() => setExpanded(p => ({ ...p, [sug.id]: !isExpanded }))}
                    className="text-[10px] font-mono text-muted-foreground/60 hover:text-foreground flex items-center gap-1"
                  >
                    {isExpanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                    {isExpanded ? "Hide" : "Show"} {sug.sampleCount} raw response samples
                  </button>
                  {isExpanded && (
                    <div className="space-y-1 pt-1">
                      {sug.samples.map((s, i) => (
                        <pre key={i} className="text-[9px] font-mono text-foreground/60 border border-primary/10 bg-white/[0.03] p-2 whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
                          [{i + 1}] {s}
                        </pre>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-white/[0.06] bg-white/[0.02] p-2 text-center">
      <p className="text-[9px] font-mono uppercase text-muted-foreground/50">{label}</p>
      <p className="text-xs font-mono font-bold text-cyan-400 mt-0.5 truncate">{value}</p>
    </div>
  );
}
