import { useState } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/hooks/use-auth";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Terminal, ShieldAlert, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

export default function Login() {
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("admin");
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const success = await login(password, username);
    setLoading(false);
    
    if (success) {
      toast({
        title: "ACCESS GRANTED",
        description: "Welcome to H@0 Checker V8.0 Dashboard",
        variant: "default",
      });
      setLocation("/");
    } else {
      toast({
        title: "ACCESS DENIED",
        description: "Invalid credentials.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#4f4f4f2e_1px,transparent_1px),linear-gradient(to_bottom,#4f4f4f2e_1px,transparent_1px)] bg-[size:14px_24px] [mask-image:radial-gradient(ellipse_60%_50%_at_50%_0%,#000_70%,transparent_100%)]"></div>
      
      <Card className="glass-panel w-full max-w-md relative z-10 rounded-none border-primary/50 shadow-[0_0_30px_rgba(0,255,128,0.15)]">
        <CardHeader className="text-center pb-8 border-b border-white/[0.06]">
          <div className="mx-auto bg-primary/10 w-16 h-16 flex items-center justify-center mb-4 rounded-full border border-primary/30">
            <Terminal className="w-8 h-8 text-primary shadow-[0_0_15px_rgba(0,255,128,0.5)]" />
          </div>
          <CardTitle className="text-3xl font-display font-bold glitch-text text-primary tracking-widest">
            H@0 CHK V8.0
          </CardTitle>
          <p className="text-muted-foreground font-mono text-xs uppercase tracking-widest mt-2">
            System Authentication Required
          </p>
        </CardHeader>
        <CardContent className="pt-8">
          <form onSubmit={handleLogin} className="space-y-6">
            <div className="space-y-2">
              <label className="text-xs font-mono text-muted-foreground flex items-center gap-2 uppercase tracking-wider">
                Username
              </label>
              <Input
                type="text"
                placeholder="admin"
                className="bg-background/50 border-white/[0.08] font-mono rounded-none focus-visible:ring-primary"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                data-testid="input-username"
              />
            </div>
            <div className="space-y-2">
              <label className="text-xs font-mono text-primary flex items-center gap-2 uppercase tracking-wider">
                <ShieldAlert className="w-3 h-3" />
                Password
              </label>
              <Input
                type="password"
                placeholder="Enter access code"
                className="bg-background/50 border-white/[0.08] font-mono rounded-none focus-visible:ring-primary focus-visible:border-primary text-center tracking-widest text-lg"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                data-testid="input-password"
              />
            </div>
            <Button 
              type="submit" 
              disabled={loading}
              className="w-full rounded-none font-display font-bold tracking-widest bg-primary text-black transition-all duration-300 shadow-[0_0_10px_rgba(0,255,128,0.2)] hover:shadow-[0_0_20px_rgba(0,255,128,0.6)]"
              data-testid="button-login"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
              INITIALIZE CONNECTION
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
