import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db";
import app from "@/routes/index.ts";
import serverRoutes from "@/routes/server.ts";
import {
  bindBootPort,
  getActivePort,
  getActiveServer,
  getInstanceId,
  initListenerFetch,
} from "@/services/server-listener.ts";
import {
  getPersistedPort,
  isPortEnvLocked,
  resolveConfiguredPort,
  resolveDataDir,
} from "@/services/server-port.ts";

/**
 * The configurable web port, end to end.
 *
 * The port is the USER's choice (Settings → Web server), and the port is
 * also the origin TBAi's own pages are served from — so a policy that named
 * a fixed port, or a flow that assumed the default one, breaks the first
 * time the user moves off 3000.
 *
 * These tests drive the real routes against a real listener:
 * `POST /api/server/restart` really rebinds a socket, and the readiness
 * probe really fetches the new origin. Nothing here duplicates the
 * implementation's assumptions.
 */

const PORT_KEY = "server.port";

/**
 * Reserves `count` currently-free ports and releases them.
 *
 * The ports are deliberately NOT fixed numbers. A fixed port can already be
 * held by anything on the machine — most importantly a TBAi instance the
 * maintainer is running outside this repository — and a test must never
 * compete with the real application for a socket. Asking the OS for port 0
 * returns a port that is free at allocation time.
 *
 * Every reservation is held until all the ports are known: asking one at a
 * time could hand back the same port twice once the previous reservation is
 * closed.
 */
function allocateFreePorts(count: number): readonly number[] {
  const reservations = Array.from({ length: count }, () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("reserved") }),
  );
  const ports = reservations.map((server) => server.port);
  for (const server of reservations) server.stop(true);
  return ports;
}

const PORTS = allocateFreePorts(4);
/** The port this file's listener binds. */
const FIRST_PORT = PORTS[0];
/** The port the user picks, and restarts onto. */
const SECOND_PORT = PORTS[1];
/** A third port, for the restart-after-save case. */
const THIRD_PORT = PORTS[2];
/** A port the suite occupies itself, to make a restart conflict. */
const OCCUPIED_PORT = PORTS[3];

const serverApp = new Hono<{ Variables: { requestId: string } }>();
serverApp.route("/api/server", serverRoutes);

function clearPersistedPort(): void {
  db.run("DELETE FROM app_settings WHERE key = ?", [PORT_KEY]);
}

function setEnvPort(value: string | undefined): void {
  if (value === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = value;
  }
}

/** The port mirror the Tauri shell reads at startup. */
function mirrorPort(): number | null {
  const file = join(resolveDataDir(), "port");
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8").trim();
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

beforeAll(() => {
  initListenerFetch((request) => app.fetch(request));
  bindBootPort(FIRST_PORT);
});

afterAll(() => {
  getActiveServer()?.stop();
});

beforeEach(() => {
  clearPersistedPort();
  setEnvPort(undefined);
});

describe("choosing a port in Settings", () => {
  it("saves a port without restarting: the live listener keeps serving", async () => {
    const before = getActivePort();

    const response = await serverApp.request("http://localhost/api/server/port", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: SECOND_PORT }),
    });

    expect(response.status).toBe(200);
    expect(((await response.json()) as { configuredPort: number }).configuredPort).toBe(
      SECOND_PORT,
    );
    // Configured for the next boot; the running server has NOT moved.
    expect(getPersistedPort()).toBe(SECOND_PORT);
    expect(getActivePort()).toBe(before);
    // The mirror follows the configured value, so the shell agrees on the
    // next launch.
    expect(mirrorPort()).toBe(SECOND_PORT);
  });

  it("restarts onto the chosen port, and the new origin answers", async () => {
    const before = getActivePort();
    expect(before).not.toBe(SECOND_PORT);

    const response = await serverApp.request("http://localhost/api/server/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: SECOND_PORT }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { activePort: number; restarted: boolean };
    expect(body.activePort).toBe(SECOND_PORT);
    expect(body.restarted).toBe(true);
    expect(getActivePort()).toBe(SECOND_PORT);

    // The new origin really serves the app.
    const probe = await fetch(`http://127.0.0.1:${SECOND_PORT}/healthz`);
    expect(probe.status).toBe(200);

    // And the chosen port is now the persisted, configured one.
    expect(getPersistedPort()).toBe(SECOND_PORT);
    expect(resolveConfiguredPort().port).toBe(SECOND_PORT);
    expect(mirrorPort()).toBe(SECOND_PORT);
  });

  it("reports the active and the configured port separately", async () => {
    await serverApp.request("http://localhost/api/server/port", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: THIRD_PORT }),
    });

    const response = await serverApp.request("http://localhost/api/server");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      activePort: number;
      configuredPort: number;
      persistedPort: number | null;
      envLocked: boolean;
    };
    // The live listener is where it is; the configured one is where the next
    // boot lands. The page shows both, and must never claim the requested
    // port is live before the restart.
    expect(body.activePort).toBe(getActivePort());
    expect(body.configuredPort).toBe(THIRD_PORT);
    expect(body.persistedPort).toBe(THIRD_PORT);
    expect(body.envLocked).toBe(false);
  });

  it("refuses an invalid port", async () => {
    for (const port of [0, 65536, -1]) {
      const response = await serverApp.request("http://localhost/api/server/port", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
      expect(response.status).toBe(400);
    }
    expect(getPersistedPort()).toBeNull();
  });
});

