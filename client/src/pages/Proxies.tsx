import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectTrigger, SelectContent, SelectItem } from "@/components/ui/select";
import {
  Network, RefreshCw, Download, AlertTriangle, Loader2, Trash2,
  Plus, ShieldOff, ShieldCheck, X, List, Lock, Unlock,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function Proxies() {
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // ── add-proxy form state ──────────────────────────────────────────────────
  const [newIp, setNewIp]           = useState("");
  const [newPort, setNewPort]       = useState("");
  const [newProtocol, setNewProtocol] = useState("http");
  const [newUser, setNewUser]       = useState("");
  const [newPass, setNewPass]       = useState("");

  // ── bulk import mode ──────────────────────────────────────────────────────
  const [bulkMode, setBulkMode]   = useState(false);
  const [bulkText, setBulkText]   = useState("");

  // ── queries ───────────────────────────────────────────────────────────────
  const { data: proxyList, isLoading } = useQuery({
    queryKey: ["/api/proxies"],
    refetchInterval: 30000,
  });

  const { data: proxyStats } = useQuery({
    queryKey: ["/api/proxies/stats"],
    refetchInterval: 30000,
  });

  const { data: proxyConfigData } = useQuery({
    queryKey: ["/api/proxy-config"],
  });

  // ── mutations ─────────────────────────────────────────────────────────────
  const toggleMutation = useMutation({
    mutationFn: async (enabled: boolean) => {
      const res = await apiRequest("POST", "/api/proxy-config", { enabled });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxy-config"] });
      toast({
        title: data.enabled ? "PROXIES ENABLED" : "PROXIES DISABLED",
        description: data.enabled
          ? "Checker will route through proxy pool."
          : "Checker will go direct — no proxy used.",
      });
    },
  });

  const addProxyMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies", {
        ip: newIp.trim(),
        port: parseInt(newPort, 10),
        protocol: newProtocol,
        username: newUser.trim() || undefined,
        password: newPass.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: () => {
      setNewIp(""); setNewPort(""); setNewUser(""); setNewPass("");
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      const authNote = newUser.trim() ? " (with auth)" : "";
      toast({ title: "PROXY ADDED", description: `${newIp}:${newPort}${authNote} added to pool.` });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const bulkImportMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies/bulk", { text: bulkText });
      return res.json();
    },
    onSuccess: (data: any) => {
      setBulkText("");
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      const failNote = data.failed > 0 ? ` (${data.failed} skipped)` : "";
      toast({ title: "BULK IMPORT DONE", description: `Added ${data.added} proxies${failNote}.` });
    },
    onError: (e: any) => toast({ title: "Import Error", description: e.message, variant: "destructive" }),
  });

  const scrubMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies/scrub");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      toast({
        title: "SCRUB COMPLETE",
        description: `${data.sources} sources → ${data.fetched} found, ${data.tested} tested, ${data.live} live added.`,
      });
    },
    onError: (e: any) => toast({ title: "Scrub Failed", description: e.message, variant: "destructive" }),
  });

  const washMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies/wash");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      if (data.found === 0) {
        toast({ title: "EMPTY POOL", description: "No proxies to wash. Scrub first." });
      } else {
        toast({
          title: "WASH COMPLETE",
          description: `Tested ${data.found} proxies — ${data.live} live, ${data.dead} dead.`,
        });
      }
    },
    onError: (e: any) => toast({ title: "Wash Failed", description: e.message, variant: "destructive" }),
  });

  const clearDeadMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies/clear-dead");
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      toast({ title: "CLEARED", description: `Removed ${data.cleared} dead proxies.` });
    },
  });

  const clearAllMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/proxies/clear");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
      toast({ title: "ALL CLEARED", description: "Proxy pool wiped." });
    },
  });

  const deleteOneMutation = useMutation({
    mutationFn: async (id: string) => {
      const res = await apiRequest("DELETE", `/api/proxies/${id}`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/proxies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/proxies/stats"] });
    },
  });

  // ── derived ───────────────────────────────────────────────────────────────
  const stats = (proxyStats as any) || { total: 0, live: 0, avgLatency: 0 };
  const proxies = (proxyList as any[]) || [];
  const deadCount = proxies.filter((p: any) => p.status === "dead").length;
  const proxyEnabled: boolean = (proxyConfigData as any)?.enabled ?? true;

  const canAddSingle = newIp.trim().length > 0 && newPort.trim().length > 0;
  const canAddBulk   = bulkText.trim().length > 0;

  // Count non-empty lines in bulk textarea for preview
  const bulkLineCount = bulkText.split(/\r?\n/).filter(l => l.trim()).length;

  return (
    <div className="space-y-6">

      {/* ── Header ── */}
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text">Proxy Nodes</h2>
          <p className="text-muted-foreground font-mono mt-1">Proxy Pool Management</p>
        </div>

        <div className="flex gap-2">
          <Button
            variant="outline"
            className="rounded-none border-destructive/30 text-destructive hover:bg-destructive/10 font-mono text-xs"
            onClick={() => clearDeadMutation.mutate()}
            disabled={clearDeadMutation.isPending}
          >
            <Trash2 className="w-3 h-3 mr-2" /> CLEAR DEAD
          </Button>
          <Button
            variant="outline"
            className="rounded-none border-destructive/70 text-destructive/80 hover:bg-destructive hover:text-black font-mono text-xs"
            onClick={() => { if (confirm("Wipe the entire proxy pool?")) clearAllMutation.mutate(); }}
            disabled={clearAllMutation.isPending}
          >
            {clearAllMutation.isPending
              ? <Loader2 className="w-3 h-3 mr-2 animate-spin" />
              : <X className="w-3 h-3 mr-2" />}
            CLEAR ALL
          </Button>
          <Button
            variant="outline"
            className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04] hover:text-foreground"
            onClick={() => window.open("/api/proxies/export", "_blank")}
          >
            <Download className="w-3 h-3 mr-2" /> EXPORT LIVE
          </Button>
          <Button
            variant="outline"
            className="rounded-none border-accent/50 text-accent hover:bg-accent hover:text-black font-mono text-xs"
            onClick={() => washMutation.mutate()}
            disabled={washMutation.isPending || scrubMutation.isPending || proxies.length === 0}
            title={proxies.length === 0 ? "No proxies to wash" : "Re-test all existing proxies for connectivity"}
          >
            {washMutation.isPending ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <RefreshCw className="w-3 h-3 mr-2" />}
            {washMutation.isPending ? "WASHING..." : "WASH POOL"}
          </Button>
          <Button
            className="rounded-none bg-primary text-black font-mono text-xs"
            onClick={() => scrubMutation.mutate()}
            disabled={scrubMutation.isPending || washMutation.isPending}
            title="Fetch proxies from 25 public sources, test, and add live ones"
          >
            {scrubMutation.isPending ? <Loader2 className="w-3 h-3 mr-2 animate-spin" /> : <Network className="w-3 h-3 mr-2" />}
            {scrubMutation.isPending ? "SCRUBBING..." : "SCRUB SOURCES"}
          </Button>
        </div>
      </div>

      {/* ── Proxy On/Off + Add Proxy ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">

        {/* On/Off toggle */}
        <Card className={`glass-panel rounded-none border-2 transition-colors ${proxyEnabled ? "border-primary/60" : "border-destructive/40"}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground uppercase flex items-center gap-2">
              {proxyEnabled
                ? <ShieldCheck className="w-4 h-4 text-primary" />
                : <ShieldOff className="w-4 h-4 text-destructive" />}
              Proxy Routing
            </CardTitle>
          </CardHeader>
          <CardContent className="flex items-center justify-between pt-1">
            <div>
              <div className={`text-2xl font-display font-bold ${proxyEnabled ? "text-primary" : "text-destructive"}`}>
                {proxyEnabled ? "ENABLED" : "DISABLED"}
              </div>
              <div className="text-xs font-mono text-muted-foreground mt-1">
                {proxyEnabled
                  ? "Checker routes through proxy pool"
                  : "Checker goes direct — proxy skipped"}
              </div>
            </div>
            <Switch
              checked={proxyEnabled}
              onCheckedChange={(v) => toggleMutation.mutate(v)}
              disabled={toggleMutation.isPending}
              className="scale-125"
            />
          </CardContent>
        </Card>

        {/* Add custom proxy — single or bulk mode */}
        <Card className="glass-panel rounded-none">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-mono text-muted-foreground uppercase flex items-center gap-2">
                {bulkMode ? <List className="w-4 h-4 text-accent" /> : <Plus className="w-4 h-4 text-accent" />}
                {bulkMode ? "Mass Import" : "Add Custom Proxy"}
              </CardTitle>
              {/* Toggle single / bulk */}
              <button
                className="text-xs font-mono text-muted-foreground hover:text-accent transition-colors px-2 py-1 border border-white/[0.08] rounded-none"
                onClick={() => setBulkMode(!bulkMode)}
              >
                {bulkMode ? "← SINGLE" : "BULK →"}
              </button>
            </div>
          </CardHeader>
          <CardContent className="pt-1">
            {!bulkMode ? (
              /* ─── Single proxy add form ─── */
              <div className="space-y-2">
                {/* Row 1: protocol + IP + port + add button */}
                <div className="flex gap-2 items-end">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs font-mono text-muted-foreground">PROTOCOL</Label>
                    <Select value={newProtocol} onValueChange={setNewProtocol}>
                      <SelectTrigger className="h-8 px-2 text-xs font-mono bg-background border-white/[0.08] text-foreground rounded-none focus:outline-none focus:border-primary">
                        {newProtocol.toUpperCase()}
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="http">HTTP</SelectItem>
                        <SelectItem value="https">HTTPS</SelectItem>
                        <SelectItem value="socks5">SOCKS5</SelectItem>
                        <SelectItem value="socks4">SOCKS4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex flex-col gap-1 flex-1">
                    <Label className="text-xs font-mono text-muted-foreground">IP ADDRESS</Label>
                    <Input
                      value={newIp}
                      onChange={(e) => setNewIp(e.target.value)}
                      placeholder="1.2.3.4"
                      className="h-8 rounded-none font-mono text-xs border-white/[0.08] focus:border-primary"
                    />
                  </div>
                  <div className="flex flex-col gap-1 w-20">
                    <Label className="text-xs font-mono text-muted-foreground">PORT</Label>
                    <Input
                      value={newPort}
                      onChange={(e) => setNewPort(e.target.value)}
                      placeholder="8080"
                      type="number"
                      className="h-8 rounded-none font-mono text-xs border-white/[0.08] focus:border-primary"
                    />
                  </div>
                  <Button
                    className="h-8 rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs"
                    onClick={() => addProxyMutation.mutate()}
                    disabled={!canAddSingle || addProxyMutation.isPending}
                  >
                    {addProxyMutation.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                  </Button>
                </div>
                {/* Row 2: optional auth */}
                <div className="flex gap-2 items-end">
                  <div className="flex flex-col gap-1 flex-1">
                    <Label className="text-xs font-mono text-muted-foreground flex items-center gap-1">
                      <Unlock className="w-3 h-3" /> USERNAME <span className="text-muted-foreground/50">(optional)</span>
                    </Label>
                    <Input
                      value={newUser}
                      onChange={(e) => setNewUser(e.target.value)}
                      placeholder="proxyuser"
                      autoComplete="off"
                      className="h-8 rounded-none font-mono text-xs border-white/[0.08] focus:border-primary"
                    />
                  </div>
                  <div className="flex flex-col gap-1 flex-1">
                    <Label className="text-xs font-mono text-muted-foreground flex items-center gap-1">
                      <Lock className="w-3 h-3" /> PASSWORD <span className="text-muted-foreground/50">(optional)</span>
                    </Label>
                    <Input
                      value={newPass}
                      onChange={(e) => setNewPass(e.target.value)}
                      placeholder="proxypass"
                      type="password"
                      autoComplete="new-password"
                      className="h-8 rounded-none font-mono text-xs border-white/[0.08] focus:border-primary"
                    />
                  </div>
                </div>
              </div>
            ) : (
              /* ─── Bulk import form ─── */
              <div className="space-y-2">
                <div className="text-xs font-mono text-muted-foreground/70 leading-relaxed">
                  One proxy per line. Supported formats:
                  <span className="text-primary ml-1">ip:port</span> ·
                  <span className="text-primary ml-1">ip:port:user:pass</span> ·
                  <span className="text-primary ml-1">proto://user:pass@ip:port</span>
                </div>
                <Textarea
                  value={bulkText}
                  onChange={(e) => setBulkText(e.target.value)}
                  placeholder={"1.2.3.4:8080\n1.2.3.4:8080:user:pass\nsocks5://user:pass@5.6.7.8:1080\nhttp://9.10.11.12:3128"}
                  className="h-32 rounded-none font-mono text-xs border-white/[0.08] focus:border-primary resize-none"
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs font-mono text-muted-foreground">
                    {bulkLineCount > 0 ? `${bulkLineCount} lines detected` : "Paste proxy list above"}
                  </span>
                  <Button
                    className="h-8 rounded-none bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black font-mono text-xs"
                    onClick={() => bulkImportMutation.mutate()}
                    disabled={!canAddBulk || bulkImportMutation.isPending}
                  >
                    {bulkImportMutation.isPending
                      ? <><Loader2 className="w-3 h-3 mr-2 animate-spin" /> IMPORTING...</>
                      : <><List className="w-3 h-3 mr-2" /> IMPORT {bulkLineCount > 0 ? bulkLineCount : ""}</>}
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Stats ── */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="glass-panel rounded-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground uppercase">Live / Total</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-display text-primary">{stats.live}<span className="text-lg text-muted-foreground">/{stats.total}</span></div>
            {stats.total > 0 && (
              <div className="mt-2 h-1.5 bg-muted rounded-full overflow-hidden">
                <div className="h-full bg-primary transition-all" style={{ width: `${Math.round((stats.live / stats.total) * 100)}%` }} />
              </div>
            )}
            <div className="text-xs font-mono text-muted-foreground mt-1">
              {stats.total > 0 ? `${Math.round((stats.live / stats.total) * 100)}% healthy` : "Empty pool"}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground uppercase">Avg Latency</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-display text-accent">{stats.avgLatency}<span className="text-lg">ms</span></div>
            <div className="text-xs font-mono text-muted-foreground mt-2">
              {stats.avgLatency < 1000 ? "Fast" : stats.avgLatency < 3000 ? "Normal" : "Slow"}
            </div>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none border-l-4 border-l-destructive/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground uppercase flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-destructive" />
              Dead
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-4xl font-display text-destructive">{deadCount}</div>
            <div className="text-xs font-mono text-muted-foreground mt-2">CLEAR DEAD to purge</div>
          </CardContent>
        </Card>

        <Card className={`glass-panel rounded-none border-l-4 ${proxyEnabled ? "border-l-primary/60" : "border-l-destructive/40"}`}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-mono text-muted-foreground uppercase">Checker Route</CardTitle>
          </CardHeader>
          <CardContent>
            <div className={`text-2xl font-display ${proxyEnabled ? "text-primary" : "text-destructive"}`}>
              {proxyEnabled ? "PROXY" : "DIRECT"}
            </div>
            <div className="text-xs font-mono text-muted-foreground mt-2">
              {proxyEnabled
                ? `${stats.live} nodes in rotation`
                : "Going direct — no proxy"}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Proxy Table ── */}
      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <Network className="w-4 h-4 text-primary" />
            Proxy Pool
          </CardTitle>
          <div className="text-xs font-mono text-primary animate-pulse">
            {proxies.length > 0 ? "MONITORING ACTIVE" : "EMPTY — SCRUB SOURCES TO AUTO-FILL"}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-sm">
              <thead className="bg-background/50 border-b border-white/[0.06] text-muted-foreground">
                <tr>
                  <th className="p-4 font-normal">IP:PORT</th>
                  <th className="p-4 font-normal">PROTOCOL</th>
                  <th className="p-4 font-normal">AUTH</th>
                  <th className="p-4 font-normal">LATENCY</th>
                  <th className="p-4 font-normal">LAST WASH</th>
                  <th className="p-4 font-normal">STATUS</th>
                  <th className="p-4 font-normal w-12"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {isLoading ? (
                  <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></td></tr>
                ) : proxies.length === 0 ? (
                  <tr><td colSpan={7} className="p-8 text-center text-muted-foreground font-mono">No proxies. Click SCRUB SOURCES to auto-fetch, or add manually above.</td></tr>
                ) : (
                  proxies.map((proxy: any) => (
                    <tr key={proxy.id} className="hover:bg-white/[0.03] transition-colors">
                      <td className="p-4 text-foreground/80">
                        {proxy.ip}:{proxy.port}
                        {proxy.country && (
                          <span className="ml-2 px-1 py-0.5 text-[9px] font-mono bg-accent/10 text-accent border border-accent/30 align-middle">{proxy.country}</span>
                        )}
                      </td>
                      <td className="p-4 text-accent">{(proxy.protocol || "http").toUpperCase()}</td>
                      <td className="p-4">
                        {proxy.username ? (
                          <span className="flex items-center gap-1 text-primary text-xs">
                            <Lock className="w-3 h-3" />
                            {proxy.username}
                          </span>
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </td>
                      <td className="p-4 text-primary">{proxy.latency != null ? `${proxy.latency}ms` : "—"}</td>
                      <td className="p-4 text-muted-foreground text-xs">
                        {proxy.lastChecked
                          ? new Date(proxy.lastChecked).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
                          : "never"}
                      </td>
                      <td className="p-4">
                        <span className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${proxy.status === "live" ? "bg-primary shadow-[0_0_4px_rgba(0,255,128,0.5)]" : "bg-destructive"}`} />
                          <span className={proxy.status === "live" ? "text-primary" : "text-destructive"}>
                            {proxy.status.toUpperCase()}
                          </span>
                        </span>
                      </td>
                      <td className="p-4">
                        <button
                          className="text-muted-foreground hover:text-destructive transition-colors"
                          onClick={() => deleteOneMutation.mutate(proxy.id)}
                          disabled={deleteOneMutation.isPending}
                          title="Remove proxy"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
