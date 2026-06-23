import { Think, Workspace, type Session } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

interface Env {
  AI: Ai;
  MavAgent: DurableObjectNamespace;
  ASSETS: Fetcher;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}

type Project = {
  slug: string;
  name: string;
  createdAt: string;
};

type WorkspaceFile = {
  path: string;
  name: string;
  type: string;
  size?: number;
};

const REGISTRY_AGENT = "__registry";
const PROJECTS_FILE = "/admin/projects.json";
const DEFAULT_PROJECT_FILES = {
  "/PROJECT.md":
    "# Project\n\nDescribe what this project is, its goals, constraints, and important background.\n",
  "/CAPABILITIES.md":
    "# Capabilities\n\nDescribe what Mav believes this project can currently do through available apps, agents, workflows, and information.\n",
  "/REQUESTS.md":
    "# Requests\n\nTrack work that team members want clarified, organized, or routed.\n",
  "/BRIEFS.md": "# Briefs\n\nDescribe scheduled and on-demand brief preferences.\n",
};

const SESSION_COOKIE = "mav_admin";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export class MavAgent extends Think<Env> {
  override workspace = new Workspace({ sql: this.ctx.storage.sql, name: () => this.name });

  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            [
              "You are Mav, a company-context assistant and work orchestrator.",
              "You answer questions, provide updates, and help clarify requests within the currently selected project.",
              "You do not build, deploy, or directly change external business systems. When a capability is missing, explain the gap and help gather requirements.",
              `Current project: ${this.name}`,
            ].join("\n"),
        },
      })
      .withContext("project", {
        description: "Project documents from Mav's project-scoped workspace.",
        maxTokens: 6000,
        provider: { get: () => this.readProjectContext() },
      })
      .withContext("memory", {
        description: "Important facts about the user, project, and conversation.",
        maxTokens: 2000,
      })
      .withCachedPrompt();
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__mav/")) return this.handleAdminRequest(request);
    return super.fetch(request);
  }

  private async handleAdminRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/__mav/projects" && request.method === "GET") {
      return json({ projects: await this.listProjects() });
    }

    if (url.pathname === "/__mav/projects" && request.method === "POST") {
      const project = (await request.json()) as Project;
      return json({ project: await this.createProject(project) }, 201);
    }

    if (url.pathname === "/__mav/init" && request.method === "POST") {
      const project = (await request.json()) as Project;
      return json({ project: await this.initializeProject(project) });
    }

    const fileMatch = url.pathname.match(/^\/__mav\/files(?:\/(.*))?$/);
    if (fileMatch) {
      const filePath = fileMatch[1] ? `/${decodeURIComponent(fileMatch[1])}` : "/";

      if (request.method === "GET") {
        if (url.searchParams.get("content") === "1") {
          return json({ path: filePath, content: await this.readTextFile(filePath) });
        }
        return json({ files: await this.listFiles(filePath) });
      }

      if (request.method === "PUT") {
        const body = (await request.json()) as { content?: string };
        await this.writeTextFile(filePath, body.content || "");
        return json({ ok: true });
      }

      if (request.method === "POST") {
        const form = await request.formData();
        const file = form.get("file");
        if (!(file instanceof File)) return json({ error: "File is required" }, 400);
        await this.writeTextFile(`/${file.name}`, await file.text());
        return json({ ok: true });
      }

      if (request.method === "DELETE") {
        await this.deleteFile(filePath);
        return json({ ok: true });
      }
    }

    return json({ error: "Not found" }, 404);
  }

  async createProject(project: Project): Promise<Project> {
    const projects = await this.listProjects();
    const existing = projects.find((item) => item.slug === project.slug);
    if (existing) return existing;
    const next = [...projects, project].sort((a, b) => a.name.localeCompare(b.name));
    await this.workspace.writeFile(PROJECTS_FILE, JSON.stringify(next, null, 2));
    return project;
  }

  async listProjects(): Promise<Project[]> {
    const content = await this.workspace.readFile(PROJECTS_FILE);
    if (!content) return [];
    try {
      const parsed = JSON.parse(content) as Project[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async initializeProject(project: Project): Promise<Project> {
    for (const [path, content] of Object.entries(DEFAULT_PROJECT_FILES)) {
      const existing = await this.workspace.readFile(path);
      if (!existing)
        await this.workspace.writeFile(path, content.replace("# Project", `# ${project.name}`));
    }
    return project;
  }

  async listFiles(path = "/"): Promise<WorkspaceFile[]> {
    const entries = await this.workspace.readDir(path, { limit: 200 });
    return entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: entry.type,
      size: "size" in entry ? entry.size : undefined,
    }));
  }

  async readTextFile(path: string): Promise<string | null> {
    return this.workspace.readFile(normalizeWorkspacePath(path));
  }

  async writeTextFile(path: string, content: string): Promise<void> {
    await this.workspace.writeFile(normalizeWorkspacePath(path), content);
  }

  async deleteFile(path: string): Promise<void> {
    await this.workspace.rm(normalizeWorkspacePath(path), { force: true, recursive: false });
  }

  private async readProjectContext(): Promise<string> {
    const sections = await Promise.all(
      Object.keys(DEFAULT_PROJECT_FILES).map(async (path) => {
        const content = await this.workspace.readFile(path);
        return content ? `--- ${path} ---\n${content}` : null;
      }),
    );
    return sections.filter(Boolean).join("\n\n");
  }
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/login" && request.method === "POST") {
      return handleLogin(request, env);
    }

    if (url.pathname === "/api/logout" && request.method === "POST") {
      return new Response(null, {
        status: 204,
        headers: { "Set-Cookie": clearSessionCookie() },
      });
    }

    if (!(await isAuthorized(request, env))) {
      if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/agents/")) {
        return json({ error: "Unauthorized" }, 401);
      }
      return loginPage();
    }

    const apiResponse = await handleApiRequest(request, env);
    if (apiResponse) return apiResponse;

    return (await routeAgentRequest(request, env)) || env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleApiRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/api/projects" && request.method === "GET") {
    return fetchAgent(env, REGISTRY_AGENT, "/__mav/projects");
  }

  if (url.pathname === "/api/projects" && request.method === "POST") {
    const body = (await request.json()) as { name?: string; slug?: string };
    const name = body.name?.trim();
    const slug = normalizeSlug(body.slug || body.name || "");
    if (!name || !slug) return json({ error: "Project name is required" }, 400);
    const project = {
      slug,
      name,
      createdAt: new Date().toISOString(),
    };
    const createResponse = await fetchAgent(env, REGISTRY_AGENT, "/__mav/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(project),
    });
    const data = (await createResponse.clone().json()) as { project: Project };
    await fetchAgent(env, slug, "/__mav/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data.project),
    });
    return createResponse;
  }

  const fileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/files(?:\/(.*))?$/);
  if (fileMatch) {
    const slug = normalizeSlug(decodeURIComponent(fileMatch[1]));
    const filePath = fileMatch[2] ? `/${decodeURIComponent(fileMatch[2])}` : "/";
    const agentPath = `/__mav/files${encodeWorkspaceUrlPath(filePath)}${url.search}`;

    if (request.method === "GET") {
      return fetchAgent(env, slug, agentPath);
    }

    if (request.method === "PUT") {
      return fetchAgent(env, slug, agentPath, request);
    }

    if (request.method === "POST") {
      return fetchAgent(env, slug, "/__mav/files", request);
    }

    if (request.method === "DELETE") {
      return fetchAgent(env, slug, agentPath, request);
    }
  }

  return null;
}

