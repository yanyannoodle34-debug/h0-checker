import { ReactNode, useState } from "react";
import Sidebar from "./Sidebar";
import Header from "./Header";

interface MainLayoutProps {
  children: ReactNode;
}

export default function MainLayout({ children }: MainLayoutProps) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen bg-background text-foreground flex">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />

      <div className="flex-1 lg:ml-56 flex flex-col min-h-screen min-w-0">
        <Header onMenuToggle={() => setSidebarOpen(prev => !prev)} />
        <main className="flex-1 p-4 sm:p-5 md:p-6 lg:p-8 overflow-x-hidden">
          <div className="max-w-[1400px] mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
