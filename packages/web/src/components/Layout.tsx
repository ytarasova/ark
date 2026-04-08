import { useState } from "react";
import { cn } from "../lib/utils.js";
import { Sidebar } from "./Sidebar.js";

interface LayoutProps {
  view: string;
  onNavigate: (view: string) => void;
  readOnly: boolean;
  title: string;
  headerLeft?: React.ReactNode;
  headerRight?: React.ReactNode;
  padded?: boolean;
  children: React.ReactNode;
}

export function Layout({ view, onNavigate, readOnly, title, headerLeft, headerRight, padded = true, children }: LayoutProps) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("ark-sidebar-collapsed") === "true");

  function handleToggle() {
    setCollapsed(prev => {
      const next = !prev;
      localStorage.setItem("ark-sidebar-collapsed", String(next));
      return next;
    });
  }

  return (
    <div className={cn("grid h-screen bg-transparent", collapsed ? "grid-cols-[48px_1fr]" : "grid-cols-[200px_1fr] max-md:grid-cols-[48px_1fr]")}>
      <Sidebar activeView={view} onNavigate={onNavigate} readOnly={readOnly} collapsed={collapsed} onToggle={handleToggle} />
      <div className="overflow-y-auto flex flex-col bg-background">
        <div className="h-12 px-5 border-b border-border flex items-center justify-between bg-background/80 backdrop-blur-xl sticky top-0 z-10 shrink-0">
          <div className="flex items-center gap-3">
            <h1 className="text-[15px] font-semibold text-foreground">{title}</h1>
            {headerLeft}
          </div>
          <div className="flex items-center gap-3">
            {headerRight}
          </div>
        </div>
        <div className={cn("flex-1 overflow-y-auto flex flex-col", padded && "p-5 px-6")}>
          {children}
        </div>
      </div>
    </div>
  );
}
