
import * as yauzl from 'yauzl';
import { promisify } from 'util';

export async function readZipFile(zipFilePath: string): Promise<Map<string, Buffer>> {
  const fileContents = new Map<string, Buffer>();

  return new Promise((resolve, reject) => {
    yauzl.open(zipFilePath, { lazyEntries: true }, (err, zipfile) => {
      if (err) {
        reject(err);
        return;
      }

      zipfile.on('entry', (entry) => {
        if (/\/$/.test(entry.fileName)) {
          // Directory entry
          zipfile.readEntry();
        } else {
          // File entry
          zipfile.openReadStream(entry, (err, readStream) => {
            if (err) {
              reject(err);
              return;
            }

            const chunks: Buffer[] = [];
            readStream.on('data', (chunk) => chunks.push(chunk));
            readStream.on('end', () => {
              fileContents.set(entry.fileName, Buffer.concat(chunks));
              zipfile.readEntry();
            });
          });
        }
      });

      zipfile.on('end', () => {
        resolve(fileContents);
      });

      zipfile.readEntry();
    });
  });
}
