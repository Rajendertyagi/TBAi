/**
 * AI-controlled scheduler tool handlers (services/scheduler/schedulerTools.ts).
 *
 * Exercises the six handlers the model drives through the native toolkit:
 * create / list / get / update / delete / run-now. They reuse the SAME
 * schedulerStore + scheduler coordinator as the REST API, so these tests also
 * guard against the two entry points drifting. Real LLM execution is avoided
 * (run-now on a missing job only checks the not-found branch).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { schedulerStore } from "../../src/services/scheduler/schedulerStore";
import { clearAllTimers } from "../../src/services/scheduler/scheduler";
import { schedulerToolHandlers } from "../../src/services/scheduler/schedulerTools";
import { getWorkspaceDir } from "../../src/services/tools";

const PROVIDER_ID = "p1";
const MODEL_ID = "m1";

function seedProvider() {
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, 1, ?, ?)`,
    [PROVIDER_ID, "test-ollama", MODEL_ID, Date.now(), Date.now()],
  );
  void registry.loadFromDb(db);
}

function baseCreateArgs(overrides: Record<string, unknown> = {}) {
  return {
    name: "ai job",
    scheduleType: "once",
    execAt: Date.now() + 3600_000,
    timezone: "UTC",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    workspacePath: getWorkspaceDir(),
    prompt: "do the thing",
    ...overrides,
  };
}

describe("scheduler AI tools", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    seedProvider();
  });
  afterEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    clearAllTimers();
  });

  it("create returns a job summary and persists it", async () => {
    const res = (await schedulerToolHandlers.create(
      baseCreateArgs(),
    )) as { created: boolean; job: { id: string; name: string } };
    expect(res.created).toBe(true);
    expect(res.job.id).toBeTruthy();
    expect(res.job.name).toBe("ai job");
    expect(schedulerStore.get(res.job.id)).not.toBeNull();
  });

  it("create validates the schedule (cron needs an expression)", async () => {
    await expect(
      schedulerToolHandlers.create(
        baseCreateArgs({ scheduleType: "cron", cronExpression: null }),
      ),
    ).rejects.toThrow(/cron expression/i);
  });

  it("create validates the provider exists", async () => {
    await expect(
      schedulerToolHandlers.create(baseCreateArgs({ providerId: "ghost" })),
    ).rejects.toThrow(/does not exist/i);
  });

  it("list returns all jobs", async () => {
    await schedulerToolHandlers.create(baseCreateArgs({ name: "a" }));
    await schedulerToolHandlers.create(baseCreateArgs({ name: "b" }));
    const res = (await schedulerToolHandlers.list()) as {
      count: number;
      jobs: Array<{ name: string }>;
    };
    expect(res.count).toBe(2);
    expect(res.jobs.map((j) => j.name).sort()).toEqual(["a", "b"]);
  });

  it("get returns full detail including the prompt", async () => {
    const created = (await schedulerToolHandlers.create(
      baseCreateArgs(),
    )) as { job: { id: string } };
    const res = (await schedulerToolHandlers.get({
      id: created.job.id,
    })) as { job: { prompt: string } };
    expect(res.job.prompt).toBe("do the thing");
  });

  it("get throws on a missing job", async () => {
    await expect(
      schedulerToolHandlers.get({ id: "nope" }),
    ).rejects.toThrow(/not found/i);
  });

  it("update changes fields and reschedules", async () => {
    const created = (await schedulerToolHandlers.create(
      baseCreateArgs(),
    )) as { job: { id: string } };
    const res = (await schedulerToolHandlers.update({
      id: created.job.id,
      name: "renamed",
    })) as { updated: boolean; job: { name: string } };
    expect(res.updated).toBe(true);
    expect(res.job.name).toBe("renamed");
    expect(schedulerStore.get(created.job.id)?.name).toBe("renamed");
  });

  it("delete soft-deletes (hidden, history retained)", async () => {
    const created = (await schedulerToolHandlers.create(
      baseCreateArgs(),
    )) as { job: { id: string } };
    const res = (await schedulerToolHandlers.delete({
      id: created.job.id,
    })) as { deleted: boolean };
    expect(res.deleted).toBe(true);
    // Soft-deleted: not in the active list, but run history remains queryable.
    expect(schedulerStore.list().some((j) => j.id === created.job.id)).toBe(
      false,
    );
    expect(schedulerStore.get(created.job.id)?.status).toBe("deleted");
  });

  it("run-now on a missing job reports not found", async () => {
    await expect(
      schedulerToolHandlers.runNow({ id: "nope" }),
    ).rejects.toThrow(/not found/i);
  });
});
