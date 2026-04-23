import { useState } from "react";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useTransport } from "../transport/TransportContext.js";

interface LoginPageProps {
  onLogin: (token: string) => void;
}

/**
 * Login page. Instead of its own `fetch("/api/rpc")` + `localStorage.setItem`,
 * we route through the injected transport:
 *   1. `setToken(key)` so the probe request goes out authenticated.
 *   2. `rpc("session/list")` as a cheap auth-validation RPC.
 *   3. On failure, clear the token and surface the error.
 *
 * Persistence (localStorage) is the transport's concern; the page just pokes
 * the transport.
 */
export function LoginPage({ onLogin }: LoginPageProps) {
  const transport = useTransport();
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
    transport.setToken(key);
    try {
      await transport.rpc("session/list", {});
      onLogin(key);
    } catch (err) {
      transport.setToken(null);
      const message = err instanceof Error ? err.message : "";
      if (/auth|unauthor|401/i.test(message)) {
        setError("Invalid API key");
      } else if (message) {
        setError(message);
      } else {
        setError("Connection failed - is the server running?");
      }
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
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={loading || !key.trim()}>
            {loading ? "Authenticating..." : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  );
}