function getAgentStub(env: Env, name: string): DurableObjectStub {
  const id = env.MavAgent.idFromName(name);
  return env.MavAgent.get(id);
}

function fetchAgent(env: Env, name: string, path: string, init?: RequestInit | Request) {
  return getAgentStub(env, name).fetch(new Request(`https://mav.internal${path}`, init));
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
  const configuredPassword = env.ADMIN_PASSWORD?.trim();
  if (!configuredPassword) return json({ error: "ADMIN_PASSWORD is not configured" }, 503);

  const body = await request.formData();
  const configuredUsername = env.ADMIN_USERNAME?.trim();
  const username = String(body.get("username") || "").trim();
  const password = String(body.get("password") || "").trim();
  if (configuredUsername && username !== configuredUsername)
    return loginPage("Invalid username", 401);
  if (password !== configuredPassword) return loginPage("Invalid password", 401);

  const expires = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const token = `${expires}.${await sign(`${expires}`, configuredPassword)}`;
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Set-Cookie": `${SESSION_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_SECONDS}`,
    },
  });
}

async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const password = env.ADMIN_PASSWORD?.trim();
  if (!password) return false;
  const token = parseCookies(request.headers.get("Cookie") || "")[SESSION_COOKIE];
  if (!token) return false;
  const [expiresText, signature] = token.split(".");
  const expires = Number(expiresText);
  if (!expires || expires < Math.floor(Date.now() / 1000) || !signature) return false;
  return signature === (await sign(expiresText, password));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function parseCookies(header: string): Record<string, string> {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key, value]),
  );
}

function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

function loginPage(error?: string, status = 200): Response {
  return new Response(
    `<!doctype html><html><head><title>Mav Admin</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#eef4df;color:#17201a;font-family:Inter,ui-sans-serif,system-ui,sans-serif}.card{background:#fffdf5;border:1px solid #c9d6b1;border-radius:28px;box-shadow:0 24px 70px rgb(29 43 27 / 18%);padding:36px;width:min(420px,calc(100vw - 32px))}h1{font-size:3.5rem;letter-spacing:-.08em;line-height:.9;margin:0 0 12px}p{color:#5c6d4d}label{display:block;color:#405236;font-size:.84rem;font-weight:700;margin:14px 0 6px}input,button{box-sizing:border-box;font:inherit;width:100%;border-radius:999px;padding:14px 16px}input{border:1px solid #bdcaa7;background:white}button{border:0;background:#1e2f1c;color:#fffdf5;cursor:pointer;margin-top:16px}.error{color:#8a2d20}</style></head><body><main class="card"><h1>Mav</h1><p>Admin access is required.</p>${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}<form method="post" action="/api/login" autocomplete="on"><label for="username">Username</label><input id="username" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required><label for="password">Password</label><input id="password" name="password" type="password" placeholder="Admin password" autocomplete="current-password" autofocus required><button type="submit">Unlock</button></form></main></body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeWorkspacePath(path: string): string {
  const normalized = `/${path}`.replace(/\/+/g, "/");
  if (normalized.includes("..")) throw new Error("Invalid path");
  return normalized;
}

function encodeWorkspaceUrlPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/").replace(/^/, "/");
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>'"]/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char] || char,
  );
}
