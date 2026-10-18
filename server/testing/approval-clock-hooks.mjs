import { registerHooks } from 'node:module';
import { join } from 'node:path';
const dataDir = process.env.QUATI_DATA_DIR;
if (!dataDir || dataDir !== process.env.HOME || process.env.QUATI_TEST_APPROVAL_CLOCK !== '1') {
  throw new Error('The approval clock requires an explicitly isolated fixture');
}
const marker = join(dataDir, 'expire-approvals');
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.endsWith('/server/drivers/acp/core.ts')) return result;
    const source = String(result.source);
    const anchor = `const timer = setTimeout(() => {
            emit({ ...base(threadId, current.turnId), type: "runtime.error", message: DENY_TIMEOUT_NOTE });
            finish("deny", "timeout");
          }, 15 * 60_000);`;
    if (source.split(anchor).length !== 2) throw new Error('ACP permission deadline seam changed');
    return { ...result, source: `
      import { existsSync as approvalMarkerExists } from 'node:fs';
      function approvalFixtureTimeout(callback, _delay) {
        const timer = setInterval(() => {
          if (!approvalMarkerExists(${JSON.stringify(marker)})) return;
          clearInterval(timer);
          callback();
        }, 25);
        return timer;
      }
    ` + source.replace(anchor, anchor.replace('setTimeout', 'approvalFixtureTimeout')) };
  },
});
