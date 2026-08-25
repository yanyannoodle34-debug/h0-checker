import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Wand2, Copy, Download, Trash2, CreditCard, Info } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface CardResult {
  number: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
  type: string;
}

export default function CardGen() {
  const { toast } = useToast();
  const [bin, setBin] = useState("");
  const [count, setCount] = useState("10");
  const [month, setMonth] = useState("random");
  const [year, setYear] = useState("random");
  const [results, setResults] = useState<CardResult[]>([]);

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/generate", { bin, count: parseInt(count), month, year });
      return res.json() as Promise<CardResult[]>;
    },
    onSuccess: (data) => {
      setResults(data);
      toast({
        title: "Success",
        description: `Generated ${data.length} cards successfully.`,
      });
    },
    onError: (error: Error) => {
      toast({
        title: "Error",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const copyAll = () => {
    const text = results.map(c => `${c.number}|${c.expiryMonth}|${c.expiryYear}|${c.cvv}`).join("\n");
    navigator.clipboard.writeText(text);
    toast({ title: "Copied", description: "All cards copied to clipboard" });
  };

  const downloadAll = () => {
    const text = results.map(c => `${c.number}|${c.expiryMonth}|${c.expiryYear}|${c.cvv}`).join("\n");
    const blob = new Blob([text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `generated_cards_${bin}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const clearResults = () => setResults([]);

  const currentYear = new Date().getFullYear();
  const years = Array.from({ length: 10 }, (_, i) => (currentYear + i).toString());

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-display font-bold text-foreground glitch-text" data-testid="text-gen-title">Neural Card Generator</h2>
        <p className="text-muted-foreground font-mono mt-1">Algorithmically valid CC generation based on Luhn check</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass-panel rounded-none border-primary/20">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Wand2 className="w-4 h-4 text-primary" />
              Parameters
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="bin" className="font-mono text-xs uppercase text-muted-foreground">BIN (6-8 Digits)</Label>
              <Input
                id="bin"
                placeholder="411111"
                value={bin}
                onChange={(e) => setBin(e.target.value.replace(/\D/g, ""))}
                className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary/50"
                data-testid="input-bin"
              />
            </div>

            <div className="space-y-2">
              <Label className="font-mono text-xs uppercase text-muted-foreground">Quantity</Label>
              <Select value={count} onValueChange={setCount}>
                <SelectTrigger className="bg-background/50 border-white/[0.08] rounded-none font-mono">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="bg-background border-white/[0.08] rounded-none">
                  {["10", "25", "50", "100", "250", "500"].map((c) => (
                    <SelectItem key={c} value={c} className="font-mono">{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase text-muted-foreground">Month</Label>
                <Select value={month} onValueChange={setMonth}>
                  <SelectTrigger className="bg-background/50 border-white/[0.08] rounded-none font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background border-white/[0.08] rounded-none">
                    <SelectItem value="random" className="font-mono">Random</SelectItem>
                    {Array.from({ length: 12 }, (_, i) => (i + 1).toString().padStart(2, "0")).map((m) => (
                      <SelectItem key={m} value={m} className="font-mono">{m}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="font-mono text-xs uppercase text-muted-foreground">Year</Label>
                <Select value={year} onValueChange={setYear}>
                  <SelectTrigger className="bg-background/50 border-white/[0.08] rounded-none font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent className="bg-background border-white/[0.08] rounded-none">
                    <SelectItem value="random" className="font-mono">Random</SelectItem>
                    {years.map((y) => (
                      <SelectItem key={y} value={y} className="font-mono">{y}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Button 
              className="w-full rounded-none font-display tracking-widest uppercase mt-4 bg-primary text-black"
              disabled={!bin || generateMutation.isPending}
              onClick={() => generateMutation.mutate()}
              data-testid="button-generate"
            >
              {generateMutation.isPending ? "Generating..." : "Generate Matrix"}
            </Button>
          </CardContent>
        </Card>

        <Card className="glass-panel lg:col-span-2 rounded-none border-primary/20 flex flex-col">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between py-3">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-primary" />
              Output Terminal
            </CardTitle>
            <div className="flex gap-2">
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 hover:bg-primary/10 text-primary" 
                onClick={copyAll}
                disabled={results.length === 0}
                title="Copy All"
                data-testid="button-copy-all"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 hover:bg-primary/10 text-primary" 
                onClick={downloadAll}
                disabled={results.length === 0}
                title="Download .txt"
                data-testid="button-download"
              >
                <Download className="h-4 w-4" />
              </Button>
              <Button 
                variant="ghost" 
                size="icon" 
                className="h-8 w-8 hover:bg-destructive/10 text-destructive" 
                onClick={clearResults}
                disabled={results.length === 0}
                title="Clear"
                data-testid="button-clear"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0 flex-1 min-h-[400px] flex flex-col">
            {results.length > 0 && (
              <div className="bg-white/[0.02] border-b border-white/[0.06] p-4 flex items-center gap-4">
                <div className="flex items-center gap-2">
                  <Info className="w-4 h-4 text-accent" />
                  <span className="font-mono text-xs text-muted-foreground uppercase">Detected:</span>
                  <span className="font-mono text-xs font-bold text-accent">{results[0].type}</span>
                </div>
                <div className="flex items-center gap-2 border-l border-white/[0.06] pl-4">
                  <span className="font-mono text-xs text-muted-foreground uppercase">Count:</span>
                  <span className="font-mono text-xs font-bold text-primary">{results.length}</span>
                </div>
              </div>
            )}
            <div className="flex-1 p-4 font-mono text-sm overflow-y-auto max-h-[500px] custom-scrollbar">
              {results.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-30 gap-4">
                  <Wand2 className="w-12 h-12" />
                  <p className="uppercase tracking-[0.2em] text-xs">Awaiting algorithm input...</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {results.map((card, i) => (
                    <div key={i} className="flex items-center gap-4 hover:bg-white/[0.03] p-1 group" data-testid={`row-card-${i}`}>
                      <span className="text-muted-foreground text-[10px] w-6 opacity-50">{(i + 1).toString().padStart(3, "0")}</span>
                      <span className="text-foreground group-hover:text-primary transition-colors">{card.number}</span>
                      <span className="text-accent">|</span>
                      <span className="text-foreground">{card.expiryMonth}</span>
                      <span className="text-accent">/</span>
                      <span className="text-foreground">{card.expiryYear}</span>
                      <span className="text-accent">|</span>
                      <span className="text-foreground">{card.cvv}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
