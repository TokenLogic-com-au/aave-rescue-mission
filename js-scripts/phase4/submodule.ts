import {execFileSync} from 'child_process';

/** A Git submodule's checked-out state: commit, exact tag if any, and whether tracked files are untouched. */
export type SubmoduleState = {commit: string; tag?: string};

const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {encoding: 'utf8'}).trim();

/** Throws unless the submodule at `dir` is clean and at `expectedCommit`; returns its commit and tag. */
export function checkSubmodulePin(
  dir: string,
  name: string,
  expectedCommit: string
): SubmoduleState {
  const commit = git(dir, 'rev-parse', 'HEAD');
  if (commit !== expectedCommit)
    throw new Error(
      `${name} is at ${commit}, expected ${expectedCommit}; update the pin and regenerate`
    );
  if (git(dir, 'status', '--porcelain', '--untracked-files=no'))
    throw new Error(
      `${name} has local modifications; the pinned commit does not describe its files`
    );
  let tag: string | undefined;
  try {
    tag = git(dir, 'describe', '--tags', '--exact-match');
  } catch {
    tag = undefined;
  }
  return tag ? {commit, tag} : {commit};
}
