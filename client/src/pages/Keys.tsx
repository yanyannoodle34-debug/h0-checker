import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { KeyRound, Plus, Copy, Trash2, Clock, Loader2, Link, Settings } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useLocation } from "wouter";

export default function Keys() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  // Load defaults from bot settings
  const { data: botSettings } = useQuery<any>({ queryKey: ["/api/bot-settings"] });

  const [durationDays, setDurationDays] = useState(30);
  const [dailyLimit, setDailyLimit]     = useState(1000);

  // Sync defaults from settings when they load
  useEffect(() => {
    if (!botSettings) return;
    if (botSettings.defaultKeyDurationDays) setDurationDays(botSettings.defaultKeyDurationDays);
    if (botSettings.defaultDailyLimit)      setDailyLimit(botSettings.defaultDailyLimit);
  }, [botSettings]);

  const { data: keys, isLoading } = useQuery({
    queryKey: ["/api/keys"],
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/keys", { durationDays, dailyLimit });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({ title: "KEY GENERATED", description: `Key: ${data.key}` });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/keys/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/keys"] });
      toast({ title: "DELETED", description: "Key revoked." });
    },
  });

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    toast({ title: "COPIED TO CLIPBOARD", description: "Key copied successfully." });
  };

  const keyList = (keys as any[]) || [];

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text">Access Keys</h2>
          <p className="text-muted-foreground font-mono mt-1">Generate & Revoke User Redeem Keys</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="glass-panel rounded-none lg:col-span-1">
          <CardHeader className="border-b border-white/[0.06]">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <Plus className="w-4 h-4 text-primary" />
              Generate Key
            </CardTitle>
          </CardHeader>
          <CardContent className="p-6 space-y-4">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase">Duration (Days)</label>
              <Input 
                type="number" 
                value={durationDays}
                onChange={(e) => setDurationDays(parseInt(e.target.value) || 30)}
                className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary"
                data-testid="input-duration"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground uppercase">Daily Card Limit</label>
              <Input 
                type="number" 
                value={dailyLimit}
                onChange={(e) => setDailyLimit(parseInt(e.target.value) || 1000)}
                className="bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary"
                data-testid="input-daily-limit"
              />
            </div>
            <Button
              onClick={() => generateMutation.mutate()}
              disabled={generateMutation.isPending}
              className="w-full rounded-none font-display font-bold tracking-widest bg-primary text-black hover:bg-primary hover:text-black mt-4"
              data-testid="button-generate-key"
            >
              {generateMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              GENERATE
            </Button>
            <button
              onClick={() => setLocation("/bot-settings")}
              className="w-full text-[10px] font-mono text-muted-foreground hover:text-primary flex items-center justify-center gap-1 pt-1 transition-colors"
            >
              <Settings className="w-3 h-3" />
              Change defaults in Bot Settings
            </button>
          </CardContent>
        </Card>

        <Card className="glass-panel rounded-none lg:col-span-2">
          <CardHeader className="border-b border-white/[0.06] flex flex-row items-center justify-between">
            <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-primary" />
              Active Keys
            </CardTitle>
            <span className="text-xs font-mono text-muted-foreground">{keyList.length} keys</span>
          </CardHeader>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-left font-mono text-sm">
                <thead className="bg-background/50 border-b border-primary/20 text-muted-foreground">
                  <tr>
                    <th className="p-4 font-normal">KEY</th>
                    <th className="p-4 font-normal">DURATION</th>
                    <th className="p-4 font-normal">LIMIT</th>
                    <th className="p-4 font-normal">STATUS</th>
                    <th className="p-4 font-normal text-right">ACTIONS</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-primary/10">
                  {isLoading ? (
                    <tr><td colSpan={5} className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></td></tr>
                  ) : keyList.length === 0 ? (
                    <tr><td colSpan={5} className="p-8 text-center text-muted-foreground">No keys generated yet.</td></tr>
                  ) : (
                    keyList.map((key: any) => (
                      <tr key={key.id} className="hover:bg-white/[0.03] transition-colors" data-testid={`row-key-${key.id}`}>
                        <td className="p-4 text-primary tracking-wider">{key.key}</td>
                        <td className="p-4 text-foreground/80 flex items-center gap-2"><Clock className="w-3 h-3 text-muted-foreground"/> {key.durationDays} Days</td>
                        <td className="p-4 text-foreground/80">{key.dailyLimit}/day</td>
                        <td className="p-4">
                          <span className={`px-2 py-1 text-xs border ${
                            key.status === "unused" 
                              ? "bg-accent/20 text-accent border-accent/30" 
                              : key.status === "redeemed"
                              ? "bg-primary/20 text-primary border-white/[0.08]"
                              : "bg-destructive/20 text-destructive border-destructive/30"
                          }`}>
                            {key.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="p-4 flex justify-end gap-2">
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-muted-foreground hover:text-primary rounded-none" 
                            onClick={() => copyToClipboard(key.key)}
                            data-testid={`button-copy-key-${key.id}`}
                          >
                            <Copy className="w-4 h-4" />
                          </Button>
                          <Button 
                            variant="ghost" 
                            size="icon" 
                            className="h-8 w-8 text-muted-foreground hover:text-destructive rounded-none"
                            onClick={() => deleteMutation.mutate(key.id)}
                            data-testid={`button-delete-key-${key.id}`}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
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
    </div>
  );
}
