
import { readZipFile } from './utils/zipReader';

async function processZipFile(zipPath: string) {
  try {
    const files = await readZipFile(zipPath);
    
    for (const [fileName, content] of files) {
      console.log(`File: ${fileName}, Size: ${content.length} bytes`);
      // Process each file as needed
    }
  } catch (error) {
    console.error('Error reading ZIP file:', error);
  }
}
