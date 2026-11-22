import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/platform/database.js";
import { AgentFilesystem } from "../src/platform/filesystem.js";
import { AgentRegistry, type Agent } from "../src/platform/identity.js";
import { Supervisor } from "../src/platform/supervisor.js";
import probe from "./fixtures/agents/probe.js";

describe("AgentFilesystem (platform-checked permissions)", () => {
  let root: string;
  let db: Db;
  let fs: AgentFilesystem;
  let alice: Agent;
  let bob: Agent;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "agentfs-"));
    db = openDatabase(":memory:");
    const registry = new AgentRegistry(db);
    fs = new AgentFilesystem(db, registry, root);
    alice = registry.create("alice");
    bob = registry.create("bob");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const aliceFile = (name: string) => `agents/${alice.id}/${name}`;

  it("creates the base layout", () => {
    expect(fs.handle(alice.id, { op: "list", path: "~" })).toEqual([]);
    expect(() => fs.handle(alice.id, { op: "list", path: "shared" })).toThrow(/EACCES/);
  });

  it("owners have read/write on their private directory; others have nothing", () => {
    fs.handle(alice.id, { op: "write", path: "~/a.txt", content: "hi" });
    expect(fs.handle(alice.id, { op: "read", path: aliceFile("a.txt") })).toBe("hi");
    expect(fs.handle(alice.id, { op: "list", path: "~" })).toEqual(["a.txt"]);
    expect(() => fs.handle(bob.id, { op: "read", path: aliceFile("a.txt") })).toThrow(/EACCES.*no grant/);
    expect(() => fs.handle(bob.id, { op: "write", path: aliceFile("b.txt"), content: "x" })).toThrow(/EACCES/);
  });

  it("the shared area is closed until the platform grants access", () => {
    writeFileSync(join(root, "shared/documents/d.txt"), "doc");
    expect(() => fs.handle(alice.id, { op: "read", path: "shared/documents/d.txt" })).toThrow(/EACCES/);
    fs.grant(alice.id, "shared/documents", "read");
    expect(fs.handle(alice.id, { op: "read", path: "shared/documents/d.txt" })).toBe("doc");
    expect(() => fs.handle(alice.id, { op: "write", path: "shared/documents/e.txt", content: "" })).toThrow(/read-only/);
    expect(() => fs.handle(alice.id, { op: "read", path: "shared/artifacts/x" })).toThrow(/EACCES/);
  });

  it("a directory grant covers its subtree but not a sibling with the same prefix", () => {
    fs.grant(alice.id, "shared/documents", "write");
    fs.handle(alice.id, { op: "write", path: "shared/documents/deep/nested.txt", content: "ok" });
    expect(() => fs.handle(alice.id, { op: "write", path: "shared/documents2/x.txt", content: "" })).toThrow(/EACCES/);
  });

  it("the most specific grant wins", () => {
    fs.grant(alice.id, "shared/artifacts", "write");
    fs.grant(alice.id, "shared/artifacts/locked", "read");
    fs.handle(alice.id, { op: "write", path: "shared/artifacts/free.txt", content: "" });
    expect(() => fs.handle(alice.id, { op: "write", path: "shared/artifacts/locked/x.txt", content: "" })).toThrow(/read-only/);
  });

  it("an agent can share one file without exposing the rest of its directory", () => {
    fs.handle(alice.id, { op: "write", path: "~/report.txt", content: "R" });
    fs.handle(alice.id, { op: "write", path: "~/secret.txt", content: "S" });
    fs.handle(alice.id, { op: "grant", path: "~/report.txt", granteeAgentId: bob.id, access: "read" });

    expect(fs.handle(bob.id, { op: "read", path: aliceFile("report.txt") })).toBe("R");
    expect(() => fs.handle(bob.id, { op: "read", path: aliceFile("secret.txt") })).toThrow(/EACCES/);
    expect(() => fs.handle(bob.id, { op: "list", path: `agents/${alice.id}` })).toThrow(/EACCES/);
    expect(() => fs.handle(bob.id, { op: "write", path: aliceFile("report.txt"), content: "" })).toThrow(/read-only/);
  });

  it("only the owner can grant or revoke", () => {
    fs.handle(alice.id, { op: "write", path: "~/r.txt", content: "" });
    fs.handle(alice.id, { op: "grant", path: "~/r.txt", granteeAgentId: bob.id, access: "read" });
    expect(() =>
      fs.handle(bob.id, { op: "grant", path: aliceFile("r.txt"), granteeAgentId: bob.id, access: "write" }),
    ).toThrow(/only the owner/);
    expect(() => fs.handle(bob.id, { op: "grant", path: "shared/documents", granteeAgentId: bob.id, access: "write" })).toThrow(
      /only the owner/,
    );
    expect(() => fs.handle(bob.id, { op: "revoke", path: aliceFile("r.txt"), granteeAgentId: bob.id })).toThrow(/only the owner/);

    fs.handle(alice.id, { op: "revoke", path: "~/r.txt", granteeAgentId: bob.id });
    expect(() => fs.handle(bob.id, { op: "read", path: aliceFile("r.txt") })).toThrow(/EACCES/);
  });

  it("rejects absolute paths and paths that escape the root", () => {
    expect(() => fs.handle(alice.id, { op: "read", path: "/etc/passwd" })).toThrow(/absolute/);
    expect(() => fs.handle(alice.id, { op: "read", path: "../outside" })).toThrow(/escapes/);
    expect(() => fs.handle(alice.id, { op: "read", path: "~/../../../outside" })).toThrow(/escapes/);
    expect(() => fs.handle(alice.id, { op: "list", path: "." })).toThrow(/root/);
  });

  it("'..' is resolved before the permission check", () => {
    fs.handle(alice.id, { op: "write", path: "~/a.txt", content: "A" });
    expect(() => fs.handle(bob.id, { op: "read", path: `~/../${alice.id}/a.txt` })).toThrow(/no grant/);
  });

  it("refuses to follow symlinks planted inside an agent directory", () => {
    fs.handle(alice.id, { op: "write", path: "~/secret.txt", content: "S" });
    mkdirSync(join(root, "agents", bob.id), { recursive: true });
    symlinkSync(join(root, "agents", alice.id), join(root, "agents", bob.id, "peek"));
    expect(() => fs.handle(bob.id, { op: "read", path: "~/peek/secret.txt" })).toThrow(/symlinks/);
  });

  it("records every decision in the audit log", () => {
    fs.handle(alice.id, { op: "write", path: "~/a.txt", content: "" });
    expect(() => fs.handle(bob.id, { op: "read", path: aliceFile("a.txt") })).toThrow();
    expect(() => fs.handle(bob.id, { op: "read", path: "/etc/passwd" })).toThrow();
    expect(fs.auditLog().map((e) => [e.agentId, e.op, e.allowed])).toEqual([
      [alice.id, "write", true],
      [bob.id, "read", false],
      [bob.id, "read", false],
    ]);
  });
});

