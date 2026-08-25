import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Users as UsersIcon, Search, ShieldAlert, Download, Ban, Loader2, CheckCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

export default function Users() {
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: users, isLoading } = useQuery({
    queryKey: ["/api/bot-users"],
    refetchInterval: 15000,
  });

  const banMutation = useMutation({
    mutationFn: async ({ id, banned }: { id: string; banned: boolean }) => {
      const res = await apiRequest("PATCH", `/api/bot-users/${id}`, { banned });
      return res.json();
    },
    onSuccess: (_, { banned }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-users"] });
      toast({
        title: banned ? "USER BANNED" : "USER UNBANNED",
        description: banned ? "User has been banned." : "User has been unbanned.",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/bot-users/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/bot-users"] });
      toast({ title: "DELETED", description: "User removed from database." });
    },
  });

  const userList = (users as any[]) || [];
  const filtered = search 
    ? userList.filter((u: any) => 
        u.telegramId.includes(search) || 
        (u.username && u.username.toLowerCase().includes(search.toLowerCase()))
      )
    : userList;

  const handleDownload = (telegramId: string) => {
    window.open(`/api/checks/download-user/${telegramId}`, "_blank");
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-end">
        <div>
          <h2 className="text-3xl font-display font-bold text-foreground glitch-text">User Database</h2>
          <p className="text-muted-foreground font-mono mt-1">Manage Admins & Redeemed Users</p>
        </div>
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input 
            placeholder="Search ID or Username..." 
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 w-64 bg-background/50 border-white/[0.08] rounded-none font-mono focus-visible:ring-primary h-9"
            data-testid="input-search-users"
          />
        </div>
      </div>

      <Card className="glass-panel rounded-none">
        <CardHeader className="border-b border-white/[0.06]">
          <CardTitle className="font-display tracking-widest text-sm flex items-center gap-2">
            <UsersIcon className="w-4 h-4 text-primary" />
            Registered Database
            <span className="text-xs font-mono text-muted-foreground ml-2">({filtered.length} users)</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-left font-mono text-sm">
              <thead className="bg-background/50 border-b border-primary/20 text-muted-foreground">
                <tr>
                  <th className="p-4 font-normal">USER_ID</th>
                  <th className="p-4 font-normal">USERNAME</th>
                  <th className="p-4 font-normal">ROLE</th>
                  <th className="p-4 font-normal">USAGE (TODAY)</th>
                  <th className="p-4 font-normal">HITS</th>
                  <th className="p-4 font-normal text-right">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-primary/10">
                {isLoading ? (
                  <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="w-6 h-6 animate-spin mx-auto text-primary" /></td></tr>
                ) : filtered.length === 0 ? (
                  <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">No users registered yet. Users join via the Telegram bot.</td></tr>
                ) : (
                  filtered.map((user: any) => (
                    <tr key={user.id} className="hover:bg-white/[0.03] transition-colors" data-testid={`row-user-${user.id}`}>
                      <td className="p-4 text-foreground/80">{user.telegramId}</td>
                      <td className="p-4 text-primary font-bold">{user.username || "N/A"}</td>
                      <td className="p-4">
                        <span className={`px-2 py-1 text-xs border flex items-center gap-1 w-max ${
                          user.role === "owner" 
                            ? "bg-destructive/10 text-destructive border-destructive/30" 
                            : "bg-primary/10 text-primary border-primary/30"
                        }`}>
                          {user.role === "owner" && <ShieldAlert className="w-3 h-3" />}
                          {user.role.toUpperCase()}
                        </span>
                      </td>
                      <td className="p-4 text-foreground/80">
                        {user.usageToday} / {user.dailyLimit === -1 ? "∞" : user.dailyLimit}
                      </td>
                      <td className="p-4 text-accent">{user.totalHits}</td>
                      <td className="p-4 flex justify-end gap-2">
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-8 w-8 text-muted-foreground hover:text-primary rounded-none" 
                          title="Download Data"
                          onClick={() => handleDownload(user.telegramId)}
                          data-testid={`button-download-user-${user.id}`}
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className={`h-8 w-8 rounded-none ${user.banned ? "text-primary hover:text-primary" : "text-muted-foreground hover:text-destructive"}`}
                          title={user.banned ? "Unban User" : "Ban User"}
                          onClick={() => banMutation.mutate({ id: user.id, banned: !user.banned })}
                          data-testid={`button-ban-user-${user.id}`}
                        >
                          {user.banned ? <CheckCircle className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
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
  );
}
