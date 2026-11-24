// @vitest-environment happy-dom
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocument } from "./useDocument";

const mocks = vi.hoisted(() => ({
  invoke:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
  preferences: { editorAutoSave: false, editorAutoSaveDelay: 100 },
  workspace: { kind: "local" },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (select: (state: typeof mocks.preferences) => unknown) =>
    select(mocks.preferences),
}));
vi.mock("@/modules/workspace", () => ({
  currentWorkspaceEnv: () => mocks.workspace,
}));

type Deferred = ReturnType<typeof deferred>;
function deferred() {
  let resolve!: (value?: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Request = Deferred & { args: Record<string, unknown> };
let reads: Request[];
let writes: Request[];
const roots = new Set<Root>();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.preferences.editorAutoSave = false;
  mocks.workspace = { kind: "local" };
  reads = [];
  writes = [];
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((command, args = {}) => {
    const request = { ...deferred(), args };
    if (command === "fs_read_file") reads.push(request);
    else if (command === "fs_write_file") writes.push(request);
    else throw new Error(`Unexpected IPC command: ${command}`);
    return request.promise;
  });
});
afterEach(async () => {
  await act(async () => {
    for (const root of roots) root.unmount();
    roots.clear();
    for (const write of writes) write.resolve();
  });
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mount(path = "/a.txt", strict = false) {
  let current!: ReturnType<typeof useDocument>;
  let renderCount = 0;
  const dirtyChanged = vi.fn();
  function Harness({ file }: { file: string }) {
    renderCount += 1;
    current = useDocument({ path: file, onDirtyChange: dirtyChanged });
    return null;
  }
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  roots.add(root);
  const render = async (file: string) => {
    await act(async () => {
      const child = createElement(Harness, { file });
      root.render(strict ? createElement(StrictMode, null, child) : child);
    });
  };
  await render(path);
  return {
    get current() {
      return current;
    },
    get renderCount() {
      return renderCount;
    },
    dirtyChanged,
    render,
    unmount: () =>
      act(() => {
        root.unmount();
        roots.delete(root);
      }),
  };
}
type Harness = Awaited<ReturnType<typeof mount>>;
async function respond(request: Request, content: string) {
  await act(async () => {
    request.resolve({ kind: "text", content, size: content.length });
  });
}
async function finish(request: Request) {
  await act(async () => {
    request.resolve();
  });
}
async function fail(request: Request) {
  await act(async () => {
    request.reject(new Error("I/O failed"));
  });
}
async function open() {
  const h = await mount();
  await respond(reads[0], "original");
  return h;
}
function edit(h: Harness, content: string) {
  act(() => h.current.onChange(content));
}
async function save(h: Harness) {
  let result!: Promise<void>;
  await act(async () => {
    result = h.current.save();
  });
  // A wrapper prevents async helpers from awaiting the outstanding write.
  return { result };
}
function reload(h: Harness) {
  let accepted = false;
  act(() => {
    accepted = h.current.reload();
  });
  return accepted;
}
function expectContent(h: Harness, content: string) {
  expect(h.current.doc).toMatchObject({ status: "ready", content });
}

describe("useDocument persistence", () => {
  it("loads text and does not write a clean document", async () => {
    const h = await open();
    expectContent(h, "original");
    expect(h.current.dirty).toBe(false);
    await h.current.save();
    expect(writes).toHaveLength(0);
  });

  it("marks only the successfully written buffer as saved", async () => {
    const h = await open();
    edit(h, "changed");
    const { result } = await save(h);
    expect(writes[0].args).toMatchObject({
      path: "/a.txt",
      content: "changed",
      source: "editor",
    });
    expect(h.current.dirty).toBe(true);
    await finish(writes[0]);
    await result;
    expect(h.current.dirty).toBe(false);
    // Keystrokes and saves must not reset CodeMirror's input value or undo.
    expectContent(h, "original");
  });

  it("keeps edits made during a save dirty", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    edit(h, "newer");
    await finish(writes[0]);
    await first.result;
    expect(h.current.dirty).toBe(true);
    const second = await save(h);
    expect(writes[1].args.content).toBe("newer");
    await finish(writes[1]);
    await second.result;
    expect(h.current.dirty).toBe(false);
  });

  it("protects undo to the original while another buffer is being written", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    edit(h, "original");
    expect(h.current.dirty).toBe(true);
    expect(reload(h)).toBe(false);
    const second = await save(h);
    await finish(writes[0]);
    await first.result;
    expect(writes[1].args.content).toBe("original");
    await finish(writes[1]);
    await second.result;
    expect(h.current.dirty).toBe(false);
  });

  it("serializes consecutive snapshots so the latest save reaches disk last", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    edit(h, "second");
    const second = await save(h);
    edit(h, "third");
    const third = await save(h);
    expect(writes.map((w) => w.args.content)).toEqual(["first"]);
    await finish(writes[0]);
    await first.result;
    expect(writes.map((w) => w.args.content)).toEqual(["first", "second"]);
    expect(h.current.dirty).toBe(true);
    await finish(writes[1]);
    await second.result;
    expect(writes[2].args.content).toBe("third");
    await finish(writes[2]);
    await third.result;
    expect(h.current.dirty).toBe(false);
  });

  it("saves the latest input before React rerenders", async () => {
    const h = await open();
    let pending!: Promise<void>;
    await act(async () => {
      h.current.onChange("immediate");
      pending = h.current.save();
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].args.content).toBe("immediate");
    await finish(writes[0]);
    await pending;
  });

  it("retains the editable buffer and permits retry after a write failure", async () => {
    const h = await open();
    edit(h, "changed");
    const first = await save(h);
    const rejected = expect(first.result).rejects.toThrow("I/O failed");
    await fail(writes[0]);
    await rejected;
    expectContent(h, "original");
    expect(h.current.dirty).toBe(true);
    const retry = await save(h);
    await finish(writes[1]);
    await retry.result;
    expect(h.current.dirty).toBe(false);
  });

  it("continues the write queue after a failed save", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    const rejected = expect(first.result).rejects.toThrow("I/O failed");
    edit(h, "second");
    const second = await save(h);
    await fail(writes[0]);
    await rejected;
    expect(writes[1].args.content).toBe("second");
    await finish(writes[1]);
    await second.result;
    expect(h.current.dirty).toBe(false);
  });

  it("blocks a reload immediately after input, before effects run", async () => {
    const h = await open();
    let accepted = true;
    act(() => {
      h.current.onChange("changed");
      accepted = h.current.reload();
    });
    expect(accepted).toBe(false);
    expect(reads).toHaveLength(1);
  });

  it("does not apply a reload after input starts", async () => {
    const h = await open();
    expect(reload(h)).toBe(true);
    edit(h, "mine");
    await respond(reads[1], "external");
    expectContent(h, "original");
    expect(h.current.dirty).toBe(true);
    const pending = await save(h);
    expect(writes[0].args.content).toBe("mine");
    await finish(writes[0]);
    await pending.result;
  });

  it("invalidates a pending reload even if edits are undone", async () => {
    const h = await open();
    reload(h);
    edit(h, "mine");
    edit(h, "original");
    await respond(reads[1], "external");
    expectContent(h, "original");
    expect(h.current.dirty).toBe(false);
  });

  it("accepts only the latest overlapping reload", async () => {
    const h = await open();
    reload(h);
    reload(h);
    await respond(reads[2], "newest");
    await respond(reads[1], "obsolete");
    expectContent(h, "newest");
  });

  it("ignores a stale reload failure after a newer reload succeeds", async () => {
    const h = await open();
    reload(h);
    reload(h);
    await respond(reads[2], "newest");
    await fail(reads[1]);
    expectContent(h, "newest");
  });

  it("preserves an editable document on reload failure", async () => {
    const h = await open();
    reload(h);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await fail(reads[1]);
    expect(log).toHaveBeenCalledWith("[editor reload]", expect.any(Error));
    expectContent(h, "original");
    edit(h, "still editable");
    expect(h.current.dirty).toBe(true);
  });

  it("ignores reload failures after input starts", async () => {
    const h = await open();
    reload(h);
    edit(h, "mine");
    await fail(reads[1]);
    expectContent(h, "original");
    expect(h.current.dirty).toBe(true);
  });

  it("keeps duplicate disk notifications from resetting editor content", async () => {
    const h = await open();
    const originalState = h.current.doc;
    reload(h);
    await respond(reads[1], "original");
    expect(h.current.doc).toBe(originalState);
  });

  it("does not let old reloads mutate a new path, including A-B-A", async () => {
    const h = await open();
    reload(h);
    await h.render("/b.txt");
    await respond(reads[2], "B");
    await h.render("/a.txt");
    await respond(reads[3], "fresh A");
    await respond(reads[1], "obsolete A");
    expectContent(h, "fresh A");
  });

  it("does not let an old save clear dirty state for a new path", async () => {
    const h = await open();
    edit(h, "A edit");
    const pending = await save(h);
    await h.render("/b.txt");
    await respond(reads[1], "B");
    edit(h, "B edit");
    await finish(writes[0]);
    await pending.result;
    expectContent(h, "B");
    expect(h.current.dirty).toBe(true);
  });

  it("does not run queued writes after their document is disposed", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    edit(h, "queued");
    const second = await save(h);
    h.unmount();
    expect(writes).toHaveLength(1);
    await finish(writes[0]);
    await Promise.all([first.result, second.result]);
    expect(writes).toHaveLength(1);
  });

  it("binds writes to the workspace from which the document was read", async () => {
    const h = await open();
    const loadedWorkspace = reads[0].args.workspace;
    mocks.workspace = { kind: "other" };
    edit(h, "changed");
    const pending = await save(h);
    expect(writes[0].args.workspace).toEqual(loadedWorkspace);
    await finish(writes[0]);
    await pending.result;
  });

  it("ignores obsolete initial loads under StrictMode", async () => {
    const h = await mount("/a.txt", true);
    expect(reads).toHaveLength(2);
    await respond(reads[1], "current");
    await respond(reads[0], "obsolete");
    expectContent(h, "current");
  });

  it("reports initial read errors and supports retry", async () => {
    const h = await mount();
    await fail(reads[0]);
    expect(h.current.doc.status).toBe("error");
    reload(h);
    await respond(reads[1], "recovered");
    expectContent(h, "recovered");
  });

  it.each([
    { kind: "binary", size: 12 },
    { kind: "toolarge", size: 30, limit: 20 },
  ])("does not save non-text documents ($kind)", async (response) => {
    const h = await mount();
    await act(async () => {
      reads[0].resolve(response);
    });
    expect(h.current.doc.status).toBe(response.kind);
    edit(h, "accidental callback");
    const pending = await save(h);
    expect(writes).toHaveLength(0);
    await pending.result;
  });

  it("debounces autosave and cancels a redundant timer on manual save", async () => {
    vi.useFakeTimers();
    mocks.preferences.editorAutoSave = true;
    const h = await open();
    edit(h, "first");
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    edit(h, "second");
    await act(async () => {
      vi.advanceTimersByTime(60);
    });
    expect(writes).toHaveLength(0);
    const pending = await save(h);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(writes).toHaveLength(1);
    expect(writes[0].args.content).toBe("second");
    await finish(writes[0]);
    await pending.result;
  });

  it("autosaves an undo made during an in-flight autosave", async () => {
    vi.useFakeTimers();
    mocks.preferences.editorAutoSave = true;
    const h = await open();
    edit(h, "first");
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    edit(h, "original");
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(writes).toHaveLength(1);
    await finish(writes[0]);
    expect(writes).toHaveLength(2);
    expect(writes[1].args.content).toBe("original");
    await finish(writes[1]);
    expect(h.current.dirty).toBe(false);
  });

  it("cancels autosave on path changes and unmount", async () => {
    vi.useFakeTimers();
    mocks.preferences.editorAutoSave = true;
    const h = await open();
    edit(h, "A edit");
    await h.render("/b.txt");
    await respond(reads[1], "B");
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(writes).toHaveLength(0);
    edit(h, "B edit");
    h.unmount();
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(writes).toHaveLength(0);
  });

  it("waits for an old write before reading a reopened A-B-A document", async () => {
    const h = await open();
    edit(h, "pending A");
    const pending = await save(h);
    await h.render("/b.txt");
    await respond(reads[1], "B");
    await h.render("/a.txt");
    expect(h.current.doc.status).toBe("loading");
    expect(reads).toHaveLength(2);
    await finish(writes[0]);
    await pending.result;
    expect(reads).toHaveLength(3);
    await respond(reads[2], "pending A");
    expectContent(h, "pending A");
    expect(h.current.dirty).toBe(false);
  });

  it("waits for a previous editor's write when the file is closed and reopened", async () => {
    const first = await open();
    edit(first, "pending write");
    const pending = await save(first);
    first.unmount();
    const reopened = await mount();
    expect(reads).toHaveLength(1);
    await finish(writes[0]);
    await pending.result;
    await respond(reads[1], "pending write");
    expectContent(reopened, "pending write");
  });

  it("does not block the same path in a different workspace", async () => {
    const first = await open();
    edit(first, "pending local write");
    const pending = await save(first);
    mocks.workspace = { kind: "other" };
    const other = await mount();
    expect(reads).toHaveLength(2);
    await respond(reads[1], "other workspace");
    expectContent(other, "other workspace");
    await finish(writes[0]);
    await pending.result;
  });

  it("does not write an identical snapshot twice", async () => {
    const h = await open();
    edit(h, "changed");
    const first = await save(h);
    const second = await save(h);
    await finish(writes[0]);
    await Promise.all([first.result, second.result]);
    expect(writes).toHaveLength(1);
    expect(h.current.dirty).toBe(false);
  });

  it("does not clear dirty while a queued snapshot could overwrite the buffer", async () => {
    const h = await open();
    edit(h, "first");
    const first = await save(h);
    edit(h, "second");
    const second = await save(h);
    edit(h, "first");
    await finish(writes[0]);
    await first.result;
    expect(h.current.dirty).toBe(true);
    expect(reload(h)).toBe(false);
    await finish(writes[1]);
    await second.result;
    expect(h.current.dirty).toBe(true);
    const third = await save(h);
    expect(writes[2].args.content).toBe("first");
    await finish(writes[2]);
    await third.result;
    expect(h.current.dirty).toBe(false);
  });

  it("does not invoke disposed editor callbacks or publish stale responses", async () => {
    const h = await open();
    reload(h);
    const stale = h.current;
    h.unmount();
    const notifications = h.dirtyChanged.mock.calls.length;
    await respond(reads[1], "obsolete");
    expect(h.dirtyChanged).toHaveBeenCalledTimes(notifications);
    expect(stale.reload()).toBe(false);
    stale.onChange("obsolete input");
    await stale.save();
    expect(reads).toHaveLength(2);
    expect(writes).toHaveLength(0);
  });

  it("reports dirty transitions without repeated notifications for each keystroke", async () => {
    const h = await open();
    expect(h.dirtyChanged.mock.calls).toEqual([[false]]);
    edit(h, "one");
    edit(h, "two");
    expect(h.dirtyChanged.mock.calls).toEqual([[false], [true]]);
    const pending = await save(h);
    await finish(writes[0]);
    await pending.result;
    expect(h.dirtyChanged.mock.calls).toEqual([[false], [true], [false]]);
  });

  it("retains dirty content after autosave failure and allows manual retry", async () => {
    vi.useFakeTimers();
    mocks.preferences.editorAutoSave = true;
    const h = await open();
    edit(h, "changed");
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await fail(writes[0]);
    expect(log).toHaveBeenCalledWith("[autosave]", expect.any(Error));
    expect(h.current.dirty).toBe(true);
    expectContent(h, "original");
    const retry = await save(h);
    await finish(writes[1]);
    await retry.result;
    expect(h.current.dirty).toBe(false);
  });

  it("cancels a pending autosave when autosave is disabled", async () => {
    vi.useFakeTimers();
    mocks.preferences.editorAutoSave = true;
    const h = await open();
    edit(h, "changed");
    mocks.preferences.editorAutoSave = false;
    await h.render("/a.txt");
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(writes).toHaveLength(0);
    expect(h.current.dirty).toBe(true);
  });

  it("does not rerender the editor for each keystroke after becoming dirty", async () => {
    const h = await open();
    edit(h, "one");
    const count = h.renderCount;
    edit(h, "two");
    expect(h.renderCount).toBe(count);
    edit(h, "three");
    expect(h.renderCount).toBe(count);
    const pending = await save(h);
    expect(writes[0].args.content).toBe("three");
    await finish(writes[0]);
    await pending.result;
    expect(h.current.dirty).toBe(false);
  });
});
