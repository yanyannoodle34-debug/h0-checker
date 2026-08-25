import { useState, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Globe, Link2, Upload, Loader2, Search, Copy, Bot, CheckCircle, XCircle,
  Sparkles, ExternalLink, Send, FileText, ArrowRight, ShieldCheck,
} from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

function URLProcessorTab() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [input, setInput] = useState("");
  const [results, setResults] = useState<any>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const processMut = useMutation({
    mutationFn: (text: string) => apiRequest("POST", "/api/url-process", { text }).then(r => r.json()),
    onSuccess: (data) => {
      setResults(data);
      const total = data.directCards?.length || 0;
      const urlCards = data.urls?.reduce((s: number, u: any) => s + (u.cards?.length || 0), 0) || 0;
      toast({ title: "Processed", description: `${data.urls?.length || 0} URLs, ${total + urlCards} cards found` });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => setInput(ev.target?.result as string);
    reader.readAsText(file);
    e.target.value = "";
  };

  const totalCards = results?.directCards?.length || 0;
  const totalURLCards = results?.urls?.reduce((s: number, u: any) => s + (u.cards?.length || 0), 0) || 0;

  return (
    <div className="space-y-4">
      <Card className="glass-panel rounded-none border-2 border-white/[0.08]">
        <CardHeader className="border-b border-white/[0.06] py-3">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <Link2 className="w-4 h-4 text-primary" /> URL File Processor
          </CardTitle>
        </CardHeader>
        <CardContent className="p-4 space-y-3">
          <Textarea
            className="h-32 resize-none bg-background/50 rounded-none border-white/[0.08] font-mono text-sm focus-visible:ring-primary text-primary placeholder:text-muted-foreground/25"
            placeholder={"Paste Telegram URLs or CC data:\nhttps://pastebin.com/raw/abc123\nhttps://gist.githubusercontent.com/user/abc/raw\n\nOr paste CC data directly:\n4532110100000000|12|26|123"}
            value={input}
            onChange={e => setInput(e.target.value)}
          />
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" accept=".txt,.csv,.log,.tsv" className="hidden" onChange={handleFile} />
            <Button variant="outline" size="sm"               className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px]"
              onClick={() => fileRef.current?.click()}>
              <Upload className="w-3 h-3 mr-1" /> FILE
            </Button>
            <div className="flex-1" />
            <Button onClick={() => processMut.mutate(input)} disabled={!input.trim() || processMut.isPending}
              className="rounded-none font-display font-bold tracking-widest bg-primary text-black">
              {processMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Search className="w-4 h-4 mr-2" />}
              PROCESS
            </Button>
          </div>
        </CardContent>
      </Card>

      {!results && (
        <div className="text-center py-8 text-muted-foreground/30">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-mono text-xs">Paste URLs or CC data above to extract</p>
          <p className="font-mono text-[10px] mt-1 opacity-50">Supports: Telegram links, Pastebin, GitHub, raw text</p>
        </div>
      )}
      {results && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 sm:gap-2">
            {[
              { label: "URLs", value: results.urls?.length || 0, color: "text-primary" },
              { label: "URL CARDS", value: totalURLCards, color: "text-green-400" },
              { label: "DIRECT", value: totalCards, color: "text-accent" },
              { label: "BINS", value: results.directBins?.length || 0, color: "text-yellow-400" },
            ].map(s => (
              <div key={s.label} className="border border-white/8 bg-white/2 p-2 sm:p-3 text-center font-mono">
                <div className={`text-lg sm:text-xl font-bold ${s.color}`}>{s.value}</div>
                <div className="text-[8px] sm:text-[9px] text-muted-foreground/40 tracking-widest mt-1">{s.label}</div>
              </div>
            ))}
          </div>

          {results.urls?.length > 0 && (
            <Card className="glass-panel rounded-none">
              <CardHeader className="border-b border-white/[0.06] py-3">
                <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
                  <Globe className="w-4 h-4 text-primary" /> URL Results ({results.urls.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <div className="max-h-96 overflow-y-auto custom-scrollbar divide-y divide-white/4">
                  {results.urls.map((u: any, i: number) => (
                    <div key={i} className="px-4 py-3 hover:bg-white/3 transition-colors">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {u.status === "ok" ? <CheckCircle className="w-3 h-3 text-green-400 shrink-0" /> : <XCircle className="w-3 h-3 text-red-400 shrink-0" />}
                            <span className="font-mono text-xs text-primary truncate">{u.filename || u.url}</span>
                          </div>
                          <div className="text-[10px] text-muted-foreground/40 mt-0.5 truncate">{u.url}</div>
                        </div>
                        <div className="flex items-center gap-3 shrink-0">
                          <span className="font-mono text-xs text-green-400">{u.cards?.length || 0} cards</span>
                          <span className="font-mono text-[10px] text-muted-foreground/30">{(u.rawLength / 1024).toFixed(1)}KB</span>
                        </div>
                      </div>
                      {u.error && <div className="text-[10px] text-red-400 mt-1 font-mono">{u.error}</div>}
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {results.directCards?.length > 0 && (
            <Card className="glass-panel rounded-none border-white/[0.08]">
              <CardHeader className="border-b border-white/[0.06] py-3">
                <CardTitle className="font-display tracking-widest text-sm flex items-center justify-between gap-2 flex-wrap">
                  <div className="flex items-center gap-2 text-primary">
                    <span className="w-2 h-2 rounded-full bg-primary animate-pulse" />
                    EXTRACTED ({results.directCards.length})
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button variant="ghost" size="sm" className="text-primary hover:bg-primary/10 font-mono text-[10px] h-7 px-2 rounded-none"
                      onClick={() => {
                        const text = results.directCards.map((c: any) => `${c.number || c}|${c.expiryMonth || ""}|${c.expiryYear || ""}|${c.cvv || ""}`).join("\n");
                        navigator.clipboard.writeText(text);
                        toast({ title: "Copied", description: `${results.directCards.length} cards copied` });
                      }}>
                      <Copy className="w-3 h-3 mr-1" /> COPY
                    </Button>
                    {results.directBins?.length > 0 && (
                      <Button variant="ghost" size="sm" className="text-accent hover:bg-accent/10 font-mono text-[10px] h-7 px-2 rounded-none"
                        onClick={() => {
                          setLocation("/miner");
                          toast({ title: "Redirecting", description: `Sending ${results.directBins.length} BINs to Miner` });
                        }}>
                        <Send className="w-3 h-3 mr-1" /> MINE
                      </Button>
                    )}
                  </div>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="max-h-60 overflow-y-auto custom-scrollbar grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1">
                  {results.directCards.slice(0, 50).map((c: any, i: number) => (
                    <div key={i} className="font-mono text-[10px] text-green-400 bg-green-400/5 border border-green-400/20 px-2 py-1.5 truncate">
                      {c.number || c}
                    </div>
                  ))}
                  {results.directCards.length > 50 && (
                    <div className="font-mono text-[10px] text-muted-foreground/40 px-2 py-1.5">
                      +{results.directCards.length - 50} more...
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          )}

          {results.directBins?.length > 0 && (
            <Card className="glass-panel rounded-none border-accent/30">
              <CardHeader className="border-b border-accent/20 bg-accent/5 py-3">
                <CardTitle className="font-display tracking-widest text-sm flex items-center justify-between">
                  <div className="flex items-center gap-2 text-accent">
                    <ShieldCheck className="w-4 h-4" />
                    EXTRACTED BINS ({results.directBins.length})
                  </div>
                  <Button variant="ghost" size="sm" className="text-accent hover:bg-accent/10 font-mono text-[10px] h-7 px-2 rounded-none"
                    onClick={() => {
                      navigator.clipboard.writeText(results.directBins.join("\n"));
                      toast({ title: "Copied", description: `${results.directBins.length} BINs copied` });
                    }}>
                    <Copy className="w-3 h-3 mr-1" /> COPY
                  </Button>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-3">
                <div className="flex flex-wrap gap-1.5">
                  {results.directBins.map((bin: string, i: number) => (
                    <span key={i} className="font-mono text-[11px] text-accent bg-accent/10 border border-accent/30 px-2 py-0.5">
                      {bin}
                    </span>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

function AICollectorTab() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [keyword, setKeyword] = useState("");
  const [batchMode, setBatchMode] = useState(false);
  const [batchText, setBatchText] = useState("");
  const [provider, setProvider] = useState("deepseek");
  const [results, setResults] = useState<any>(null);

  const { data: providers } = useQuery<any>({ queryKey: ["/api/ai/providers"] });

  const collectMut = useMutation({
    mutationFn: (kw: string) => apiRequest("POST", "/api/ai/collect", { keyword: kw, provider }).then(r => r.json()),
    onSuccess: (data) => {
      setResults(data);
      toast({ title: "Collected", description: `Found ${data.sites?.length || 0} sites` });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const batchMut = useMutation({
    mutationFn: (keywords: string[]) => apiRequest("POST", "/api/ai/collect/batch", { keywords, provider }).then(r => r.json()),
    onSuccess: (data) => {
      setResults(data);
      toast({ title: "Batch Done", description: `${data.totalSites} sites found` });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const configureMut = useMutation({
    mutationFn: (sites: any[]) => apiRequest("POST", "/api/ai/configure-gates", { sites }).then(r => r.json()),
    onSuccess: (data) => {
      toast({
        title: "Gates Configured",
        description: `${data.createdCount} gate(s) added${data.skipped?.length ? `, ${data.skipped.length} skipped` : ""}`,
      });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const collectConfigureMut = useMutation({
    mutationFn: (kws: string[]) => apiRequest("POST", "/api/ai/collect-and-configure", { keywords: kws, provider }).then(r => r.json()),
    onSuccess: (data) => {
      const c = data.configured;
      toast({
        title: "Collected & Configured",
        description: `${data.sites?.length || 0} site(s) collected, ${c?.createdCount || 0} gate(s) configured`,
      });
    },
    onError: (e: any) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const handleCollect = () => {
    if (batchMode) {
      const kws = batchText.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
      if (kws.length > 0) batchMut.mutate(kws);
    } else {
      if (keyword.trim()) collectMut.mutate(keyword.trim());
    }
  };

  const allSites = results?.sites || results?.results?.flatMap((r: any) => r.sites) || [];

  return (
    <div className="space-y-4">
      <Card className="glass-panel rounded-none border-2 border-accent/30">
        <CardHeader className="border-b border-accent/20 bg-accent/5 py-3">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <Bot className="w-5 h-5 text-accent" /> AI Website Collector
            <span className="ml-auto text-xs font-mono font-normal">
              {providers?.active
                ? <span className="text-green-400 flex items-center gap-1"><Sparkles className="w-3 h-3" /> {providers.active}</span>
                : <span className="text-red-400">No AI key</span>}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex items-center gap-2 sm:gap-3">
            <Label className="font-mono text-[10px] text-muted-foreground uppercase tracking-wider hidden sm:block">Provider</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="rounded-none border-accent/30 bg-background font-mono text-sm h-8 w-32 sm:w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="nvidia">NVIDIA</SelectItem>
                <SelectItem value="deepseek">DeepSeek</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex-1" />
            <button onClick={() => setBatchMode(!batchMode)}
              className="text-[10px] font-mono text-accent/60 hover:text-accent tracking-wider touch-manipulation">
              {batchMode ? "SINGLE" : "BATCH"}
            </button>
          </div>

          {!batchMode ? (
            <div className="flex gap-2">
              <Input placeholder="stripe checkout, woocommerce donate..."
                value={keyword} onChange={e => setKeyword(e.target.value)}
                onKeyDown={e => e.key === "Enter" && handleCollect()}
                className="rounded-none border-accent/30 bg-background font-mono text-sm h-9 flex-1" />
              <Button onClick={handleCollect} disabled={!keyword.trim() || collectMut.isPending}
                className="rounded-none font-display font-bold tracking-widest bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black h-9 px-3 sm:px-4">
                {collectMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
              </Button>
              <Button onClick={() => keyword.trim() && collectConfigureMut.mutate([keyword.trim()])}
                disabled={!keyword.trim() || collectConfigureMut.isPending}
                title="Collect AND configure gates in one step"
                className="rounded-none font-display font-bold tracking-widest bg-accent text-black border border-accent hover:bg-accent/80 h-9 px-3 sm:px-4">
                {collectConfigureMut.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                <span className="hidden sm:inline">CONFIGURE</span>
              </Button>
            </div>
          ) : (
            <div className="space-y-2">
              <Textarea className="h-20 sm:h-24 resize-none bg-background/50 rounded-none border-accent/30 font-mono text-sm focus-visible:ring-accent text-accent placeholder:text-muted-foreground/25"
                placeholder={"stripe checkout\nwoocommerce donate\npaypal commerce"} value={batchText} onChange={e => setBatchText(e.target.value)} />
              <div className="grid grid-cols-2 gap-2">
                <Button onClick={handleCollect} disabled={!batchText.trim() || batchMut.isPending}
                  className="rounded-none font-display font-bold tracking-widest bg-accent/20 text-accent border border-accent hover:bg-accent hover:text-black h-9 px-4">
                  {batchMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Bot className="w-4 h-4 mr-2" />}
                  BATCH COLLECT
                </Button>
                <Button onClick={() => {
                  const kws = batchText.split(/[\n,]+/).map(k => k.trim()).filter(Boolean);
                  if (kws.length > 0) collectConfigureMut.mutate(kws);
                }} disabled={!batchText.trim() || collectConfigureMut.isPending}
                  className="rounded-none font-display font-bold tracking-widest bg-accent text-black border border-accent hover:bg-accent/80 h-9 px-4">
                  {collectConfigureMut.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <Sparkles className="w-4 h-4 mr-2" />}
                  COLLECT+CONFIG
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {allSites.length > 0 && (
        <Card className="glass-panel rounded-none border-accent/30">
          <CardHeader className="border-b border-accent/20 bg-accent/5 py-3">
            <CardTitle className="font-display tracking-widest text-sm flex items-center justify-between gap-2 flex-wrap">
              <span className="flex items-center gap-2 text-accent">
                <Globe className="w-4 h-4" /> DISCOVERED ({allSites.length})
              </span>
              <div className="flex items-center gap-1.5">
                <Button variant="ghost" size="sm" className="text-accent hover:bg-accent/10 font-mono text-[10px] h-7 px-2 rounded-none"
                  onClick={() => {
                    const csv = allSites.map((s: any) => `${s.url},${s.name},${s.gateType},${s.country || ""},${s.confidence}`).join("\n");
                    const blob = new Blob(["url,name,gateType,country,confidence\n" + csv], { type: "text/csv" });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement("a"); a.href = url; a.download = "collected_sites.csv"; a.click();
                  }}>
                  <Copy className="w-3 h-3 mr-1" /> CSV
                </Button>
                <Button variant="ghost" size="sm" className="text-green-400 hover:bg-green-400/10 font-mono text-[10px] h-7 px-2 rounded-none"
                  onClick={() => {
                    setLocation("/configs");
                    toast({ title: "Redirecting", description: `Go to Configs to add ${allSites.length} sites as gates` });
                  }}>
                  <ArrowRight className="w-3 h-3 mr-1" /> ADD GATES
                </Button>
                <Button variant="ghost" size="sm" disabled={configureMut.isPending}
                  className="text-accent hover:bg-accent/10 font-mono text-[10px] h-7 px-2 rounded-none"
                  onClick={() => configureMut.mutate(allSites)}>
                  {configureMut.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Sparkles className="w-3 h-3 mr-1" />}
                  ADD & POLISH
                </Button>
              </div>
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="max-h-[400px] sm:max-h-[500px] overflow-y-auto custom-scrollbar divide-y divide-white/4">
              {allSites.map((s: any, i: number) => (
                <div key={i} className="px-3 sm:px-4 py-2.5 sm:py-3 hover:bg-white/3 transition-colors flex items-start gap-2 sm:gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                      <span className="font-mono text-[11px] sm:text-xs text-accent font-bold">{s.name}</span>
                      <span className="font-mono text-[8px] sm:text-[9px] px-1 sm:px-1.5 py-0.5 border border-white/10 text-muted-foreground">{s.gateType}</span>
                      {s.country && <span className="text-[9px] sm:text-[10px] text-muted-foreground/40">{s.country}</span>}
                    </div>
                    <div className="text-[9px] sm:text-[10px] text-primary/60 mt-0.5 flex items-center gap-1">
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                      <span className="truncate">{s.url}</span>
                    </div>
                    {s.analysis && <div className="text-[8px] sm:text-[9px] text-muted-foreground/30 mt-0.5 truncate">{s.analysis}</div>}
                  </div>
                  <div className="shrink-0 text-right">
                    <div className={`font-mono text-[11px] sm:text-xs font-bold ${s.confidence >= 0.7 ? "text-green-400" : s.confidence >= 0.4 ? "text-yellow-400" : "text-muted-foreground"}`}>
                      {Math.round(s.confidence * 100)}%
                    </div>
                    <div className="text-[7px] sm:text-[8px] text-muted-foreground/30">CONF</div>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {allSites.length === 0 && !collectMut.isPending && !batchMut.isPending && (
        <div className="text-center py-8 text-muted-foreground/30">
          <Bot className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="font-mono text-xs">Enter a keyword to discover payment gateways</p>
          <p className="font-mono text-[10px] mt-1 opacity-50">Example: "stripe donate", "woocommerce checkout"</p>
        </div>
      )}
    </div>
  );
}

export default function URLProcessor() {
  const [tab, setTab] = useState("urls");

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl sm:text-3xl font-display font-bold text-foreground glitch-text">URL Extractor</h2>
        <p className="text-muted-foreground font-mono mt-1 text-xs sm:text-sm">
          Process URL files, extract CC data, AI website discovery
        </p>
      </div>

      <div className="flex gap-1 border-b border-white/10 pb-px">
        {[
          { id: "urls", label: "URLs", icon: Link2 },
          { id: "ai", label: "AI Collect", icon: Bot },
        ].map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`flex items-center gap-1.5 px-3 sm:px-4 py-2.5 font-mono text-xs tracking-wider transition-colors touch-manipulation ${
              tab === t.id ? "text-primary border-b-2 border-primary -mb-px" : "text-muted-foreground/50 hover:text-muted-foreground"
            }`}>
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>

      {tab === "urls" ? <URLProcessorTab /> : <AICollectorTab />}
    </div>
  );
}
