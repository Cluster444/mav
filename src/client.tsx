import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function Chat() {
  const agent = useAgent({ agent: "MavAgent" });
  const { messages, sendMessage, status } = useAgentChat({ agent });

  return (
    <main className="shell">
      <section className="panel">
        <p className="eyebrow">Cloudflare Think Agent</p>
        <h1>Mav</h1>
        <p className="intro">
          A persistent Workers AI-backed agent with workspace file tools and memory.
        </p>

        <div className="messages" aria-live="polite">
          {messages.length === 0 ? (
            <p className="empty">Ask Mav to reason about the project or remember something.</p>
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
          <input name="input" placeholder="Send a message..." />
          <button type="submit">Send</button>
        </form>

        <p className="status">Status: {status}</p>
      </section>
    </main>
  );
}

const root = document.getElementById("root");

if (root) {
  createRoot(root).render(<Chat />);
}
