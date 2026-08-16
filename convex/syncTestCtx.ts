// A stand-in for the ActionCtx the sync engine's helper layers take.
//
// Those layers used to live inside `"use node"` sync.ts, where convex-test
// cannot reach them — which is why the claim protocol, the pending -> posted
// rekey and hide-and-unmap have never had a test between them, despite being
// the three places a bug silently duplicates or loses a Notion row. Splitting
// them into plain modules made them callable; this makes them observable.
//
// Deliberately a fake rather than a real deployment: what these tests are
// about is the *order* of calls — claim, then create, then map — and a fake
// records that order exactly. The mutations themselves are already covered
// against a real database in syncData.test.ts.

import { getFunctionName } from "convex/server";
import type { ActionCtx } from "./_generated/server";

export interface Call {
  name: string;
  args: any;
}

export interface FakeCtx {
  ctx: ActionCtx;
  // Every runQuery/runMutation, in order, as "module:function".
  calls: Call[];
  names: () => string[];
}

// A generated function reference is an opaque object, not a string. Convex
// exports the accessor, which gives "module:function" — the name a test wants
// to assert on.
function refName(ref: any): string {
  try {
    return getFunctionName(ref);
  } catch {
    return String(ref?.name ?? "unknown");
  }
}

export function fakeCtx(
  handlers: Record<string, (args: any) => unknown>,
): FakeCtx {
  const calls: Call[] = [];
  const run = (ref: any, args: any) => {
    const name = refName(ref);
    calls.push({ name, args });
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`no fake for ${name}`);
    }
    return Promise.resolve(handler(args));
  };
  const ctx = {
    runQuery: run,
    runMutation: run,
    runAction: run,
    scheduler: {
      runAfter: (_delay: number, ref: any, args: any) => run(ref, args),
      runAt: (_time: number, ref: any, args: any) => run(ref, args),
    },
  } as unknown as ActionCtx;
  return { ctx, calls, names: () => calls.map((call) => call.name) };
}

// A fetch stub for the Notion calls these layers make, recording each request
// so a test can say "and it never created a second page".
export interface FakeNotion {
  requests: Array<{ method: string; path: string; body: any }>;
  // Paths are matched by substring, newest handler wins.
  reply: (match: string, body: unknown, status?: number) => void;
}

export function fakeNotion(): FakeNotion {
  const requests: FakeNotion["requests"] = [];
  const replies: Array<{ match: string; body: unknown; status: number }> = [];
  const fetchStub = (url: string, init?: any) => {
    const path = String(url).replace("https://api.notion.com/v1", "");
    requests.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(init.body) : undefined,
    });
    const reply = [...replies].reverse().find((entry) => path.includes(entry.match));
    return Promise.resolve(
      new Response(JSON.stringify(reply?.body ?? {}), {
        status: reply?.status ?? 200,
      }),
    );
  };
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  return {
    requests,
    reply: (match, body, status = 200) => replies.push({ match, body, status }),
  };
}
