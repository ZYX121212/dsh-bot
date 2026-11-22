import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import vm from 'node:vm';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFile(resolve(root, path), 'utf8');
const pkg = JSON.parse(await read('package.json'));
const result = await build({
  absWorkingDir: root,
  entryPoints: ['src/team-client.jsx'], bundle: true, write: false,
  platform: 'browser', format: 'cjs', target: 'es2022',
  external: ['react'], loader: { '.css': 'text' },
  jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment',
  legalComments: 'none', minify: false, sourcemap: false
});
// React is provided by DSH; all materialization side effects stay in the factory.
const bundle = `window.__ModuleLoader__.load({\n id: ${JSON.stringify(pkg.name)},\n factory: (require) => {\n'use strict';\nconst module = { exports: {} };\nconst exports = module.exports;\n${result.outputFiles[0].text}\nreturn module.exports;\n}\n});\n`;
new vm.Script(bundle, { filename: 'client.js' });
await mkdir(resolve(root, 'lib'), { recursive: true });
await writeFile(resolve(root, 'lib/client.js'), bundle);
for (const name of ['index.js', 'readonly.js', 'host-service.js', 'host-store.mjs']) await writeFile(resolve(root, 'lib', name), await read(`src/${name}`));
console.log(`Built ${pkg.name}@${pkg.version}: ${Buffer.byteLength(bundle)} browser bytes; native SDK peers remain external.`);
