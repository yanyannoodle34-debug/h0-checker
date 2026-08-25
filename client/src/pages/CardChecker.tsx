import { useState, useRef, useEffect, useCallback, useMemo, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Terminal, Play, Square, Loader2, CreditCard, Download, Upload, Trash2, FileText, AlertTriangle } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { getCheckerState, updateCheckerState, appendLogs, appendResults, subscribe, abortCurrentRun, startNewRun, getAbortFlag, getAbortController } from "@/lib/checkerStore";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MAX_CARDS = 5000;
const MAX_LOGS  = 2000;   // cap in-memory log entries

/** Escape HTML entities to prevent XSS when embedding user data in log HTML */
const esc = (s: string) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Luhn algorithm — returns true for a valid card number */
function luhnCheck(num: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = num.length - 1; i >= 0; i--) {
    let d = parseInt(num[i], 10);
    if (double) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

function normalizeCardLine(line: string): string | null {
  let trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("//")) return null;

  trimmed = trimmed.replace(/\s{2,}/g, " ");

  const separators = ["|", ":", ";", ",", " ", "\t"];
  for (const sep of separators) {
    const parts = trimmed.split(sep).map(p => p.trim()).filter(Boolean);
    if (parts.length >= 4) {
      const [num, month, year, cvv] = parts;
      const cleanNum = num.replace(/[\s-]/g, "");
      if (/^\d{13,19}$/.test(cleanNum) && /^\d{1,2}$/.test(month) && /^\d{2,4}$/.test(year) && /^\d{3,4}$/.test(cvv)) {
        return `${cleanNum}|${month.padStart(2, "0")}|${year}|${cvv}`;
      }
    }
  }
  return null;
}

function parseAndValidateCards(raw: string): {
  valid: string[];
  invalid: number;
  luhnFailed: number;
  duplicates: number;
  total: number;
  truncated: number;
} {
  const lines = raw.split(/\r?\n/);
  const seen = new Set<string>();
  const valid: string[] = [];
  let invalid = 0;
  let luhnFailed = 0;
  let duplicates = 0;
  let total = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    total++;
    const normalized = normalizeCardLine(line);
    if (!normalized) { invalid++; continue; }
    const cardNum = normalized.split("|")[0];
    if (!luhnCheck(cardNum)) { luhnFailed++; continue; }
    if (seen.has(normalized)) { duplicates++; continue; }
    seen.add(normalized);
    valid.push(normalized);
  }

  const truncated = Math.max(0, valid.length - MAX_CARDS);
  return { valid: valid.slice(0, MAX_CARDS), invalid, luhnFailed, duplicates, total, truncated };
}

