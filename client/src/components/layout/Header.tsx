import { Bell, ShieldAlert, Cpu, LogOut, Activity, Database, Menu } from "lucide-react";
import { useAuth } from "@/hooks/use-auth";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${m}m`;
}

interface HeaderProps {
  onMenuToggle?: () => void;
}

export default function Header({ onMenuToggle }: HeaderProps) {
  const { logout } = useAuth();
  const [, setLocation] = useLocation();

  const { data: sysStats } = useQuery<{
    memory: { heapUsedMB: number; heapTotalMB: number; heapPercent: number };
    uptime: number;
    activeChecks: number;
    platform: string;
    arch: string;
  }>({
    queryKey: ["/api/system/stats"],
    refetchInterval: 4000,
  });

  const heapPct   = sysStats?.memory?.heapPercent ?? 0;
  const heapUsed  = sysStats?.memory?.heapUsedMB  ?? 0;
  const heapTotal = sysStats?.memory?.heapTotalMB ?? 0;
  const uptime    = sysStats?.uptime       ?? 0;
  const active    = sysStats?.activeChecks ?? 0;

  const memColor =
    heapPct >= 85 ? "text-red-400" :
    heapPct >= 65 ? "text-yellow-400" :
    "text-emerald-400";

  const handleLogout = () => {
    logout();
    setLocation("/login");
  };

  return (
    <header className="h-12 sm:h-14 border-b border-primary/20 bg-background/80 backdrop-blur-md sticky top-0 z-10 flex items-center justify-between px-3 sm:px-6">
      {/* Left — hamburger (mobile) + root badge */}
      <div className="flex items-center gap-2 sm:gap-3">
        <button
          onClick={onMenuToggle}
          className="lg:hidden text-muted-foreground hover:text-primary p-1.5 transition-colors"
          aria-label="Open menu"
        >
          <Menu className="w-5 h-5" />
        </button>

        <div className="hidden sm:flex px-2.5 py-1 bg-destructive/10 border border-destructive/30 text-destructive text-[10px] font-bold font-mono uppercase items-center gap-1.5">
          <ShieldAlert className="w-3.5 h-3.5" />
          Root Access
        </div>

        {active > 0 && (
          <div className="flex items-center gap-1.5 px-2 py-1 bg-primary/10 border border-primary/30 text-primary text-[10px] font-mono">
            <Activity className="w-3 h-3 animate-pulse" />
            <span>{active}</span>
          </div>
        )}
      </div>

      {/* Right — real system metrics */}
      <div className="flex items-center gap-3 sm:gap-5">
        <div className="hidden sm:flex items-center gap-1.5 font-mono text-xs text-muted-foreground" title={`Heap: ${heapUsed}/${heapTotal} MB`}>
          <Database className="w-3.5 h-3.5 text-accent" />
          <span className={`tabular-nums font-bold ${memColor}`}>{heapPct}%</span>
          <span className="text-muted-foreground/50 text-[10px]">MEM</span>
          <div className="w-12 h-1.5 bg-primary/10 overflow-hidden">
            <div
              className={`h-1.5 transition-all duration-1000 ${
                heapPct >= 85 ? "bg-red-400" : heapPct >= 65 ? "bg-yellow-400" : "bg-emerald-400"
              }`}
              style={{ width: `${heapPct}%` }}
            />
          </div>
        </div>

        {uptime > 0 && (
          <div className="hidden md:flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground/60">
            <Cpu className="w-3 h-3" />
            <span className="tabular-nums">{formatUptime(uptime)}</span>
          </div>
        )}

        <div className="h-5 w-px bg-primary/20 hidden sm:block" />

        <button className="relative text-muted-foreground/60 hover:text-primary p-1.5 transition-colors">
          <Bell className="w-4 h-4" />
          <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-destructive rounded-full" />
        </button>

        <div className="h-5 w-px bg-primary/20 hidden sm:block" />

        <button
          onClick={handleLogout}
          className="text-muted-foreground hover:text-destructive flex items-center gap-1.5 font-mono text-[10px] sm:text-xs uppercase tracking-wider transition-colors"
        >
          <LogOut className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Logout</span>
        </button>
      </div>
    </header>
  );
}
