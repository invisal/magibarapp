/**
 * The host-process half of `HostTransport.request`: numbers each request,
 * posts it over whatever channel the process has, and resolves when main's
 * matching `response` message arrives. Shared by `list-host-process.ts` and
 * `no-view-worker.ts`, which differ only in the channel.
 */
import type { HostRequest } from "./protocol.ts";
import type {
  HostRequestMessage,
  HostResponseMessage,
} from "./list-host-messages.ts";

export interface RequestClient {
  request(request: HostRequest): Promise<unknown>;
  handleResponse(message: HostResponseMessage): void;
}

export function createRequestClient(
  post: (message: HostRequestMessage) => void,
): RequestClient {
  let nextRequestId = 0;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  return {
    request(request) {
      return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        pending.set(requestId, { resolve, reject });
        post({ type: "request", requestId, request });
      });
    },
    handleResponse(message) {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    },
  };
}
