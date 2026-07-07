import { WorkflowCancelledError, WorkflowTimeoutError } from "./errors.js";

export async function withTimeout(factory, { timeoutMs, signal, label, onTimeout }) {
  if (signal?.aborted) {
    Promise.resolve().then(() => onTimeout?.("abort")).catch(() => {});
    throw new WorkflowCancelledError();
  }
  let timeout;
  let abortListener;
  try {
    return await Promise.race([
      Promise.resolve().then(factory),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          reject(new WorkflowTimeoutError(`${label} timed out after ${timeoutMs}ms`));
          Promise.resolve().then(() => onTimeout?.()).catch(() => {
            // Timeout cleanup is best effort; the timeout itself is still authoritative.
          });
        }, timeoutMs);
        abortListener = () => {
          reject(new WorkflowCancelledError());
          Promise.resolve().then(() => onTimeout?.("abort")).catch(() => {
            // Abort cleanup is best effort; the abort itself is still authoritative.
          });
        };
        signal?.addEventListener("abort", abortListener, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    if (abortListener) signal?.removeEventListener("abort", abortListener);
  }
}
