import path from 'node:path';

const { serializeReplyMediaFile } = await import(process.argv[2]);
const relative = process.argv[3];
const expected = Buffer.from('worker image');
process.send({
  images: await Promise.all([
    `file://./${relative}`,
    `./${relative}`,
    path.resolve(relative)
  ].map(serializeReplyMediaFile)),
  buffer: await serializeReplyMediaFile(expected),
  url: await serializeReplyMediaFile('https://example.com/a.jpg'),
  base64: await serializeReplyMediaFile('base64://YWJj'),
  missing: await serializeReplyMediaFile('file://./missing.jpg')
});
process.disconnect();
