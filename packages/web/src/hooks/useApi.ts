const BASE = window.location.origin;
const TOKEN = new URLSearchParams(window.location.search).get("token");

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (TOKEN) headers["Authorization"] = `Bearer ${TOKEN}`;
  return headers;
}

function authParams(): string {
  return TOKEN ? `?token=${TOKEN}` : "";
}

export async function fetchApi<T>(path: string, opts?: RequestInit): Promise<T> {
  const sep = path.includes("?") ? "&" : "?";
  const url = opts?.method === "POST"
    ? `${BASE}${path}`
    : `${BASE}${path}${TOKEN ? `${sep}token=${TOKEN}` : ""}`;
  const resp = await fetch(url, {
    ...opts,
    headers: {
      ...authHeaders(),
      ...opts?.headers,
    },
  });
  return resp.json();
}

async function apiPost<T>(path: string, body?: any): Promise<T> {
  return fetchApi<T>(path, {
    method: "POST",
    body: body ? JSON.stringify(body) : undefined,
  });
}

export const api = {
  getSessions: () => fetchApi<any[]>("/api/sessions"),
  getSession: (id: string) => fetchApi<any>(`/api/sessions/${id}`),
  getCosts: () => fetchApi<any>("/api/costs"),
  getStatus: () => fetchApi<any>("/api/status"),
  getGroups: () => fetchApi<string[]>("/api/groups"),
  getOutput: (id: string) => fetchApi<any>(`/api/sessions/${id}/output`),
  createSession: (data: any) => apiPost<any>("/api/sessions", data),
  dispatch: (id: string) => apiPost<any>(`/api/sessions/${id}/dispatch`),
  stop: (id: string) => apiPost<any>(`/api/sessions/${id}/stop`),
  restart: (id: string) => apiPost<any>(`/api/sessions/${id}/restart`),
  deleteSession: (id: string) => apiPost<any>(`/api/sessions/${id}/delete`),
  undelete: (id: string) => apiPost<any>(`/api/sessions/${id}/undelete`),
};
