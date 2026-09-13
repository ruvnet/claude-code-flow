/** Bounded, no-follow descriptor reads shared by runtime admission. */
import assert from 'node:assert/strict';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

export function readBoundRegularFile(path, maximumBytes, label = 'file') {
  assert(Number.isSafeInteger(maximumBytes) && maximumBytes > 0, 'positive read ceiling');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true });
    assert(before.isFile() && before.size > 0n && before.size <= BigInt(maximumBytes), `${label} regular bounded file`);
    const length = Number(before.size), bytes = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const count = readSync(fd, bytes, offset, length - offset, offset);
      assert(count > 0, `${label} truncated during descriptor read`); offset += count;
    }
    const extra = Buffer.allocUnsafe(1);
    assert.equal(readSync(fd, extra, 0, 1, length), 0, `${label} grew during descriptor read`);
    const after = fstatSync(fd, { bigint: true });
    for (const field of ['dev','ino','size','mtimeNs','ctimeNs'])
      assert.equal(after[field], before[field], `${label} descriptor identity changed`);
    return { bytes, mode: Number(after.mode & 0o777n), size: length,
      device: before.dev.toString(), inode: before.ino.toString() };
  } finally { closeSync(fd); }
}
