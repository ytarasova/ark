import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";

interface LoginPageProps {
  onLogin: (token: string) => void;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!key.trim()) {
      setError("API key is required");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/rpc", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.error) {
          setError("Invalid API key");
        } else {
          localStorage.setItem("ark-token", key);
          onLogin(key);
        }
      } else if (res.status === 401) {
        setError("Invalid API key");
      } else {
        setError(`Connection failed (HTTP ${res.status})`);
      }
    } catch {
      setError("Connection failed - is the server running?");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="w-full max-w-sm mx-auto px-6">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground mb-2">Ark</h1>
          <p className="text-sm text-muted-foreground">Enter your API key to continue</p>
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <Input
              type="password"
              placeholder="API Key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              autoFocus
              disabled={loading}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
          <Button
            type="submit"
            className="w-full"
            disabled={loading || !key.trim()}
          >
            {loading ? "Authenticating..." : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