describe("an occupied port", () => {
  it("refuses the restart and keeps the current listener serving", async () => {
    // Occupy a port with a real listener, then ask TBAi to move onto it.
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: OCCUPIED_PORT,
      fetch: () => new Response("squatter"),
    });
    const activeBefore = getActivePort();
    try {
      const response = await serverApp.request("http://localhost/api/server/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: OCCUPIED_PORT }),
      });

      // The refusal is honest: the requested port was NOT applied.
      expect(response.status).toBe(409);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain(String(OCCUPIED_PORT));
      // The working listener is untouched and still answers.
      expect(getActivePort()).toBe(activeBefore);
      const probe = await fetch(`http://127.0.0.1:${activeBefore}/healthz`);
      expect(probe.status).toBe(200);
      // And the requested port was not recorded as the configured one.
      expect(getPersistedPort()).toBeNull();
    } finally {
      squatter.stop(true);
    }
  });

  it("reports an occupied port as unavailable when it is checked", async () => {
    const squatter = Bun.serve({
      hostname: "127.0.0.1",
      port: OCCUPIED_PORT,
      fetch: () => new Response("squatter"),
    });
    try {
      const response = await serverApp.request("http://localhost/api/server/check-port", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: OCCUPIED_PORT }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        port: OCCUPIED_PORT,
        available: false,
        reason: "in_use",
      });
    } finally {
      squatter.stop(true);
    }
  });
});

describe("a port change while the application is running", () => {
  it("keeps the same instance identity and writes the new port to the mirror", async () => {
    const instanceBefore = getInstanceId();

    const response = await serverApp.request("http://localhost/api/server/restart", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: THIRD_PORT }),
    });
    expect(response.status).toBe(200);

    // The same server answered: the shell's ownership proof (the instance id)
    // is unchanged, so the shell can keep driving the app it launched.
    expect(getInstanceId()).toBe(instanceBefore);
    const instance = await fetch(`http://127.0.0.1:${THIRD_PORT}/api/server/instance`);
    expect(instance.status).toBe(200);
    expect(((await instance.json()) as { instanceId: string }).instanceId).toBe(instanceBefore);

    // The shell's mirror follows the move, so a relaunch finds the new port.
    expect(mirrorPort()).toBe(THIRD_PORT);
  });
});

describe("the port across a restart of the application", () => {
  it("persists the chosen port, and the next launch uses it", async () => {
    await serverApp.request("http://localhost/api/server/port", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port: SECOND_PORT }),
    });

    // A fresh process reads the same database and the same mirror.
    expect(resolveConfiguredPort().port).toBe(SECOND_PORT);
    expect(mirrorPort()).toBe(SECOND_PORT);
    expect(getPersistedPort()).toBe(SECOND_PORT);
  });
});

describe("the PORT environment override", () => {
  it("locks the port in Settings and refuses to change it", async () => {
    setEnvPort("45999");
    try {
      expect(isPortEnvLocked()).toBe(true);
      // The environment wins over the persisted value.
      expect(resolveConfiguredPort().port).toBe(45999);
      expect(resolveConfiguredPort().envLocked).toBe(true);

      const save = await serverApp.request("http://localhost/api/server/port", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: SECOND_PORT }),
      });
      expect(save.status).toBe(409);

      const restart = await serverApp.request("http://localhost/api/server/restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: SECOND_PORT }),
      });
      expect(restart.status).toBe(409);

      // The page is told the port is locked, so it disables the control.
      const identity = await serverApp.request("http://localhost/api/server");
      expect(((await identity.json()) as { envLocked: boolean }).envLocked).toBe(true);

      // Nothing moved and nothing was written.
      expect(getActivePort()).not.toBe(SECOND_PORT);
      expect(getPersistedPort()).toBeNull();
    } finally {
      setEnvPort(undefined);
    }
  });
});
