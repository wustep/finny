import { afterEach, expect, test, vi } from "vitest";
import { notionFetch } from "./notionApi";

// The spacing notionFetch enforces (MIN_REQUEST_INTERVAL_MS), mirrored so the
// assertions below say what they are checking.
const MIN_REQUEST_INTERVAL_MS = 340;

function ok(body: unknown = {}) {
  return new Response(JSON.stringify(body), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("requests are spaced out instead of racing Notion's rate limit", async () => {
  const startedAt: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      startedAt.push(Date.now());
      return Promise.resolve(ok());
    }),
  );

  await Promise.all([
    notionFetch("token", "/pages/1"),
    notionFetch("token", "/pages/2"),
    notionFetch("token", "/pages/3"),
  ]);

  expect(startedAt).toHaveLength(3);
  for (let index = 1; index < startedAt.length; index++) {
    // Timers fire no earlier than asked but can fire late, so this is a floor
    // with a millisecond of slack for the clock.
    expect(startedAt[index] - startedAt[index - 1]).toBeGreaterThanOrEqual(
      MIN_REQUEST_INTERVAL_MS - 1,
    );
  }
});

test("a rate limit is retried after the interval Notion asks for", async () => {
  const attempts: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      attempts.push(Date.now());
      return Promise.resolve(
        attempts.length === 1
          ? new Response("{}", { status: 429, headers: { "retry-after": "1" } })
          : ok({ id: "page-1" }),
      );
    }),
  );

  const result = await notionFetch("token", "/pages", { method: "POST" });

  expect(result).toEqual({ id: "page-1" });
  expect(attempts).toHaveLength(2);
  expect(attempts[1] - attempts[0]).toBeGreaterThanOrEqual(1000);
});

test("an error Notion will not take back is thrown with its message", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "Could not find database" }), {
          status: 404,
        }),
      ),
    ),
  );

  await expect(notionFetch("token", "/databases/gone/query")).rejects.toThrow(
    /404.*Could not find database/,
  );
});
