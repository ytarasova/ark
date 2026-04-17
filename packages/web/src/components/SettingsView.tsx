import { cn } from "../lib/utils.js";
import { Card } from "./ui/card.js";
import { Moon, Sun, Monitor, Palette } from "lucide-react";
import { useTheme } from "../themes/ThemeProvider.js";
import type { ThemeName, ColorMode } from "../themes/tokens.js";

const THEME_OPTIONS: {
  id: ThemeName;
  label: string;
  accent: string;
  description: string;
}[] = [
  {
    id: "midnight-circuit",
    label: "Midnight Circuit",
    accent: "#7c6aef",
    description: "Deep violet accent, dark blue-purple backgrounds",
  },
  {
    id: "arctic-slate",
    label: "Arctic Slate",
    accent: "#3b82f6",
    description: "Cool blue accent, neutral slate backgrounds",
  },
  {
    id: "warm-obsidian",
    label: "Warm Obsidian",
    accent: "#d4a847",
    description: "Gold accent, warm charcoal backgrounds",
  },
];

const MODE_OPTIONS: {
  id: ColorMode | "system";
  label: string;
  icon: typeof Monitor;
}[] = [
  { id: "system", label: "System", icon: Monitor },
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
];

export function SettingsView() {
  const { themeName, colorMode, setThemeName, setColorMode } = useTheme();

  // Detect if "system" was effectively selected (no stored mode preference)
  const storedMode = (() => {
    try {
      return localStorage.getItem("ark-color-mode");
    } catch {
      return null;
    }
  })();
  const effectiveMode = storedMode === null ? "system" : colorMode;

  function handleModeChange(mode: ColorMode | "system") {
    if (mode === "system") {
      // Remove stored preference so ThemeProvider follows OS
      try {
        localStorage.removeItem("ark-color-mode");
      } catch {
        /* noop */
      }
      const systemDark = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      setColorMode(systemDark);
    } else {
      setColorMode(mode);
    }
  }

  return (
    <div className="p-6 max-w-2xl">
      <h1 className="text-lg font-semibold mb-6 text-foreground">Settings</h1>

      {/* Theme Selection */}
      <section className="mb-8">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3 flex items-center gap-1.5">
          <Palette size={12} />
          Theme
        </h2>
        <div className="grid grid-cols-3 gap-3">
          {THEME_OPTIONS.map((opt) => {
            const isSelected = themeName === opt.id;
            return (
              <Card
                key={opt.id}
                onClick={() => setThemeName(opt.id)}
                className={cn(
                  "cursor-pointer p-3 transition-all",
                  isSelected ? "ring-2 ring-primary border-primary" : "hover:border-ring hover:bg-accent",
                )}
              >
                {/* Color swatch preview */}
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className="w-5 h-5 rounded-full shrink-0 border border-border"
                    style={{ background: opt.accent }}
                  />
                  <span
                    className={cn("text-[13px] font-medium", isSelected ? "text-foreground" : "text-muted-foreground")}
                  >
                    {opt.label}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-relaxed">{opt.description}</p>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Color Mode */}
      <section className="mb-8">
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3">Color Mode</h2>
        <div className="grid grid-cols-3 gap-3">
          {MODE_OPTIONS.map((opt) => {
            const isSelected = effectiveMode === opt.id;
            return (
              <Card
                key={opt.id}
                onClick={() => handleModeChange(opt.id)}
                className={cn(
                  "cursor-pointer p-3 transition-all",
                  isSelected ? "ring-2 ring-primary border-primary" : "hover:border-ring hover:bg-accent",
                )}
              >
                <div className="flex items-center gap-2">
                  <opt.icon
                    size={14}
                    className={cn("shrink-0", isSelected ? "text-primary" : "text-muted-foreground")}
                  />
                  <span
                    className={cn("text-[13px] font-medium", isSelected ? "text-foreground" : "text-muted-foreground")}
                  >
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
        <h2 className="text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.08em] mb-3">About</h2>
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
                href="https://ytarasova.github.io/ark/"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[13px] text-primary hover:underline"
              >
                Docs
              </a>
            </div>
          </div>
        </Card>
      </section>
    </div>
  );
}
