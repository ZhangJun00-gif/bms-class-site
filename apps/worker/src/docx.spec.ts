import { Readable } from 'node:stream';
import { extractWordDocumentXml } from './docx';

describe('DOCX text extraction', () => {
  it('streams paragraphs, table cells, tabs, line breaks, and entities', async () => {
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<w:document xmlns:w="urn:test"><w:body>',
      '<w:p><w:r><w:t>第一段 &amp; 内容</w:t></w:r><w:tab/><w:r><w:t>续行</w:t></w:r></w:p>',
      '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>单元格</w:t></w:r><w:br/><w:r><w:t>下一行</w:t></w:r></w:p></w:tc></w:tr></w:tbl>',
      '</w:body></w:document>',
    ].join('');
    const encoded = Buffer.from(xml);
    const firstChineseCharacter = encoded.indexOf(Buffer.from('第'));
    const pieces = [
      encoded.subarray(0, firstChineseCharacter + 1),
      encoded.subarray(firstChineseCharacter + 1, firstChineseCharacter + 2),
      encoded.subarray(firstChineseCharacter + 2),
    ];

    await expect(extractWordDocumentXml(Readable.from(pieces))).resolves.toBe(
      '第一段 & 内容\t续行\n单元格\n下一行',
    );
  });

  it('ignores text outside Word text runs', async () => {
    const xml =
      '<w:document><w:body><w:p>ignored<w:r><w:t>kept</w:t></w:r></w:p></w:body></w:document>';
    await expect(extractWordDocumentXml(Readable.from([xml]))).resolves.toBe(
      'kept',
    );
  });
});
