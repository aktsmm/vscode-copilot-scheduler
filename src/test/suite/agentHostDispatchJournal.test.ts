import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import {
  withAgentHostDispatchJournal,
  type AgentHostDispatchRecord,
} from "../../agentHostDispatchJournal";

suite("Agent Host dispatch journal", () => {
  let directory: string;
  const ref = { sessionUri: "ahp-session:/one", chatUri: "ahp-chat:/one" };
  const chatId = createHash("sha256").update(ref.chatUri).digest("hex");
  const record = (id: string): AgentHostDispatchRecord => ({
    id,
    owner: "owner",
    hostIdentity: "a".repeat(64),
    ref,
    messageId: `message-${id}`,
  });

  setup(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-dispatch-journal-"));
  });

  teardown(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  test("persists dispatch intent for another reader without storing the prompt", async () => {
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      journal.records.push(record("first"));
      await journal.save();
    });
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      assert.deepStrictEqual(journal.records, [record("first")]);
      journal.records[0].turnId = "turn";
      await journal.save();
    });
    const file = path.join(directory, "agent-host-dispatches", `${chatId}.json`);
    const raw = fs.readFileSync(file, "utf8");
    assert.ok(!raw.includes("prompt"));
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      assert.strictEqual(journal.records[0].turnId, "turn");
    });
  });

  test("serializes concurrent writers without dropping either intent", async () => {
    await Promise.all(["first", "second"].map((id) =>
      withAgentHostDispatchJournal(directory, chatId, async (journal) => {
        journal.records.push(record(id));
        await journal.save();
      }),
    ));
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      assert.deepStrictEqual(journal.records.map((entry) => entry.id).sort(), ["first", "second"]);
    });
  });

  test("removes its files once the last record is gone and still protects a later record", async () => {
    const base = path.join(directory, "agent-host-dispatches", chatId);
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      journal.records.push(record("first"));
      await journal.save();
    });
    assert.ok(fs.existsSync(`${base}.json`) && fs.existsSync(`${base}.initialized`));
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      journal.records.splice(0);
      await journal.save();
    });
    assert.ok(!fs.existsSync(`${base}.json`) && !fs.existsSync(`${base}.initialized`));
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      assert.strictEqual(journal.records.length, 0);
      journal.records.push(record("second"));
      await journal.save();
    });
    fs.unlinkSync(`${base}.json`);
    await assert.rejects(withAgentHostDispatchJournal(directory, chatId, async () => undefined));
  });

  test("fails closed when initialized state is missing or malformed", async () => {
    await withAgentHostDispatchJournal(directory, chatId, async (journal) => {
      journal.records.push(record("first"));
      await journal.save();
    });
    const file = path.join(directory, "agent-host-dispatches", `${chatId}.json`);
    fs.unlinkSync(file);
    await assert.rejects(withAgentHostDispatchJournal(directory, chatId, async () => undefined));
    fs.writeFileSync(file, "{broken", "utf8");
    await assert.rejects(withAgentHostDispatchJournal(directory, chatId, async () => undefined));
    fs.writeFileSync(file, JSON.stringify([{ ...record("first"), ref: { ...ref, chatUri: "ahp-chat:/other" } }]), "utf8");
    await assert.rejects(withAgentHostDispatchJournal(directory, chatId, async () => undefined));
  });
});
