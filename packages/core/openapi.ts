/**
 * OpenAPI 3.0 specification for the Ark web API.
 */

const DEFAULT_WEB_URL = process.env.ARK_WEB_URL || "http://localhost:8420";

export function generateOpenApiSpec(): object {
  return {
    openapi: "3.0.3",
    info: {
      title: "Ark API",
      version: "0.6.0",
      description: "Ark autonomous agent ecosystem API",
    },
    servers: [{ url: DEFAULT_WEB_URL, description: "Local" }],
    paths: {
      "/api/sessions": {
        get: {
          summary: "List sessions",
          tags: ["Sessions"],
          responses: { "200": { description: "Session list", content: { "application/json": { schema: { type: "array", items: { $ref: "#/components/schemas/Session" } } } } } },
        },
        post: {
          summary: "Create session",
          tags: ["Sessions"],
          requestBody: { content: { "application/json": { schema: { type: "object", properties: { summary: { type: "string" }, repo: { type: "string" }, flow: { type: "string" }, group_name: { type: "string" }, workdir: { type: "string" } } } } } },
          responses: { "200": { description: "Created" } },
        },
      },
      "/api/sessions/{id}": {
        get: {
          summary: "Get session detail",
          tags: ["Sessions"],
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "Session with events" }, "404": { description: "Not found" } },
        },
      },
      "/api/sessions/{id}/dispatch": {
        post: { summary: "Dispatch session", tags: ["Sessions"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Dispatched" } } },
      },
      "/api/sessions/{id}/stop": {
        post: { summary: "Stop session", tags: ["Sessions"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Stopped" } } },
      },
      "/api/sessions/{id}/restart": {
        post: { summary: "Restart session", tags: ["Sessions"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Restarted" } } },
      },
      "/api/sessions/{id}/delete": {
        post: { summary: "Delete session", tags: ["Sessions"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Deleted" } } },
      },
      "/api/sessions/{id}/output": {
        get: { summary: "Get live output", tags: ["Sessions"], parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Output text" } } },
      },
      "/api/costs": {
        get: { summary: "Get cost summary", tags: ["Costs"], responses: { "200": { description: "Cost data" } } },
      },
      "/api/status": {
        get: { summary: "System status", tags: ["System"], responses: { "200": { description: "Status counts" } } },
      },
      "/api/groups": {
        get: { summary: "List groups", tags: ["System"], responses: { "200": { description: "Group names" } } },
      },
      "/api/events/stream": {
        get: { summary: "SSE event stream", tags: ["System"], responses: { "200": { description: "Server-Sent Events stream" } } },
      },
    },
    components: {
      schemas: {
        Session: {
          type: "object",
          properties: {
            id: { type: "string" }, summary: { type: "string" }, status: { type: "string" },
            repo: { type: "string" }, branch: { type: "string" }, agent: { type: "string" },
            flow: { type: "string" }, stage: { type: "string" }, group_name: { type: "string" },
            created_at: { type: "string" }, updated_at: { type: "string" },
          },
        },
      },
      securitySchemes: {
        bearerAuth: { type: "http", scheme: "bearer" },
        queryToken: { type: "apiKey", in: "query", name: "token" },
      },
    },
  };
}
