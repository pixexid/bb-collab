import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import {
  messageMutationInputSchema,
  operatorMessageSchema,
  operatorMessagesInputSchema,
  operatorMessagesResultSchema,
  replyInputSchema,
  rpcContract,
} from "./contract.js";

const CORE_PLUGIN_ID = "bb-collab";
const READ_TIMEOUT_MS = 4_000;
const CORE_METHODS = {
  read: "v1-inbox-read",
  markRead: "v1-inbox-mark-read",
  archive: "v1-inbox-archive",
  reply: "v1-inbox-reply",
} as const;

async function withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`bb-collab ${method} timed out after ${READ_TIMEOUT_MS}ms`)), READ_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export default function plugin(bb: BbPluginApi) {
  const reads = new Map<string, Promise<unknown>>();
  const idempotentMutations = new Map<string, Promise<unknown>>();
  const replies = new Map<string, Promise<unknown>>();

  const read = (input: z.infer<typeof operatorMessagesInputSchema>) => {
    const key = JSON.stringify(input);
    let call = reads.get(key);
    if (!call) {
      call = bb.sdk.plugins.callRpc({
        pluginId: CORE_PLUGIN_ID,
        method: CORE_METHODS.read,
        input,
        outputSchema: operatorMessagesResultSchema,
      }).finally(() => { reads.delete(key); });
      reads.set(key, call);
    }
    return withTimeout(call, CORE_METHODS.read).then((result) => operatorMessagesResultSchema.parse(result));
  };

  const mutate = (
    method: typeof CORE_METHODS.markRead | typeof CORE_METHODS.archive,
    input: z.infer<typeof messageMutationInputSchema>,
  ) => {
    const key = JSON.stringify([method, input.projectId, input.messageId]);
    let call = idempotentMutations.get(key);
    if (!call) {
      call = bb.sdk.plugins.callRpc({
        pluginId: CORE_PLUGIN_ID,
        method,
        input,
        outputSchema: operatorMessageSchema,
      }).finally(() => { idempotentMutations.delete(key); });
      idempotentMutations.set(key, call);
    }
    return withTimeout(call, method).then((result) => operatorMessageSchema.parse(result));
  };

  bb.rpc.register(rpcContract, {
    operatorMessages: read,
    markOperatorMessageRead(input) { return mutate(CORE_METHODS.markRead, input); },
    archiveOperatorMessage(input) { return mutate(CORE_METHODS.archive, input); },
    replyToOperatorMessage(input: z.infer<typeof replyInputSchema>) {
      // Core may validly wait 30s for idle and another 10s for delivery proof.
      // An uncancellable outer timeout would turn that into an ambiguous retry.
      const key = JSON.stringify([input.projectId, input.messageId]);
      let call = replies.get(key);
      if (!call) {
        call = bb.sdk.plugins.callRpc({
          pluginId: CORE_PLUGIN_ID,
          method: CORE_METHODS.reply,
          input,
          outputSchema: operatorMessageSchema,
        }).finally(() => { replies.delete(key); });
        replies.set(key, call);
      }
      return call.then((result) => operatorMessageSchema.parse(result));
    },
  });
}
