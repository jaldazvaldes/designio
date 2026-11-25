import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function hashText(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Escritura atómica: archivo temporal + renombrado. Reintenta ante bloqueos breves
 * de Windows (antivirus, indexador) que devuelven EPERM/EBUSY/EACCES.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') && attempt < 10) {
        await sleep(30 * (attempt + 1));
        continue;
      }
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }
}
