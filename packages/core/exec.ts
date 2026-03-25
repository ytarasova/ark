/**
 * Low-level process management via POSIX system calls.
 * Uses posix_spawn (fork-safe in multi-threaded processes) + waitpid.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { platform } from "os";

const libName = platform() === "darwin" ? "libc.dylib" : "libc.so.6";

const libc = dlopen(libName, {
  posix_spawnp: {
    args: [
      FFIType.ptr,    // pid_t *pid
      FFIType.ptr,    // const char *file
      FFIType.ptr,    // posix_spawn_file_actions_t *file_actions (NULL)
      FFIType.ptr,    // posix_spawnattr_t *attrp (NULL)
      FFIType.ptr,    // char *const argv[]
      FFIType.ptr,    // char *const envp[] (NULL = inherit)
    ],
    returns: FFIType.i32,
  },
  waitpid: {
    args: [FFIType.i32, FFIType.ptr, FFIType.i32],
    returns: FFIType.i32,
  },
});

/**
 * Spawn a process with posix_spawnp (fork-safe) and wait for it.
 * The child inherits stdin/stdout/stderr from the parent.
 * Returns the child's exit code.
 */
export function spawnAndWait(cmd: string, args: string[]): number {
  const allArgs = [cmd, ...args];

  // Build C strings
  const cStrings = allArgs.map(a => Buffer.from(a + "\0"));

  // Build argv: array of pointers to C strings + NULL
  const argv = Buffer.alloc((allArgs.length + 1) * 8);
  for (let i = 0; i < cStrings.length; i++) {
    argv.writeBigUInt64LE(BigInt(ptr(cStrings[i])), i * 8);
  }
  argv.writeBigUInt64LE(0n, allArgs.length * 8);

  // pid output
  const pidBuf = Buffer.alloc(4);

  // Spawn
  const err = libc.symbols.posix_spawnp(
    ptr(pidBuf),       // &pid
    ptr(cStrings[0]),  // file (command name)
    null,              // file_actions (inherit parent's fds)
    null,              // attrp (defaults)
    ptr(argv),         // argv
    null,              // envp (inherit)
  );

  if (err !== 0) {
    throw new Error(`posix_spawnp failed with error ${err}`);
  }

  const pid = pidBuf.readInt32LE(0);

  // Wait for child
  const statusBuf = Buffer.alloc(4);
  libc.symbols.waitpid(pid, ptr(statusBuf), 0);
  const status = statusBuf.readInt32LE(0);

  // WEXITSTATUS
  return (status >> 8) & 0xff;
}
