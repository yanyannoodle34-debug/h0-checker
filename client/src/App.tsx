import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { useEffect } from "react";

import NotFound from "@/pages/not-found";
import MainLayout from "@/components/layout/MainLayout";
import Dashboard from "@/pages/Dashboard";
import CardChecker from "@/pages/CardChecker";
import Login from "@/pages/Login";
import Proxies from "@/pages/Proxies";
import Configs from "@/pages/Configs";
import Keys from "@/pages/Keys";
import Users from "@/pages/Users";
import CardGen from "@/pages/CardGen";
import Hitter from "@/pages/Hitter";
import Miner from "@/pages/Miner";
import URLProcessor from "@/pages/URLProcessor";
import BotSettings from "@/pages/BotSettings";
import Handbook from "@/pages/Handbook";
import AIConsole from "@/pages/AI";

// Protected Route Wrapper
const ProtectedRoute = ({ component: Component }: { component: any }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const [, setLocation] = useLocation();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      setLocation("/login");
    }
  }, [isAuthenticated, isLoading, setLocation]);

  if (isLoading || !isAuthenticated) return null;

  return (
    <MainLayout>
      <Component />
    </MainLayout>
  );
};

function Router() {
  return (
    <Switch>
      <Route path="/login" component={Login} />
      
      {/* Protected Routes */}
      <Route path="/">
        <ProtectedRoute component={Dashboard} />
      </Route>
      <Route path="/checker">
        <ProtectedRoute component={CardChecker} />
      </Route>
      <Route path="/generator">
        <ProtectedRoute component={CardGen} />
      </Route>
      <Route path="/proxies">
        <ProtectedRoute component={Proxies} />
      </Route>
      <Route path="/configs">
        <ProtectedRoute component={Configs} />
      </Route>
      <Route path="/ai">
        <ProtectedRoute component={AIConsole} />
      </Route>
      <Route path="/keys">
        <ProtectedRoute component={Keys} />
      </Route>
      <Route path="/users">
        <ProtectedRoute component={Users} />
      </Route>
      <Route path="/hitter">
        <ProtectedRoute component={Hitter} />
      </Route>
      <Route path="/miner">
        <ProtectedRoute component={Miner} />
      </Route>
      <Route path="/extractor">
        <ProtectedRoute component={URLProcessor} />
      </Route>
      <Route path="/bot-settings">
        <ProtectedRoute component={BotSettings} />
      </Route>
      <Route path="/handbook">
        <ProtectedRoute component={Handbook} />
      </Route>

      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <div className="scanline-overlay" />
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;