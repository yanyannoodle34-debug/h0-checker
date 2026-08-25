import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Settings, Save, Bot, Play, Square, Eye, EyeOff, Loader2,
  Hash, Bell, Zap, Shield, Key, MessageSquare, DollarSign,
  Users, Wand2, Crosshair, RefreshCw, AlertTriangle, Cpu, Clock,
} from "lucide-react";

export default function BotSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: settings, isLoading } = useQuery<any>({
    queryKey: ["/api/bot-settings"],
    refetchInterval: 10000,
  });

  // Local editable state — mirrors DB, populated once loaded
  const [token, setToken]             = useState("");
  const [chatId, setChatId]           = useState("");
  const [ownerId, setOwnerId]         = useState("");
  const [adminPwd, setAdminPwd]       = useState("");
  const [showToken, setShowToken]     = useState(false);
  const [showPwd, setShowPwd]         = useState(false);

  // Toggles
  const [parallelMode, setParallelMode]             = useState(true);
  const [sendLive, setSendLive]                     = useState(true);
  const [proxyFileOutput, setProxyFileOutput]       = useState(true);
  const [lstmAutoTrain, setLstmAutoTrain]           = useState(true);
  const [hitterEnabled, setHitterEnabled]           = useState(true);
  const [genEnabled, setGenEnabled]                 = useState(true);

  // Amount / limit settings
  const [defaultDailyLimit, setDefaultDailyLimit]         = useState(100);
  const [defaultKeyDuration, setDefaultKeyDuration]       = useState(30);
  const [maxGenPerRequest, setMaxGenPerRequest]           = useState(10);

  // Mass check parallelism + velocity guard
  const [massWorkers, setMassWorkers]               = useState(1);
  const [massDedup, setMassDedup]                   = useState(true);
  const [massVelocityMins, setMassVelocityMins]     = useState(15);

  // Free-tier (channel-member /chk-only access)
  const [freeTierEnabled, setFreeTierEnabled]       = useState(false);
  const [freeTierDailyLimit, setFreeTierDailyLimit] = useState(5);

  // Welcome message
  const [welcomeMessage, setWelcomeMessage] = useState("");

  // Populate from DB when loaded
  useEffect(() => {
    if (!settings) return;
    setToken(settings.botToken || "");
    setChatId(settings.chatId || "");
    setOwnerId(settings.ownerId || "");
    setAdminPwd(settings.adminPassword || "");
    setParallelMode(settings.parallelMode ?? true);
    setSendLive(settings.sendLiveToChannel ?? true);
    setProxyFileOutput(settings.proxyFileOutput ?? true);
    setLstmAutoTrain(settings.lstmAutoTrain ?? true);
    setHitterEnabled(settings.hitterEnabled ?? true);
    setGenEnabled(settings.genEnabled ?? true);
    setDefaultDailyLimit(settings.defaultDailyLimit ?? 100);
    setDefaultKeyDuration(settings.defaultKeyDurationDays ?? 30);
    setMaxGenPerRequest(settings.maxGenPerRequest ?? 10);
    setMassWorkers(settings.massWorkers ?? 1);
    setMassDedup(settings.massDedup ?? true);
    setMassVelocityMins(settings.massVelocityMins ?? 15);
    setFreeTierEnabled(settings.freeTierEnabled ?? false);
    setFreeTierDailyLimit(settings.freeTierDailyLimit ?? 5);
    setWelcomeMessage(settings.welcomeMessage || "");
  }, [settings]);

  const saveMutation = useMutation({
    mutationFn: async (payload: any) => {
      const res = await apiRequest("PATCH", "/api/bot-settings", payload);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "✅ SAVED", description: "Bot settings updated." });
    },
    onError: (e: any) => {
      toast({ title: "SAVE FAILED", description: e.message, variant: "destructive" });
    },
  });

  const startMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/start");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "BOT ONLINE", description: "Telegram bot polling started." });
    },
    onError: (e: any) => {
      toast({ title: "START FAILED", description: e.message, variant: "destructive" });
    },
  });

  const stopMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/bot/stop");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-settings"] });
      toast({ title: "BOT OFFLINE", description: "Telegram bot stopped.", variant: "destructive" });
    },
  });

  const handleSaveAll = () => {
    saveMutation.mutate({
      botToken: token || null,
      chatId: chatId || null,
      ownerId: ownerId || null,
      adminPassword: adminPwd || "926696",
      parallelMode,
      sendLiveToChannel: sendLive,
      proxyFileOutput,
      lstmAutoTrain,
      hitterEnabled,
      genEnabled,
      defaultDailyLimit,
      defaultKeyDurationDays: defaultKeyDuration,
      maxGenPerRequest,
      massWorkers,
      massDedup,
      massVelocityMins,
      freeTierEnabled,
      freeTierDailyLimit,
      welcomeMessage: welcomeMessage || null,
    });
  };

  const isRunning = settings?.botRunning ?? false;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text">Bot Settings</h2>
          <p className="text-muted-foreground font-mono mt-1">Configure Telegram bot &amp; system limits</p>
        </div>
        <div className="flex gap-3">
          {isRunning ? (
            <Button
              onClick={() => stopMutation.mutate()}
              disabled={stopMutation.isPending}
              variant="destructive"
              className="rounded-none font-display font-bold tracking-widest"
            >
              {stopMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Square className="w-4 h-4 mr-2" />}
              STOP BOT
            </Button>
          ) : (
            <Button
              onClick={() => startMutation.mutate()}
              disabled={startMutation.isPending || !token}
              className="rounded-none font-display font-bold tracking-widest bg-primary text-black hover:bg-primary hover:text-black"
            >
              {startMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Play className="w-4 h-4 mr-2" />}
              START BOT
            </Button>
          )}
          <Button
            onClick={handleSaveAll}
            disabled={saveMutation.isPending}
            className="rounded-none font-display font-bold tracking-widest bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500 hover:text-black"
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : <Save className="w-4 h-4 mr-2" />}
            SAVE ALL
          </Button>
        </div>
      </div>

      {/* Bot Status Banner */}
      <div className={`p-3 border font-mono text-xs flex items-center gap-3 ${
        isRunning
          ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-400"
          : "bg-red-500/10 border-red-500/30 text-red-400"
      }`}>
        <div className={`w-2 h-2 rounded-full ${isRunning ? "bg-emerald-500 animate-pulse" : "bg-red-500"}`} />
        {isRunning ? "BOT ONLINE — polling active" : "BOT OFFLINE — set token and press START BOT"}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">

        {/* ── Telegram Connection ── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Bot className="w-4 h-4 text-primary" />
              Telegram Connection
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Bot Token</Label>
              <div className="relative">
                <Input
                  type={showToken ? "text" : "password"}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  placeholder="123456789:AABBcc..."
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono text-xs focus-visible:ring-primary pr-10"
                />
                <button
                  onClick={() => setShowToken(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Get from @BotFather → /newbot</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Channel / Chat ID (Live Notify)</Label>
              <div className="relative flex items-center">
                <Hash className="w-4 h-4 text-muted-foreground absolute left-3" />
                <Input
                  type="text"
                  value={chatId}
                  onChange={(e) => setChatId(e.target.value)}
                  placeholder="-100xxxxxxxxx"
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono text-xs focus-visible:ring-primary pl-9"
                />
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Channel/group where LIVE cards are forwarded</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Owner Telegram ID</Label>
              <div className="relative flex items-center">
                <Shield className="w-4 h-4 text-muted-foreground absolute left-3" />
                <Input
                  type="text"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder="123456789"
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono text-xs focus-visible:ring-primary pl-9"
                />
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Auto-granted owner role on /start</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Admin Password (for /login)</Label>
              <div className="relative">
                <Input
                  type={showPwd ? "text" : "password"}
                  value={adminPwd}
                  onChange={(e) => setAdminPwd(e.target.value)}
                  placeholder="••••••"
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono text-xs focus-visible:ring-primary pr-10"
                />
                <button
                  onClick={() => setShowPwd(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                >
                  {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Limits & Amounts ── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <DollarSign className="w-4 h-4 text-primary" />
              Limits &amp; Amounts
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Default Daily Check Limit</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={100000}
                  value={defaultDailyLimit}
                  onChange={(e) => setDefaultDailyLimit(parseInt(e.target.value) || 100)}
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary"
                />
                <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">checks/day</span>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Applied to new users on /start</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Default Key Duration</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={3650}
                  value={defaultKeyDuration}
                  onChange={(e) => setDefaultKeyDuration(parseInt(e.target.value) || 30)}
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary"
                />
                <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">days</span>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Pre-filled default when generating keys</p>
            </div>

            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Max Cards per /gen Request</Label>
              <div className="flex items-center gap-3">
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={maxGenPerRequest}
                  onChange={(e) => setMaxGenPerRequest(parseInt(e.target.value) || 10)}
                  className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary"
                />
                <span className="text-xs font-mono text-muted-foreground whitespace-nowrap">cards</span>
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">Per-user cap; admins get 3× this</p>
            </div>

            {/* Quick presets */}
            <div className="pt-2 border-t border-primary/10">
              <Label className="text-xs font-mono text-muted-foreground uppercase mb-2 block">Quick Presets</Label>
              <div className="flex gap-2 flex-wrap">
                {[
                  { label: "Trial", limit: 50, duration: 7 },
                  { label: "Basic", limit: 200, duration: 30 },
                  { label: "Pro", limit: 1000, duration: 30 },
                  { label: "Unlimited", limit: 99999, duration: 365 },
                ].map(p => (
                  <button
                    key={p.label}
                    onClick={() => { setDefaultDailyLimit(p.limit); setDefaultKeyDuration(p.duration); }}
                    className="px-3 py-1 text-[10px] font-mono border border-white/[0.08] text-primary/70 hover:border-primary hover:text-primary transition-colors"
                  >
                    {p.label} ({p.limit}/d · {p.duration}d)
                  </button>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Bot Features ── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Zap className="w-4 h-4 text-primary" />
              Bot Features
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-5">
            {[
              {
                id: "hitter",
                label: "/hit Command",
                desc: "Allow redeemed users to run the checkout hitter via bot",
                icon: Crosshair,
                value: hitterEnabled,
                setter: setHitterEnabled,
              },
              {
                id: "gen",
                label: "/gen Command",
                desc: "Allow redeemed users to generate cards by BIN via bot",
                icon: Wand2,
                value: genEnabled,
                setter: setGenEnabled,
              },
              {
                id: "parallel",
                label: "Parallel Mode",
                desc: "Run mass checks in parallel sessions for speed",
                icon: Zap,
                value: parallelMode,
                setter: setParallelMode,
              },
              {
                id: "sendLive",
                label: "Forward LIVE to Channel",
                desc: "Send approved CC results to the configured channel",
                icon: Bell,
                value: sendLive,
                setter: setSendLive,
              },
              {
                id: "proxyFile",
                label: "Proxy File Auto-Send",
                desc: "Send proxy scrub results to Telegram automatically",
                icon: RefreshCw,
                value: proxyFileOutput,
                setter: setProxyFileOutput,
              },
              {
                id: "lstm",
                label: "LSTM Auto-Train",
                desc: "Continuously train neural network on new check results",
                icon: Zap,
                value: lstmAutoTrain,
                setter: setLstmAutoTrain,
              },
            ].map(({ id, label, desc, icon: Icon, value, setter }) => (
              <div key={id} className="flex items-start justify-between gap-4">
                <div className="flex items-start gap-3 min-w-0">
                  <Icon className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <div className="text-sm font-mono text-foreground">{label}</div>
                    <div className="text-[10px] text-muted-foreground font-mono">{desc}</div>
                  </div>
                </div>
                <Switch
                  checked={value}
                  onCheckedChange={setter}
                  className="shrink-0 data-[state=checked]:bg-primary"
                />
              </div>
            ))}
          </CardContent>
        </Card>

        {/* ── Mass Check Parallelism ── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Cpu className="w-4 h-4 text-primary" />
              Mass Check Engine
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-6">
            {/* Worker count slider */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-primary" />
                  <Label className="font-mono text-sm">Parallel Workers</Label>
                </div>
                <span className="font-mono text-primary text-sm font-bold">
                  {massWorkers === 1 ? "1 (sequential)" : `${massWorkers}×`}
                </span>
              </div>
              <input
                type="range"
                min={1}
                max={8}
                step={1}
                value={massWorkers}
                onChange={e => setMassWorkers(Number(e.target.value))}
                className="w-full accent-[hsl(152,70%,50%)] cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground font-mono px-0.5">
                {[1,2,3,4,5,6,7,8].map(n => (
                  <span key={n} className={massWorkers === n ? "text-primary font-bold" : ""}>{n}</span>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground font-mono">
                {massWorkers === 1
                  ? "Sequential — one card at a time. Safest, slowest."
                  : massWorkers <= 3
                  ? `${massWorkers} workers — moderate speed, low resource use.`
                  : massWorkers <= 6
                  ? `${massWorkers} workers — fast parallel checking.`
                  : `${massWorkers} workers — maximum speed, higher memory use on mobile.`}
              </p>
            </div>

            {/* Dedup toggle */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-start gap-3 min-w-0">
                <Shield className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-sm font-mono text-foreground">Velocity / Dedup Guard</div>
                  <div className="text-[10px] text-muted-foreground font-mono">
                    Dedup batch by PAN + skip cards checked within the window
                  </div>
                </div>
              </div>
              <Switch
                checked={massDedup}
                onCheckedChange={setMassDedup}
                className="shrink-0 data-[state=checked]:bg-primary"
              />
            </div>

            {/* Velocity window */}
            <div className={`space-y-1 transition-opacity ${massDedup ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
              <div className="flex items-center gap-2">
                <Clock className="w-4 h-4 text-primary" />
                <Label htmlFor="velWindow" className="font-mono text-sm">Velocity Window (minutes)</Label>
              </div>
              <Input
                id="velWindow"
                type="number"
                min={1}
                max={1440}
                value={massVelocityMins}
                onChange={e => setMassVelocityMins(Number(e.target.value) || 15)}
                className="bg-background/50 border-white/[0.08] font-mono max-w-[120px]"
              />
              <p className="text-[10px] text-muted-foreground font-mono">
                Cards checked within this window are skipped. Use /massdedup clear to reset.
              </p>
            </div>

            {/* Free-tier (channel-member /chk-only access) */}
            <div className="pt-4 border-t border-primary/20 space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5 flex-1 min-w-0">
                  <Label htmlFor="freeTierEnabled" className="font-mono text-sm">Free Tier (Channel Members)</Label>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    When ON, anyone in the configured channel can use /chk without a key
                    (limited by the daily cap below). All other commands still require /redeem.
                  </p>
                </div>
                <Switch
                  id="freeTierEnabled"
                  checked={freeTierEnabled}
                  onCheckedChange={setFreeTierEnabled}
                  className="shrink-0 data-[state=checked]:bg-primary"
                />
              </div>
              <div className={`space-y-1 transition-opacity ${freeTierEnabled ? "opacity-100" : "opacity-40 pointer-events-none"}`}>
                <Label htmlFor="freeTierDailyLimit" className="font-mono text-sm">Free Tier Daily Limit</Label>
                <Input
                  id="freeTierDailyLimit"
                  type="number"
                  min={1}
                  max={1000}
                  value={freeTierDailyLimit}
                  onChange={e => setFreeTierDailyLimit(Number(e.target.value) || 5)}
                  className="bg-background/50 border-white/[0.08] font-mono max-w-[120px]"
                />
                <p className="text-[10px] text-muted-foreground font-mono">
                  Max /chk per free user per day (UTC reset). Default 5.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* ── Welcome Message ── */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              Welcome Message
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <Label className="text-xs font-mono text-muted-foreground uppercase">Custom /start message (optional)</Label>
              <Textarea
                value={welcomeMessage}
                onChange={(e) => setWelcomeMessage(e.target.value)}
                placeholder="Leave blank to use the default H@0 CHK welcome message..."
                rows={5}
                className="bg-background/50 border-white/[0.08] rounded-none font-mono text-xs focus-visible:ring-primary resize-none"
              />
              <p className="text-[10px] text-muted-foreground font-mono">Supports Telegram Markdown. Leave blank for default.</p>
            </div>

            {/* Access gating info */}
            <div className="border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-2">
              <div className="flex items-center gap-2 text-yellow-400 text-xs font-mono font-bold">
                <Key className="w-4 h-4" />
                REDEEM-ONLY ACCESS
              </div>
              <p className="text-[10px] text-muted-foreground font-mono leading-relaxed">
                All bot commands (/chk, /mass, /hit, /gen) require a valid redeemed access key — or admin login.
                Expired keys are blocked automatically.
                Generate keys in the <strong className="text-foreground">Access Keys</strong> page and share them with users.
              </p>
            </div>

            {/* Command reference */}
            <div className="border border-primary/20 bg-primary/5 p-4 space-y-1 font-mono text-[10px]">
              <div className="text-primary font-bold mb-2">BOT COMMANDS (redeemed users)</div>
              {[
                ["/chk CC|MM|YY|CVV", "Check single card"],
                ["/mass", "Mass check (send list or .txt file)"],
                ["/hit URL BIN [count]", "Generate cards from BIN and hit checkout"],
                ["/gen BIN [count]", "Generate cards from BIN"],
                ["/redeem KEY", "Redeem an access key"],
                ["/myinfo", "Your profile & stats"],
                ["/stats", "System stats"],
              ].map(([cmd, desc]) => (
                <div key={cmd} className="flex gap-3">
                  <span className="text-primary w-40 shrink-0">{cmd}</span>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
              <div className="mt-2 pt-2 border-t border-primary/20 text-primary font-bold">ADMIN ONLY</div>
              {[
                ["/login PASS", "Unlock admin features"],
                ["/gates", "List gates"],
                ["/setgate", "Select active gate"],
                ["/addgate type|name|url", "Add a gate"],
                ["/ban / /unban ID", "Manage users"],
                ["/broadcast MSG", "Message all users"],
                ["/download", "Export approved cards"],
                ["/export", "Export results CSV/TXT"],
                ["/reset", "System data reset menu"],
              ].map(([cmd, desc]) => (
                <div key={cmd} className="flex gap-3">
                  <span className="text-yellow-400 w-40 shrink-0">{cmd}</span>
                  <span className="text-muted-foreground">{desc}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Save footer */}
      <div className="flex justify-end pt-2">
        <Button
          onClick={handleSaveAll}
          disabled={saveMutation.isPending}
          size="lg"
          className="rounded-none font-display font-bold tracking-widest bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 hover:bg-emerald-500 hover:text-black px-10"
        >
          {saveMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin mr-2" /> : <Save className="w-5 h-5 mr-2" />}
          SAVE ALL SETTINGS
        </Button>
      </div>

      {/* ── Mass-Check Batch Limits ───────────────────────────────────── */}
      <MassLimitsPanel />

      {/* ── Feature Toggles ────────────────────────────────────────────── */}
      <FeatureTogglesPanel />

      {/* ── CC / BIN Extractor ─────────────────────────────────────────── */}
      <ExtractPanel />
    </div>
  );
}

// ─── Mass-Check Batch Limits Panel ─────────────────────────────────────────
function MassLimitsPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ adminMax: number; userMax: number; hardCap: number; updatedAt: string | null }>({
    queryKey: ["/api/mass-limits"],
  });
  const [adminInput, setAdminInput] = useState("");
  const [userInput, setUserInput] = useState("");
  // Sync inputs once data lands the first time
  useEffect(() => {
    if (data && adminInput === "" && userInput === "") {
      setAdminInput(String(data.adminMax));
      setUserInput(String(data.userMax));
    }
  }, [data, adminInput, userInput]);

  const save = useMutation({
    mutationFn: async ({ tier, value }: { tier: "admin" | "user"; value: number }) => {
      const r = await apiRequest("POST", "/api/mass-limits", { tier, value });
      return r.json();
    },
    onSuccess: (_d, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mass-limits"] });
      toast({ title: "SAVED", description: `${vars.tier} batch limit set to ${vars.value}` });
    },
    onError: (e: any) => toast({ title: "SAVE FAILED", description: e.message, variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: async () => { const r = await apiRequest("DELETE", "/api/mass-limits"); return r.json(); },
    onSuccess: (d: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/mass-limits"] });
      setAdminInput(String(d.adminMax));
      setUserInput(String(d.userMax));
      toast({ title: "RESET", description: "Back to defaults (500 / 50)." });
    },
  });

  const adminBad = adminInput && (!Number.isFinite(+adminInput) || +adminInput < 1 || (data && +adminInput > data.hardCap));
  const userBad  = userInput  && (!Number.isFinite(+userInput)  || +userInput  < 1 || (data && +userInput  > data.hardCap));
  const adminChanged = data && adminInput && +adminInput !== data.adminMax;
  const userChanged  = data && userInput  && +userInput  !== data.userMax;

  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <Hash className="w-5 h-5 text-yellow-400" />
            Mass-Check Batch Limits
          </CardTitle>
          <Button onClick={() => { if (confirm("Reset to defaults (500 admin / 50 user)?")) reset.mutate(); }}
            disabled={reset.isPending} size="sm" variant="outline"
            className="rounded-none border-white/[0.08] text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] h-7 px-2">
            <RefreshCw className="w-3 h-3 mr-1" /> RESET DEFAULTS
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        <p className="text-[11px] font-mono text-muted-foreground/70">
          Cap on how many cards an admin or key-holder can submit in a single <code>/mass</code> run or <code>.txt</code> upload. Server hard cap: <span className="text-yellow-400">{data?.hardCap ?? 5000}</span>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Admin */}
          <div className="space-y-2">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">Admin batch (current: {data?.adminMax ?? "—"})</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={data?.hardCap}
                value={adminInput}
                onChange={(e) => setAdminInput(e.target.value)}
                className={`rounded-none border-primary/20 font-mono text-sm h-9 bg-white/[0.02] ${adminBad ? "border-red-500/60 text-red-400" : ""}`}
              />
              <Button onClick={() => save.mutate({ tier: "admin", value: +adminInput })}
                disabled={save.isPending || !!adminBad || !adminChanged}
                size="sm"
                className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-9 px-3">
                <Save className="w-3 h-3 mr-1" /> SAVE
              </Button>
            </div>
          </div>
          {/* User */}
          <div className="space-y-2">
            <Label className="text-[10px] font-mono uppercase text-muted-foreground/60">User batch (current: {data?.userMax ?? "—"})</Label>
            <div className="flex gap-2">
              <Input
                type="number"
                min={1}
                max={data?.hardCap}
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                className={`rounded-none border-primary/20 font-mono text-sm h-9 bg-white/[0.02] ${userBad ? "border-red-500/60 text-red-400" : ""}`}
              />
              <Button onClick={() => save.mutate({ tier: "user", value: +userInput })}
                disabled={save.isPending || !!userBad || !userChanged}
                size="sm"
                className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-9 px-3">
                <Save className="w-3 h-3 mr-1" /> SAVE
              </Button>
            </div>
          </div>
        </div>
        {data?.updatedAt && (
          <p className="text-[10px] font-mono text-muted-foreground/40 italic">Last changed: {new Date(data.updatedAt).toLocaleString()}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Feature Toggles Panel ─────────────────────────────────────────────────
function FeatureTogglesPanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data } = useQuery<{ features: Array<{ key: string; enabled: boolean }> }>({
    queryKey: ["/api/features"], // sentinel — second hook below uses a distinct key
    refetchInterval: 30_000,
  });
  const toggle = useMutation({
    mutationFn: async ({ key, enabled }: { key: string; enabled: boolean }) => {
      const r = await apiRequest("POST", "/api/features", { key, enabled });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/features"] }),
    onError: (e: any) => toast({ title: "TOGGLE FAILED", description: e.message, variant: "destructive" }),
  });
  const reset = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("DELETE", "/api/features");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/features"] });
      toast({ title: "RESET", description: "All features re-enabled." });
    },
  });
  const features = data?.features || [];
  const { data: mask } = useQuery<{ enabled: boolean; updatedAt: string | null }>({
    queryKey: ["/api/mask-state"],
    refetchInterval: 30_000,
  });
  const maskToggle = useMutation({
    mutationFn: async (enabled: boolean) => {
      const r = await apiRequest("PUT", "/api/mask-state", { enabled });
      return r.json();
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/mask-state"] }),
    onError: (e: any) => toast({ title: "MASK TOGGLE FAILED", description: e.message, variant: "destructive" }),
  });
  // Human labels — keep in sync with FEATURE_KEYS in server/feature-toggles.ts
  const LABELS: Record<string, { label: string; hint: string }> = {
    chk:             { label: "/chk Single Check", hint: "Per-card check command for all bot users" },
    mass:            { label: "/mass Mass Check",  hint: "Bulk card check + .txt upload flow" },
    hit:             { label: "/hit Stripe Hitter", hint: "Single-checkout hit against a known URL" },
    autohit:         { label: "/autohit Loop",      hint: "Recurring auto-hit job (admin)" },
    gen:             { label: "/gen Card Generator", hint: "Generate cards from BIN" },
    miner:           { label: "Server Miner",       hint: "Background mining loop (admin)" },
    ccex:            { label: "/ccex Extractor",    hint: "Pull cards from any pasted text" },
    binex:           { label: "/binex Extractor",   hint: "Pull unique BINs from text" },
    ai_chat:         { label: "/ai Chat",           hint: "NVIDIA Llama-70B admin chat" },
    ai_config:       { label: "/aiconfig",          hint: "AI-powered gate auto-configurator" },
    ai_analyzer:     { label: "AI Analyzer Loop",   hint: "Background failure analyzer" },
    editgate:        { label: "/editgate Editor",   hint: "Interactive gate edit dialog" },
    threeds_inspect: { label: "/3ds Inspector",     hint: "3DS challenge page inspector" },
    watch:           { label: "/watch Subscriptions", hint: "Per-gate live DM alerts" },
    channel_post:    { label: "Channel Notifications", hint: "Broadcast lives to the main channel" },
  };

  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <div className="flex items-center justify-between">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <Zap className="w-5 h-5 text-[hsl(45_100%_50%)]" />
            Feature Toggles
          </CardTitle>
          <Button onClick={() => { if (confirm("Re-enable every feature?")) reset.mutate(); }}
            disabled={reset.isPending} size="sm" variant="outline"
            className="rounded-none border-white/[0.08] text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] h-7 px-2">
            <RefreshCw className="w-3 h-3 mr-1" /> RESET ALL ON
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-5 space-y-3">
        <p className="text-[11px] font-mono text-muted-foreground/70">
          Owner-managed switches for every major Telegram command + the live-card broadcast channel. Flipping a switch takes effect immediately — no bot restart needed. Disabled commands reply with <code>🚫 disabled by the owner</code>.
        </p>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {features.map(f => (
            <div key={f.key} className={`border ${f.enabled ? "border-primary/20" : "border-red-500/30 bg-red-500/5"} p-3 flex items-center justify-between gap-3`}>
              <div className="min-w-0">
                <div className="text-[11px] font-mono font-bold text-foreground truncate">{LABELS[f.key]?.label || f.key}</div>
                <div className="text-[10px] font-mono text-muted-foreground/60 truncate">{LABELS[f.key]?.hint || ""}</div>
              </div>
              <Switch
                checked={f.enabled}
                disabled={toggle.isPending}
                onCheckedChange={(v) => toggle.mutate({ key: f.key, enabled: v })}
                className="data-[state=checked]:bg-primary shrink-0"
              />
            </div>
          ))}
        </div>

        {/* Sensitive-data mask — independent of the per-command toggles above */}
        <div className="border border-primary/20 p-3 flex items-center justify-between gap-3 mt-3">
          <div className="min-w-0">
            <div className="text-[11px] font-mono font-bold text-foreground flex items-center gap-1.5">
              <Shield className="w-3 h-3 text-primary" /> Sensitive Data Mask
            </div>
            <div className="text-[10px] font-mono text-muted-foreground/60">
              When ON: PAN body, CVV, ch_ and pi_ ids are redacted in every Telegram + result render. Outcome, address, bank still visible. Defaults OFF.
            </div>
            <div className="text-[9px] font-mono text-muted-foreground/40 mt-1">
              Mask: <code>411111******1111|12|26|***</code> · <code>ch_***abcd</code> · <code>pi_***wxyz</code>
            </div>
          </div>
          <Switch
            checked={!!mask?.enabled}
            disabled={maskToggle.isPending}
            onCheckedChange={(v) => maskToggle.mutate(v)}
            className="data-[state=checked]:bg-primary shrink-0"
          />
        </div>
      </CardContent>
    </Card>
  );
}

// ─── CC / BIN Extractor Panel ──────────────────────────────────────────────
function ExtractPanel() {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"cards" | "bins">("cards");
  const [binLength, setBinLength] = useState<6 | 8>(6);
  const [output, setOutput] = useState<string>("");
  const [stats, setStats] = useState<string>("");
  const [busy, setBusy] = useState(false);

  const run = async () => {
    if (!text.trim()) {
      toast({ title: "EMPTY", description: "Paste some text first.", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const r = await apiRequest("POST", "/api/extract", { text, mode, binLength });
      const data = await r.json();
      if (mode === "cards") {
        setOutput((data.cards || []).join("\n"));
        const s = data.summary || {};
        setStats(`${data.count} card(s) · ${s.withCvv} full · ${s.withExpiryOnly} no-CVV · ${s.bareBins} bare-PAN`);
      } else {
        setOutput((data.bins || []).join("\n"));
        setStats(`${data.count} unique ${binLength}-digit BIN(s)`);
      }
    } catch (e: any) {
      toast({ title: "EXTRACT FAILED", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  const copyOutput = async () => {
    if (!output) return;
    try { await navigator.clipboard.writeText(output); toast({ title: "COPIED" }); } catch {}
  };

  return (
    <Card className="glass-panel rounded-none">
      <CardHeader className="border-b border-white/[0.06]">
        <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
          <Hash className="w-5 h-5 text-cyan-400" />
          CC / BIN Extractor
        </CardTitle>
      </CardHeader>
      <CardContent className="p-5 space-y-4">
        <p className="text-[11px] font-mono text-muted-foreground/70">
          Paste any text — email, log dump, chat history, OCR output. The extractor pulls valid PANs via Luhn, sniffs nearby expiry + CVV, dedupes, and returns ready-to-use cards or BINs.
        </p>
        <div className="flex gap-2 items-center flex-wrap">
          <div className="flex border border-primary/20 rounded-none">
            <button
              onClick={() => setMode("cards")}
              className={`px-3 py-1.5 text-[10px] font-mono uppercase ${mode === "cards" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-primary/10"}`}
            >Cards</button>
            <button
              onClick={() => setMode("bins")}
              className={`px-3 py-1.5 text-[10px] font-mono uppercase ${mode === "bins" ? "bg-primary/20 text-primary" : "text-muted-foreground hover:bg-primary/10"}`}
            >BINs</button>
          </div>
          {mode === "bins" && (
            <div className="flex border border-primary/20 rounded-none">
              <button
                onClick={() => setBinLength(6)}
                className={`px-3 py-1.5 text-[10px] font-mono ${binLength === 6 ? "bg-cyan-500/20 text-cyan-400" : "text-muted-foreground hover:bg-cyan-500/10"}`}
              >6 digits</button>
              <button
                onClick={() => setBinLength(8)}
                className={`px-3 py-1.5 text-[10px] font-mono ${binLength === 8 ? "bg-cyan-500/20 text-cyan-400" : "text-muted-foreground hover:bg-cyan-500/10"}`}
              >8 digits</button>
            </div>
          )}
          <Button onClick={run} disabled={busy || !text.trim()} size="sm"
            className="rounded-none bg-primary text-black hover:bg-primary hover:text-black font-mono text-xs h-8 px-4 ml-auto">
            {busy ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
            EXTRACT
          </Button>
        </div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Paste raw text here — emails, log dumps, anything containing card data…"
          rows={6}
          className="rounded-none border-primary/20 font-mono text-xs bg-white/[0.02]"
        />
        {(output || stats) && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[10px] font-mono uppercase text-muted-foreground/60">{stats}</p>
              <Button onClick={copyOutput} disabled={!output} size="sm" variant="outline"
                className="rounded-none border-cyan-500/30 text-cyan-400 hover:bg-cyan-500/10 font-mono text-[10px] h-7 px-2">
                COPY
              </Button>
            </div>
            <Textarea
              value={output}
              readOnly
              rows={Math.min(15, (output.match(/\n/g)?.length ?? 0) + 1 || 1)}
              className="rounded-none border-white/[0.06] font-mono text-[11px] bg-white/[0.03] text-foreground"
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
