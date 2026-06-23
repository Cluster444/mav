import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import "./styles.css";

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

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState(localStorage.getItem("mav.project") || "");
  const [projectName, setProjectName] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadProjects() {
    const response = await fetch("/api/projects");
    if (!response.ok) throw new Error("Could not load projects");
    const data = (await response.json()) as { projects: Project[] };
    setProjects(data.projects);
    if (!activeProject && data.projects[0]) setActiveProject(data.projects[0].slug);
    setLoading(false);
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    if (activeProject) localStorage.setItem("mav.project", activeProject);
  }, [activeProject]);

  async function createProject(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = projectName.trim();
    if (!name) return;
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response.ok) throw new Error("Could not create project");
    const data = (await response.json()) as { project: Project };
    setProjectName("");
    await loadProjects();
    setActiveProject(data.project.slug);
  }

  const selected = projects.find((project) => project.slug === activeProject);

  return (
    <main className="shell">
      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Mav Admin</p>
            <h1>Mav</h1>
          </div>
          <form action="/api/logout" method="post">
            <button className="secondary" type="submit">
              Lock
            </button>
          </form>
        </header>

        <section className="projectbar">
          <label>
            Project
            <select
              value={activeProject}
              onChange={(event) => setActiveProject(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.slug} value={project.slug}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <form className="create-project" onSubmit={createProject}>
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="New project name"
            />
            <button type="submit">Create</button>
          </form>
        </section>

        {loading ? <p className="empty">Loading projects...</p> : null}
        {!loading && !selected ? (
          <p className="empty">Create or select a project to begin.</p>
        ) : null}
        {selected ? <ProjectWorkspace key={selected.slug} project={selected} /> : null}
      </section>
    </main>
  );
}

function ProjectWorkspace({ project }: { project: Project }) {
  return (
    <section className="project-grid">
      <Chat project={project} />
      <Files project={project} />
    </section>
  );
}

function Chat({ project }: { project: Project }) {
  const agent = useAgent({ agent: "MavAgent", name: project.slug });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <section className="panel chat-panel">
      <p className="eyebrow">Direct Chat</p>
      <h2>{project.name}</h2>
      <p className="intro">Project-scoped conversation, memory, and workspace tools.</p>

      <div className="messages" aria-live="polite">
        {messages.length === 0 ? (
          <p className="empty">Ask Mav about this project or have it update project documents.</p>
        ) : (
          messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <strong>{message.role}</strong>
              <div>
                {message.parts.map((part, index) =>
                  part.type === "text" ? <span key={index}>{part.text}</span> : null,
                )}
              </div>
            </article>
          ))
        )}
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          const input = event.currentTarget.elements.namedItem("input") as HTMLInputElement;
          if (!input.value.trim()) return;
          void sendMessage({ text: input.value });
          input.value = "";
        }}
      >
        <input name="input" placeholder={`Message Mav about ${project.name}...`} />
        <button type="submit">Send</button>
      </form>

      <p className="status">Status: {status}</p>
    </section>
  );
}

function Files({ project }: { project: Project }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [activePath, setActivePath] = useState("/PROJECT.md");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState("");

  async function loadFiles() {
    const response = await fetch(`/api/projects/${project.slug}/files`);
    const data = (await response.json()) as { files: WorkspaceFile[] };
    setFiles(data.files.filter((file) => file.type === "file"));
  }

  async function loadFile(path: string) {
    setActivePath(path);
    const response = await fetch(
      `/api/projects/${project.slug}/files${encodePath(path)}?content=1`,
    );
    const data = (await response.json()) as { content: string | null };
    setContent(data.content || "");
  }

  useEffect(() => {
    void loadFiles().then(() => loadFile(activePath));
  }, [project.slug]);

  async function saveFile() {
    setStatus("Saving...");
    await fetch(`/api/projects/${project.slug}/files${encodePath(activePath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    await loadFiles();
    setStatus("Saved");
  }

  async function uploadFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const form = new FormData();
    form.set("file", file);
    setStatus("Uploading...");
    await fetch(`/api/projects/${project.slug}/files`, { method: "POST", body: form });
    await loadFiles();
    await loadFile(`/${file.name}`);
    setStatus("Uploaded");
  }

  async function deleteFile() {
    if (!confirm(`Delete ${activePath}?`)) return;
    await fetch(`/api/projects/${project.slug}/files${encodePath(activePath)}`, {
      method: "DELETE",
    });
    await loadFiles();
    await loadFile("/PROJECT.md");
  }

  return (
    <section className="panel files-panel">
      <p className="eyebrow">Project Files</p>
      <div className="file-actions">
        <label className="upload">
          Upload text
          <input type="file" onChange={uploadFile} />
        </label>
        <button className="secondary" type="button" onClick={deleteFile}>
          Delete
        </button>
      </div>
      <div className="file-browser">
        <nav className="file-list">
          {files.map((file) => (
            <button
              className={file.path === activePath ? "active" : ""}
              key={file.path}
              type="button"
              onClick={() => loadFile(file.path)}
            >
              {file.path}
            </button>
          ))}
        </nav>
        <div className="editor">
          <input value={activePath} onChange={(event) => setActivePath(event.target.value)} />
          <textarea value={content} onChange={(event) => setContent(event.target.value)} />
          <div className="editor-footer">
            <button type="button" onClick={saveFile}>
              Save file
            </button>
            <span>{status}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/").replace(/^/, "/");
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<App />);
}
