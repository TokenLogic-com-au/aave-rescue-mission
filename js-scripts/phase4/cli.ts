import {ChainConfig} from './chains';

/** Error text safe to write anywhere: RPC URLs (which embed the API key) and client noise removed. */
export function redact(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/\S+/g, '<rpc>')
    .replace(/\nVersion: viem@\S+/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .trim();
}

/** A chain the run could not complete; manifests are final only when this list is empty. */
export type ChainFailure = {chainId: number; alias: string; reason: string};

export function chainFailure(
  chain: ChainConfig,
  error: unknown,
  log: (line: string) => void
): ChainFailure {
  const reason = redact(error);
  log(`${chain.alias} (${chain.chainId}): failed: ${reason}`);
  return {chainId: chain.chainId, alias: chain.alias, reason};
}

/** Script entry point: one redacted error line and a non-zero exit on any failure. */
export function runCli(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(redact(error));
    process.exitCode = 1;
  });
}
