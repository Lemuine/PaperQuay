import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { parseFragment } from 'parse5';

test('PDF annotation colors can wrap inside a narrow panel without removing any control', async () => {
  const server = await createServer({ configFile: false, logLevel: 'silent', plugins: [react()], server: { middlewareMode: true }, appType: 'custom' });
  try {
    const { PdfViewerToolbar } = await server.ssrLoadModule('/src/features/pdf/PdfViewerToolbar.tsx');
    const html = renderToStaticMarkup(createElement(PdfViewerToolbar, {
      activeColorTool: 'highlight', annotationColors: { highlight: '#fff080', freetext: '#000000', ink: '#000000' },
      currentPage: 1, pageCount: 4, l: (zh) => zh,
      translationProgressCompleted: 0, translationProgressTotal: 0,
    }));
    const nodes = [];
    const collect = node => { nodes.push(node); for (const child of node.childNodes ?? []) collect(child); };
    collect(parseFragment(html));
    const toolbarClasses = nodes.find(node => node.tagName === 'div').attrs.find(attr => attr.name === 'class').value;
    assert.match(toolbarClasses, /max-h-\[40%\]/);
    assert.match(toolbarClasses, /\boverflow-y-auto\b/);
    const colors = nodes.filter(node => node.tagName === 'button' && node.attrs.some(attr => attr.name === 'aria-label' && ['黄色', '绿色', '蓝色', '粉色', '红色'].includes(attr.value)));
    assert.equal(colors.length, 5);
    const palette = colors[0].parentNode;
    assert.match(palette.attrs.find(attr => attr.name === 'class').value, /\bflex-wrap\b/);
    assert.match(palette.parentNode.attrs.find(attr => attr.name === 'class').value, /\bmax-w-full\b/);
    assert.ok(colors.every(node => node.parentNode === palette));
  } finally { await server.close(); }
});