describe("ctx.fs: filesystem over IPC", () => {
  let root: string;
  let db: Db;
  let supervisor: Supervisor;
  let fs: AgentFilesystem;
  let alice: Agent;
  let bob: Agent;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "agentfs-ipc-"));
    db = openDatabase(":memory:");
    const registry = new AgentRegistry(db);
    fs = new AgentFilesystem(db, registry, root);
    supervisor = new Supervisor(db, registry, { defaultModule: probe.moduleUrl, fsHandler: (id, req) => fs.handle(id, req) });
    alice = registry.create("alice");
    bob = registry.create("bob");
    await supervisor.start(alice.id);
    await supervisor.start(bob.id);
  });
  afterEach(async () => {
    await supervisor.stopAll();
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const as = (agent: Agent, task: string, input: unknown) => supervisor.sendTask(agent.id, task, input);

  it("write / read / list in the agent's own directory", async () => {
    expect(await as(alice, "write", { path: "~/notes/a.txt", content: "hello" })).toEqual({ path: `agents/${alice.id}/notes/a.txt`, bytes: 5 });
    expect(await as(alice, "read", { path: "~/notes/a.txt" })).toBe("hello");
    expect(await as(alice, "list", { path: "~/notes" })).toEqual(["a.txt"]);
  });

  it("requests are authorized as the agent bound to the IPC channel", async () => {
    writeFileSync(join(root, "shared/documents/in.txt"), "hello");
    fs.grant(alice.id, "shared/documents/in.txt", "read");
    expect(await as(alice, "read", { path: "shared/documents/in.txt" })).toBe("hello");
    // Same request from bob's runtime is evaluated as bob.
    await expect(as(bob, "read", { path: "shared/documents/in.txt" })).rejects.toThrow(/EACCES/);
  });

  it("share and revoke a file the agent owns", async () => {
    await as(alice, "write", { path: "~/report.txt", content: "numbers" });
    const report = `agents/${alice.id}/report.txt`;
    await expect(as(bob, "read", { path: report })).rejects.toThrow(/EACCES/);

    await as(alice, "share", { path: "~/report.txt", agentId: bob.id, access: "read" });
    expect(await as(bob, "read", { path: report })).toBe("numbers");
    await expect(as(bob, "write", { path: report, content: "x" })).rejects.toThrow(/EACCES/);

    await as(alice, "revoke", { path: "~/report.txt", agentId: bob.id });
    await expect(as(bob, "read", { path: report })).rejects.toThrow(/EACCES/);
  });

  it("a denial is an FsDeniedError inside the handler, and non-retryable outside it", async () => {
    expect(await as(bob, "tryRead", { path: `agents/${alice.id}/x` })).toMatchObject({
      ok: false,
      denied: true,
      retryable: false,
      message: expect.stringMatching(/^EACCES: read/),
    });
    await expect(as(bob, "read", { path: `agents/${alice.id}/x` })).rejects.toMatchObject({ retryable: false });
  });

  it("only the owner can share", async () => {
    await expect(as(bob, "share", { path: `agents/${alice.id}/x`, agentId: bob.id, access: "read" })).rejects.toThrow(
      /only the owner can share/,
    );
  });
});