export default function CardChecker() {
  const checkerState = useSyncExternalStore(subscribe, getCheckerState);
  const { isRunning, cards, selectedGate, progress, logs, currentResults } = checkerState;

  const setCards = (val: string | ((prev: string) => string)) => {
    if (typeof val === "function") {
      updateCheckerState({ cards: val(getCheckerState().cards) });
    } else {
      updateCheckerState({ cards: val });
    }
  };
  const setSelectedGate = (val: string) => updateCheckerState({ selectedGate: val });
  const setIsRunning = (val: boolean) => updateCheckerState({ isRunning: val });
  const setProgress = (val: typeof progress | ((prev: typeof progress) => typeof progress)) => {
    if (typeof val === "function") {
      updateCheckerState({ progress: val(getCheckerState().progress) });
    } else {
      updateCheckerState({ progress: val });
    }
  };
  const setLogs = (val: string[] | ((prev: string[]) => string[])) => {
    const cap = (arr: string[]) => arr.length > MAX_LOGS ? arr.slice(-MAX_LOGS) : arr;
    if (typeof val === "function") {
      updateCheckerState({ logs: cap(val(getCheckerState().logs)) });
    } else {
      updateCheckerState({ logs: cap(val) });
    }
  };
  const setCurrentResults = (val: any[] | ((prev: any[]) => any[])) => {
    if (typeof val === "function") {
      updateCheckerState({ currentResults: val(getCheckerState().currentResults) });
    } else {
      updateCheckerState({ currentResults: val });
    }
  };

  const [isDragging, setIsDragging] = useState(false);
  const { toast } = useToast();
  const consoleRef   = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const runningRef   = useRef(false);   // immediate guard against double-start
  const queryClient  = useQueryClient();

  // Abort any in-progress run when the component unmounts (navigation away)
  useEffect(() => {
    return () => { abortCurrentRun(); };
  }, []);

  const { data: gates } = useQuery({
    queryKey: ["/api/gates"],
  });

  useEffect(() => {
    if (consoleRef.current) {
      consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
    }
  }, [logs]);

  const parsed = useMemo(() => {
    if (!cards.trim()) return { valid: [], invalid: 0, luhnFailed: 0, duplicates: 0, total: 0, truncated: 0 };
    return parseAndValidateCards(cards);
  }, [cards]);

  const cardCount = parsed.valid.length;
  const { luhnFailed } = parsed;

  const processFileContent = useCallback((content: string, fileName: string) => {
    const { valid, invalid, duplicates, total, truncated } = parseAndValidateCards(content);

    if (valid.length === 0) {
      toast({
        title: "NO VALID CARDS FOUND",
        description: `File "${fileName}" contained ${total} lines but no valid card entries. Expected format: CC|MM|YYYY|CVV`,
        variant: "destructive"
      });
      return;
    }

    setCards(prev => {
      const existing = prev.trim();
      const combined = existing ? `${existing}\n${valid.join("\n")}` : valid.join("\n");
      const finalParsed = parseAndValidateCards(combined);
      if (finalParsed.truncated > 0) {
        toast({
          title: "CARD LIMIT REACHED",
          description: `${finalParsed.truncated} cards exceeded the ${MAX_CARDS} limit and were dropped.`,
          variant: "destructive"
        });
      }
      return finalParsed.valid.join("\n");
    });

    const parts = [`Loaded ${valid.length} cards from "${fileName}"`];
    if (duplicates > 0) parts.push(`${duplicates} duplicates removed`);
    if (invalid > 0) parts.push(`${invalid} invalid lines skipped`);
    if (truncated > 0) parts.push(`${truncated} cards over limit`);

    setLogs(prev => [...prev, `> ${parts.join(" | ")}`]);

    toast({
      title: "FILE LOADED",
      description: parts.join(". "),
    });
  }, [toast]);

  const handleFileUpload = useCallback((file: File) => {
    if (!file.name.toLowerCase().endsWith(".txt")) {
      toast({
        title: "INVALID FILE TYPE",
        description: "Only .txt files are supported. Please upload a plain text file.",
        variant: "destructive"
      });
      return;
    }

    if (file.size > 5 * 1024 * 1024) {
      toast({
        title: "FILE TOO LARGE",
        description: "Maximum file size is 5MB.",
        variant: "destructive"
      });
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      const content = e.target?.result as string;
      if (!content || !content.trim()) {
        toast({
          title: "EMPTY FILE",
          description: "The uploaded file is empty.",
          variant: "destructive"
        });
        return;
      }
      processFileContent(content, file.name);
    };
    reader.onerror = () => {
      toast({
        title: "READ ERROR",
        description: "Failed to read the file. Please try again.",
        variant: "destructive"
      });
    };
    reader.readAsText(file);
  }, [processFileContent, toast]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    if (isRunning) return;

    const files = Array.from(e.dataTransfer.files);
    const txtFile = files.find(f => f.name.toLowerCase().endsWith(".txt"));
    if (txtFile) {
      handleFileUpload(txtFile);
    } else if (files.length > 0) {
      toast({
        title: "INVALID FILE TYPE",
        description: "Only .txt files are supported.",
        variant: "destructive"
      });
    }
  }, [isRunning, handleFileUpload, toast]);

  const handleStart = async () => {
    // Immediate ref guard — prevents double-start from rapid clicks before
    // React re-renders with isRunning=true
    if (runningRef.current) return;
    if (!cards.trim()) {
      toast({
        title: "INPUT REQUIRED",
        description: "Enter cards or upload a .txt file. Format: CC|MM|YYYY|CVV",
        variant: "destructive"
      });
      return;
    }

    const { valid, invalid, luhnFailed, duplicates, truncated } = parseAndValidateCards(cards);

    if (valid.length === 0) {
      toast({
        title: "NO VALID CARDS",
        description: `No valid cards found. ${luhnFailed > 0 ? `${luhnFailed} failed Luhn check. ` : ""}Check format: CC|MM|YYYY|CVV`,
        variant: "destructive"
      });
      return;
    }

    runningRef.current = true;
    setIsRunning(true);
    const currentRunId = startNewRun();
    setCurrentResults([]);
    setProgress({ current: 0, total: valid.length, lives: 0, deads: 0, errors: 0 });

    const gateName = (gates as any[])?.find((g: any) => g.id === selectedGate)?.name || "Auto-Select";
    const logParts = [`Starting mass check: ${valid.length} cards via ${gateName}`];
    if (duplicates  > 0) logParts.push(`${duplicates} dupes removed`);
    if (luhnFailed  > 0) logParts.push(`${luhnFailed} failed Luhn`);
    if (invalid     > 0) logParts.push(`${invalid} invalid skipped`);
    if (truncated   > 0) logParts.push(`${truncated} over limit`);
    setLogs(prev => [...prev, `> ${logParts.join(" | ")}`]);

    const BATCH_SIZE = 10;
    let totalLives = 0;
    let totalDeads = 0;
    let totalErrors = 0;
    let processed = 0;

    for (let i = 0; i < valid.length; i += BATCH_SIZE) {
      if (getAbortFlag()) {
        setLogs(prev => [...prev, `> ABORTED at ${processed}/${valid.length}. Lives: ${totalLives} | Deads: ${totalDeads} | Errors: ${totalErrors}`]);
        break;
      }

      const batch = valid.slice(i, i + BATCH_SIZE);
      const ctrl = getAbortController();
      try {
        const res = await apiRequest("POST", "/api/checks", { cards: batch, gate: selectedGate }, ctrl?.signal);
        const results: any[] = await res.json();
        setCurrentResults(prev => [...prev, ...results]);

        const newLogs: string[] = [];
        for (const r of results) {
          const resp = r.response || "";
          const isCvvLive = resp.includes("CVV LIVE");
          const isCcnLive = resp.includes("CCN LIVE");
          const isTokenized = resp.includes("TOKENIZED");

          const respParts = resp.split("|").map((s: string) => s.trim());
          const mainStatus = respParts[0] || resp;
          const cardInfo = respParts.find((p: string) => /VISA|MASTERCARD|AMEX|DISCOVER|JCB|debit|credit|prepaid/i.test(p)) || "";
          const extraInfo = respParts.filter((p: string) => p !== mainStatus && p !== cardInfo && !p.includes("tok_") && !p.includes("pm_") && !p.includes("PM Only")).join(" · ");

          const infoStr = [cardInfo, extraInfo].filter(Boolean).join(" · ");

          // Escape all user/server data before embedding in HTML to prevent XSS
          const eCard = esc(r.card);
          const eMain = esc(mainStatus);
          const eInfo = esc(infoStr);
          const eGate = esc(r.gate || "");
          const eLat  = esc(String(r.latency || 0));
          const eResp = esc(resp);
          const meta  = `<span class="opacity-50">${eGate} · ${eLat}ms</span>`;
          const infoHtml = eInfo ? ` | <span class="opacity-70">${eInfo}</span>` : "";

          if (r.status === "approved") {
            totalLives++;
            if (isCvvLive) {
              newLogs.push(`<span class="text-green-400 font-bold">[CVV LIVE]</span> <span class="text-green-300">${eMain}</span> | <span class="text-white">${eCard}</span>${infoHtml} | ${meta}`);
            } else if (isCcnLive) {
              newLogs.push(`<span class="text-blue-400 font-bold">[CCN LIVE]</span> <span class="text-blue-300">${eMain}</span> | <span class="text-white">${eCard}</span>${infoHtml} | ${meta}`);
            } else if (isTokenized) {
              newLogs.push(`<span class="text-yellow-500 font-bold">[TOKEN]</span> <span class="text-yellow-400">${eMain}</span> | <span class="text-white">${eCard}</span>${infoHtml} | ${meta}`);
            } else {
              newLogs.push(`<span class="text-primary font-bold">[LIVE]</span> <span class="text-primary">${eMain}</span> | <span class="text-white">${eCard}</span>${infoHtml} | ${meta}`);
            }
          } else if (r.status === "error") {
            totalErrors++;
            newLogs.push(`<span class="text-yellow-500 font-bold">[ERR]</span> <span class="text-white/80">${eCard}</span> | <span class="text-yellow-400/80">${eResp}</span>`);
          } else {
            totalDeads++;
            newLogs.push(`<span class="text-red-500 font-bold">[DEAD]</span> <span class="text-red-400/80">${eMain}</span> | <span class="text-white/70">${eCard}</span>${infoHtml} | ${meta}`);
          }
        }

        processed = Math.min(i + BATCH_SIZE, valid.length);
        setLogs(prev => [...prev, ...newLogs]);
        setProgress({ current: processed, total: valid.length, lives: totalLives, deads: totalDeads, errors: totalErrors });
      } catch (err: any) {
        if (err.name === "AbortError") {
          processed = Math.min(i + BATCH_SIZE, valid.length);
          setLogs(prev => [...prev, `> ABORTED at ${processed}/${valid.length}. Lives: ${totalLives} | Deads: ${totalDeads} | Errors: ${totalErrors}`]);
          break;
        }
        totalErrors += batch.length;
        processed = Math.min(i + BATCH_SIZE, valid.length);
        setLogs(prev => [...prev, `<span class="text-yellow-500">[ERR]</span> Batch failed: ${esc(err.message || "Network error")}`]);
        setProgress(prev => ({ ...prev, current: processed, errors: totalErrors }));
      }
    }

    if (!getAbortFlag()) {
      const hitRate = valid.length > 0 ? ((totalLives / valid.length) * 100).toFixed(1) : "0.0";
      setLogs(prev => [...prev, `> CHECK COMPLETE. Total: ${valid.length} | Lives: ${totalLives} | Deads: ${totalDeads} | Errors: ${totalErrors} | Hit Rate: ${hitRate}%`]);
    }

    runningRef.current = false;
    setIsRunning(false);
    queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
  };

  const handleStop = () => {
    abortCurrentRun();
    setLogs(prev => [...prev, "> ABORT SIGNAL SENT. Stopping..."]);
  };

  const handleClear = () => {
    setCards("");
    setCurrentResults([]);
    setProgress({ current: 0, total: 0, lives: 0, deads: 0, errors: 0 });
    setLogs(prev => [...prev, "> Input buffer cleared."]);
  };

  const handleDownload = (status?: string) => {
    const url = status ? `/api/checks/download?status=${status}` : "/api/checks/download";
    window.open(url, "_blank");
  };

  const progressPercent = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end flex-wrap gap-3">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text" data-testid="text-page-title">Terminal Interface</h2>
          <p className="text-muted-foreground font-mono mt-1">Single & Mass Card Checking Protocol</p>
        </div>
        
        <div className="flex gap-2 flex-wrap">
          <Select value={selectedGate || "auto"} onValueChange={setSelectedGate}>
            <SelectTrigger className="w-56 rounded-none border-white/10 bg-white/[0.03] font-mono text-xs" data-testid="select-gate">
              <SelectValue placeholder="Auto-Select Gate" />
            </SelectTrigger>
            <SelectContent className="max-h-[300px] overflow-y-auto">
              <SelectItem value="auto">⚡ Auto-Select Gate ({(gates as any[])?.length || 0})</SelectItem>
              {(gates as any[])?.filter((g: any) => g.active).map((g: any) => (
                <SelectItem key={g.id} value={g.id}>🟢 {g.name}</SelectItem>
              ))}
              {(gates as any[])?.filter((g: any) => !g.active).map((g: any) => (
                <SelectItem key={g.id} value={g.id}>🔴 {g.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button 
            variant="outline" 
            className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04]"
            onClick={() => handleDownload("approved")}
            data-testid="button-download-lives"
          >
            <Download className="w-3 h-3 mr-1.5" /> LIVES
          </Button>
          <Button 
            variant="outline" 
            className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04]"
            onClick={() => handleDownload()}
            data-testid="button-download-all"
          >
            <Download className="w-3 h-3 mr-1.5" /> ALL
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="glass-panel rounded-none flex flex-col h-[540px]">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-primary" />
              Input Buffer
            </CardTitle>
          </CardHeader>
          <CardContent className="p-4 flex-1 flex flex-col">
            <div className="flex justify-between items-center mb-2 font-mono text-xs text-muted-foreground">
              <span>Format: CC|MM|YYYY|CVV</span>
              <div className="flex items-center gap-3">
                {parsed.luhnFailed > 0 && (
                  <span className="text-red-400 flex items-center gap-1" title="Failed Luhn checksum — invalid card numbers">
                    <AlertTriangle className="w-3 h-3" />
                    {parsed.luhnFailed} bad checksum
                  </span>
                )}
                {parsed.invalid > 0 && (
                  <span className="text-yellow-500 flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {parsed.invalid} invalid
                  </span>
                )}
                {parsed.duplicates > 0 && (
                  <span className="text-muted-foreground">{parsed.duplicates} dupes</span>
                )}
                {parsed.truncated > 0 && (
                  <span className="text-destructive flex items-center gap-1">
                    <AlertTriangle className="w-3 h-3" />
                    {parsed.truncated} over limit
                  </span>
                )}
                <span className={cardCount >= MAX_CARDS ? "text-destructive" : ""}>
                  Valid: {cardCount}/{MAX_CARDS}
                </span>
              </div>
            </div>

            <div
              className={`flex-1 relative rounded-none border transition-colors ${
                isDragging
                  ? "border-primary border-dashed bg-primary/5"
                  : "border-white/[0.06]"
              }`}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {isDragging && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-background/90 pointer-events-none">
                  <FileText className="w-10 h-10 text-primary mb-2" />
                  <span className="font-mono text-sm text-primary">Drop .txt file here</span>
                </div>
              )}
              <Textarea 
                className="w-full h-full resize-none bg-background/50 border-0 rounded-none font-mono text-sm focus-visible:ring-primary text-primary"
                placeholder={`Paste cards or drag & drop a .txt file\n\n453211...|12|2025|123\n553211...|01|2026|456\n\nSupported separators: | : ; , space`}
                value={cards}
                onChange={(e) => setCards(e.target.value)}
                disabled={isRunning}
                data-testid="input-cards"
              />
            </div>
            
            <div className="grid grid-cols-4 gap-2 mt-3">
              <Button
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={isRunning}
                className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-white/[0.04]"
                data-testid="button-upload-file"
              >
                <Upload className="w-3 h-3 mr-1" /> .TXT
              </Button>
              <Button
                variant="outline"
                onClick={handleClear}
                disabled={isRunning || !cards.trim()}
                className="rounded-none border-white/10 text-muted-foreground font-mono text-[10px] hover:bg-destructive/10 hover:text-destructive"
                data-testid="button-clear"
              >
                <Trash2 className="w-3 h-3 mr-1" /> CLR
              </Button>
              <Button 
                onClick={handleStart}
                disabled={isRunning || cardCount === 0}
                className="rounded-none bg-primary text-black hover:bg-primary/90 font-mono text-[11px] font-bold"
                data-testid="button-execute"
              >
                {isRunning ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Play className="w-3 h-3 mr-1" />}
                EXEC
              </Button>
              <Button 
                onClick={handleStop}
                disabled={!isRunning}
                variant="outline" 
                className="rounded-none border-destructive/30 text-destructive font-mono text-[10px] hover:bg-destructive/10"
                data-testid="button-abort"
              >
                <Square className="w-3 h-3 mr-1" /> STOP
              </Button>
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".txt"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileUpload(file);
                e.target.value = "";
              }}
              data-testid="input-file-upload"
            />
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none flex flex-col h-[540px]">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Terminal className="w-4 h-4 text-primary" />
              Console Output
            </CardTitle>
            <div className="flex items-center gap-3 text-xs font-mono">
              {isRunning && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-3 h-3 animate-spin text-primary" />
                  <span>{progress.current}/{progress.total}</span>
                  <span className="text-primary">{progressPercent}%</span>
                </div>
              )}
              {!isRunning && progress.total > 0 && (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <span className="text-primary">L:{progress.lives}</span>
                  <span className="text-destructive">D:{progress.deads}</span>
                  {progress.errors > 0 && <span className="text-yellow-500">E:{progress.errors}</span>}
                </div>
              )}
              <span className={isRunning ? "text-primary" : "text-muted-foreground"}>
                {isRunning ? "PROCESSING..." : "AWAITING INPUT"}
              </span>
            </div>
          </CardHeader>

          {isRunning && progress.total > 0 && (
            <div className="h-1 bg-background/50">
              <div
                className="h-full bg-primary transition-all duration-300"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          )}

          <CardContent className="p-0 flex-1 bg-[#0a0a0a] overflow-hidden relative">
            <div 
              ref={consoleRef}
              className="absolute inset-0 p-4 font-mono text-sm overflow-y-auto space-y-2 pb-8 custom-scrollbar"
              data-testid="console-output"
            >
              {logs.map((log, i) => (
                <div 
                  key={i} 
                  className={log.startsWith('>') ? 'text-primary mt-4' : 'text-muted-foreground'}
                  dangerouslySetInnerHTML={{ __html: log }}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
