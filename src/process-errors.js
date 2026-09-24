import { isTransientTelegramError } from './retry.js';
import { isStorageFailure } from './resilient-store.js';

export function installProcessErrorHandlers({ target = process, log = console.error, onStorageFailure, onFatal }) {
  const handle = (event, error) => {
    // Never log raw exceptions: Telegram URLs and payloads may contain secrets/PII.
    log(JSON.stringify({ event }));
    if (event === 'unhandled_rejection') {
      if (isTransientTelegramError(error)) return;
      if (isStorageFailure(error)) {
        try { onStorageFailure(); return; } catch { /* Fall through to controlled shutdown. */ }
      }
    }
    // Unknown failures may leave interrupted transactions or dead workers. Keep
    // recoverable operations alive at their boundary, but restart unsafe processes.
    onFatal();
  };
  const rejection = error => handle('unhandled_rejection', error);
  const exception = error => handle('uncaught_exception', error);
  target.on('unhandledRejection', rejection);
  target.on('uncaughtException', exception);
  return () => {
    target.off('unhandledRejection', rejection);
    target.off('uncaughtException', exception);
  };
}
