import { useState, useEffect, useCallback } from "react";
import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Monitor, Moon, Sun } from "lucide-react";

type Theme = "system" | "dark" | "light";

const STORAGE_KEY = "ark-theme";

function getStoredTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "system" || stored === "dark" || stored === "light") return stored;
  return "dark";
}

function getSystemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme) {
  const html = document.documentElement;
  if (theme === "dark" || (theme === "system" && getSystemDark())) {
    html.classList.add("dark");
  } else {
    html.classList.remove("dark");
  }
}

export function SettingsView() {
  const [theme, setTheme] = useState<Theme>(getStoredTheme);

  const handleThemeChange = useCallback((t: Theme) => {
    setTheme(t);
    localStorage.setItem(STORAGE_KEY, t);
    applyTheme(t);
  }, []);

  // Listen for system theme changes when "system" is selected
  useEffect(() => {
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => applyTheme("system");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  // Apply on mount (in case stored preference differs from current HTML state)
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);

  const options: { id: Theme; label: string; icon: typeof Monitor; preview: { bg: string; bar: string; card: string } }[] = [
    {
      id: "system",
      label: "System",
      icon: Monitor,
      preview: { bg: "bg-gradient-to-r from-zinc-800 to-zinc-200", bar: "bg-gradient-to-r from-zinc-700 to-zinc-300", card: "bg-gradient-to-r from-zinc-600 to-zinc-400" },
    },
    {
      id: "dark",
      label: "Dark",
      icon: Moon,
      preview: { bg: "bg-zinc-900", bar: "bg-zinc-700", card: "bg-zinc-800" },
    },
    {
      id: "light",
      label: "Light",
      icon: Sun,
      preview: { bg: "bg-zinc-100", bar: "bg-zinc-300", card: "bg-white" },
    },
  ];

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-lg font-semibold mb-6 text-foreground">Settings</h1>

      {/* Appearance */}
      <section className="mb-8">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3">
          Appearance
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {options.map((opt) => {
            const selected = theme === opt.id;
            return (
              <Card
                key={opt.id}
                onClick={() => handleThemeChange(opt.id)}
                className={cn(
                  "cursor-pointer p-3 transition-all",
                  selected
                    ? "ring-2 ring-primary border-primary"
                    : "hover:border-ring hover:bg-accent"
                )}
              >
                {/* Mini preview */}
                <div className={cn("rounded-md h-16 mb-2.5 p-2 flex flex-col gap-1", opt.preview.bg)}>
                  <div className={cn("h-1.5 w-10 rounded-full", opt.preview.bar)} />
                  <div className={cn("flex-1 rounded", opt.preview.card)} />
                </div>
                <div className="flex items-center gap-2">
                  <opt.icon size={14} className={cn(
                    "shrink-0",
                    selected ? "text-primary" : "text-muted-foreground"
                  )} />
                  <span className={cn(
                    "text-[13px] font-medium",
                    selected ? "text-foreground" : "text-muted-foreground"
                  )}>
                    {opt.label}
                  </span>
                </div>
              </Card>
            );
          })}
        </div>
      </section>

      {/* About */}
      <section className="mb-8">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3">
          About
        </h2>
        <Card className="p-4">
          <div className="space-y-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">Version</span>
              <span className="text-[13px] text-foreground font-mono">v0.10.0</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">Runtime</span>
              <span className="text-[13px] text-foreground font-mono">Bun</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[13px] text-muted-foreground">Documentation</span>
              <a
                href="https://github.com/anthropics/ark"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-primary hover:underline"
              >
                GitHub
              </a>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
