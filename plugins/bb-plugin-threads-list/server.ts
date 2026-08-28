import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { registerDeploymentIdentityCli } from "../../src/deployment-identity.js";
import { z } from "zod";

const id = z.string().min(1).max(256);
const state = z.string().min(1).max(128);
const collapse = z.enum(["project", "thread"]);
const execution = z.object({ model: z.string(), reasoning: z.string() }).strict();

export const rpcContract = defineRpcContract({
  threadStates: {
    input: z.object({ threadIds: z.array(id).max(256) }).strict(),
    output: z.record(z.string(), state),
  },
  threadModels: {
    input: z.object({ threadIds: z.array(id).max(256) }).strict(),
    output: z.record(z.string(), execution.nullable()),
  },
  setThreadState: {
    input: z.object({ threadId: id, state: state.nullable() }).strict(),
    output: z.object({ state: state.nullable() }).strict(),
  },
  sidebarCollapseState: {
    input: z.object({ projectIds: z.array(id).max(256), threadIds: z.array(id).max(256) }).strict(),
    output: z.object({ projects: z.record(z.string(), z.boolean()), threads: z.record(z.string(), z.boolean()) }).strict(),
  },
  setSidebarCollapse: {
    input: z.object({ kind: collapse, id, collapsed: z.boolean() }).strict(),
    output: z.object({ kind: collapse, id, collapsed: z.boolean() }).strict(),
  },
  reorderPinned: {
    input: z.object({ threadId: id, previousThreadId: id.nullable(), nextThreadId: id.nullable() }).strict(),
    output: z.array(id),
  },
  reorderProjects: {
    input: z.object({ projectId: id, previousProjectId: id.nullable(), nextProjectId: id.nullable() }).strict(),
    output: z.array(id),
  },
});

const stateKey = (threadId: string) => `thread-state:${threadId}`;
const collapseKey = (kind: "project" | "thread", value: string) => `collapse:${kind}:${value}`;

export default function plugin(bb: BbPluginApi) {
  registerDeploymentIdentityCli(bb, "threads-list", "threads-list", import.meta.url);
  bb.rpc.register(rpcContract, {
    async threadStates({ threadIds }) {
      const values = await Promise.all(threadIds.map(async (threadId) => {
        const value = await bb.storage.kv.get<unknown>(stateKey(threadId));
        return state.safeParse(value).success ? [threadId, value as string] as const : null;
      }));
      return Object.fromEntries(values.filter((value): value is readonly [string, string] => value !== null));
    },
    async threadModels({ threadIds }) {
      const values = await Promise.all(threadIds.map(async (threadId) => {
        try {
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId });
          return [threadId, options ? { model: options.model, reasoning: options.reasoningLevel } : null] as const;
        } catch { return [threadId, null] as const; }
      }));
      return Object.fromEntries(values);
    },
    async setThreadState(input) {
      if (input.state === null) await bb.storage.kv.delete(stateKey(input.threadId));
      else await bb.storage.kv.set(stateKey(input.threadId), input.state);
      return { state: input.state };
    },
    async sidebarCollapseState({ projectIds, threadIds }) {
      const read = async (kind: "project" | "thread", ids: string[]): Promise<Record<string, boolean>> => {
        const entries: Array<readonly [string, boolean]> = [];
        for (const value of ids) if (await bb.storage.kv.get<unknown>(collapseKey(kind, value)) === true) entries.push([value, true]);
        return Object.fromEntries(entries);
      };
      return { projects: await read("project", projectIds), threads: await read("thread", threadIds) };
    },
    async setSidebarCollapse(input) {
      await bb.storage.kv.set(collapseKey(input.kind, input.id), input.collapsed);
      return input;
    },
    async reorderPinned(input) {
      const threads = await bb.sdk.threads.reorderPinned(input);
      return threads.map((thread) => thread.id);
    },
    async reorderProjects(input) {
      const projects = await bb.sdk.projects.reorder(input);
      return projects.map((project) => project.id);
    },
  });
}
