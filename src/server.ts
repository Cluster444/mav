import { Think, type Session } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { createWorkersAI } from "workers-ai-provider";
import type { LanguageModel } from "ai";

interface Env {
  AI: Ai;
  MavAgent: DurableObjectNamespace;
}

export class MavAgent extends Think<Env> {
  getModel(): LanguageModel {
    return createWorkersAI({ binding: this.env.AI })("@cf/moonshotai/kimi-k2.6");
  }

  configureSession(session: Session) {
    return session
      .withContext("soul", {
        provider: {
          get: async () =>
            "You are Mav, a helpful assistant with access to a persistent workspace filesystem.",
        },
      })
      .withContext("memory", {
        description: "Important facts about the user, project, and conversation.",
        maxTokens: 2000,
      })
      .withCachedPrompt();
  }
}

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) || new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
