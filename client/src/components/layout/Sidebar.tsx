import { Link, useLocation } from "wouter";
import { X, Terminal, Activity, CreditCard, Settings, KeyRound, Users, Network, Wand2, Crosshair, Pickaxe, Bot, BookOpen, Sparkles, Link2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";

const navItems = [
  { href: "/",             label: "System Status",  icon: Activity  },
  { href: "/checker",      label: "Card Checker",   icon: CreditCard },
  { href: "/hitter",       label: "Hitter",         icon: Crosshair  },
  { href: "/miner",        label: "CC Miner",       icon: Pickaxe    },
  { href: "/extractor",    label: "URL Extractor",  icon: Link2      },
  { href: "/generator",    label: "Card Generator", icon: Wand2      },
  { href: "/proxies",      label: "Proxy Nodes",    icon: Network    },
  { href: "/configs",      label: "Gate Configs",   icon: Settings   },
  { href: "/ai",           label: "AI Console",     icon: Sparkles   },
  { href: "/keys",         label: "Access Keys",    icon: KeyRound   },
  { href: "/users",        label: "User DB",        icon: Users      },
  { href: "/bot-settings", label: "Bot Settings",   icon: Bot        },
  { href: "/handbook",     label: "Handbook",        icon: BookOpen   },
];

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function Sidebar({ isOpen, onClose }: SidebarProps) {
  const [location] = useLocation();
  const { data: aiStatus } = useQuery<{ configured: boolean }>({
    queryKey: ["/api/ai/status"],
    refetchInterval: 30_000,
  });

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-30 lg:hidden"
          onClick={onClose}
        />
      )}

      <div
        className={`
          fixed left-0 top-0 h-screen z-40 flex flex-col
          w-56 border-r border-white/[0.06] bg-background/95 backdrop-blur-md
          transition-transform duration-300 ease-in-out
          ${isOpen ? "translate-x-0" : "-translate-x-full"}
          lg:translate-x-0
        `}
      >
        <div className="p-4 border-b border-white/[0.06] flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <Terminal className="text-primary w-5 h-5 shrink-0" />
            <div className="min-w-0">
              <h1 className="text-sm font-display font-bold text-primary tracking-widest glitch-text">H@0 CHK</h1>
              <p className="text-[9px] text-muted-foreground font-mono truncate flex items-center gap-1.5">
                v8.0_FINAL
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${aiStatus?.configured ? "bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.6)]" : "bg-red-400/50"}`} title={aiStatus?.configured ? "AI key configured" : "AI key not set"} />
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-muted-foreground hover:text-foreground p-1 shrink-0 ml-2"
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-3 custom-scrollbar">
          <ul className="space-y-0.5 px-2">
            {navItems.map((item) => {
              const isActive = location === item.href;
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link href={item.href}>
                    <div
                      onClick={onClose}
                      className={`
                        flex items-center gap-2.5 px-2.5 py-2 cursor-pointer
                        transition-all duration-150 rounded-none touch-manipulation
                        ${isActive
                          ? "bg-primary/10 text-primary"
                          : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                        }
                      `}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span className="font-medium uppercase text-[11px] tracking-wider truncate">{item.label}</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="p-3 border-t border-white/[0.06]">
          <div className="flex items-center gap-1.5 text-[9px] text-muted-foreground font-mono">
            <div className="w-1 h-1 rounded-full bg-primary animate-pulse" />
            SYSTEM ONLINE
          </div>
        </div>
      </div>
    </>
  );
}
