import { mockIPC } from "@tauri-apps/api/mocks";
import { vi } from "vitest";

export type Entry = [string, unknown];

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

type Subscription = {
  id: number;
  event: string;
  callback: (event: { payload: Record<string, unknown> }) => void;
  stopped: boolean;
  cleanupCalls: number;
  cleanupFailure?: Error;
};

/** Exercise the actual Tauri Store/event adapters, replacing only IPC. */
export function preferencesFixture() {
  const fixture = {
    entries: [] as Entry[],
    subscriptions: [] as Subscription[],
    openFailure: undefined as Error | undefined,
    readFailure: undefined as Error | undefined,
    writeFailures: new Map<string, Error>(),
    beforeWrite: undefined as
      | ((key: string, value: unknown) => Promise<void>)
      | undefined,
    failedEvent: undefined as string | undefined,
    pendingRead: undefined as ReturnType<typeof deferred<Entry[]>> | undefined,
    pendingEvent: undefined as
      | { event: string; ready: ReturnType<typeof deferred<void>> }
      | undefined,
    emit(event: string, payload: Record<string, unknown>) {
      for (const subscription of fixture.subscriptions) {
        if (subscription.event === event && !subscription.stopped) {
          subscription.callback({ payload });
        }
      }
    },
  };
  const invoke = vi.fn(
    async (
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<unknown> => {
      switch (command) {
        case "plugin:store|load": {
          if (fixture.openFailure) {
            const failure = fixture.openFailure;
            fixture.openFailure = undefined;
            throw failure;
          }
          return 7;
        }
        case "plugin:store|entries": {
          if (fixture.readFailure) throw fixture.readFailure;
          return fixture.pendingRead
            ? fixture.pendingRead.promise
            : fixture.entries;
        }
        case "plugin:store|set": {
          const failure = fixture.writeFailures.get(args.key as string);
          if (failure) throw failure;
          await fixture.beforeWrite?.(args.key as string, args.value);
          fixture.entries = fixture.entries.filter(([key]) => key !== args.key);
          fixture.entries.push([args.key as string, args.value]);
          fixture.emit("store://change", {
            resourceId: 7,
            key: args.key,
            value: args.value,
            exists: true,
          });
          return;
        }
        case "plugin:store|save":
          return;
        case "plugin:event|listen": {
          if (fixture.failedEvent === args.event)
            throw new Error("listener unavailable");
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__: {
                callbacks: Map<number, Subscription["callback"]>;
              };
            }
          ).__TAURI_INTERNALS__;
          const callback = internals.callbacks.get(args.handler as number);
          if (!callback) throw new Error("Missing Tauri event callback");
          fixture.subscriptions.push({
            id: args.handler as number,
            event: args.event as string,
            callback,
            stopped: false,
            cleanupCalls: 0,
          });
          const pendingEvent = fixture.pendingEvent;
          if (pendingEvent && pendingEvent.event === args.event)
            await pendingEvent.ready.promise;
          return args.handler;
        }
        case "plugin:event|unlisten": {
          const subscription = fixture.subscriptions.find(
            (item) => item.id === args.eventId,
          );
          if (!subscription) throw new Error("Unknown event subscription");
          subscription.cleanupCalls += 1;
          if (subscription.cleanupFailure) throw subscription.cleanupFailure;
          subscription.stopped = true;
          return;
        }
        case "plugin:event|emit":
          fixture.emit(
            args.event as string,
            args.payload as Record<string, unknown>,
          );
          return;
        default:
          throw new Error(`Unexpected IPC command: ${command}`);
      }
    },
  );
  mockIPC((command, args) => {
    if (
      args &&
      (Array.isArray(args) ||
        args instanceof ArrayBuffer ||
        ArrayBuffer.isView(args))
    ) {
      throw new Error("Unexpected binary preferences IPC payload");
    }
    return invoke(command, args);
  });
  return Object.assign(fixture, { invoke });
}
