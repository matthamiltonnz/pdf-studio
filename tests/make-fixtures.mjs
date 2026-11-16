import { PDFDocument, StandardFonts, degrees, rgb } from 'pdf-lib';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
await mkdir(root, { recursive: true });

async function makeDocument(file, pageSizes, colors, rotation = 0) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pageSizes.length; i += 1) {
    const [width, height] = pageSizes[i];
    const page = doc.addPage([width, height]);
    const color = colors[i % colors.length];
    page.drawRectangle({ x: 0, y: height - 100, width, height: 100, color: rgb(color[0], color[1], color[2]) });
    page.drawText(`Page ${i + 1}`, { x: 40, y: height - 190, size: 28, font, color: rgb(0.1, 0.12, 0.2) });
    page.drawText('PDF Studio test document', { x: 40, y: height - 230, size: 14, font, color: rgb(0.3, 0.35, 0.45) });
    if (rotation) page.setRotation(degrees(rotation));
  }
  await writeFile(path.join(root, file), await doc.save());
}

await makeDocument('alpha.pdf', [[400, 500], [420, 520], [440, 540]], [[0.15, 0.4, 0.8], [0.2, 0.6, 0.5], [0.7, 0.3, 0.5]]);
await makeDocument('beta.pdf', [[400, 500], [400, 500]], [[0.8, 0.5, 0.2], [0.4, 0.4, 0.7]]);
await makeDocument('rotated.pdf', [[400, 500]], [[0.2, 0.5, 0.7]], 90);
await makeDocument('rotated-180.pdf', [[400, 500]], [[0.3, 0.45, 0.65]], 180);
await makeDocument('rotated-270.pdf', [[400, 500]], [[0.55, 0.35, 0.6]], 270);
console.log('Fixtures written to', root);
