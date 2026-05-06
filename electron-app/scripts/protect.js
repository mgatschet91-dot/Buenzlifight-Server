/**
 * Kompiliert main.src.js zu V8-Bytecode (main.jsc).
 * preload.src.js wird NUR kopiert (kein Bytecode) da bytenode
 * im preload-Kontext nicht auflösbar ist.
 */
const bytenode = require('bytenode');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function compileMain(srcFile, jscFile) {
  console.log(`  Kompiliere: ${path.basename(srcFile)} → ${path.basename(jscFile)}`);
  bytenode.compileFile({ filename: srcFile, output: jscFile });
  const wrapperFile = jscFile.replace(/\.jsc$/, '.js');
  const jscName = path.basename(jscFile);
  fs.writeFileSync(wrapperFile, `require('bytenode');\nrequire('./${jscName}');\n`);
  console.log(`  ✓ ${path.basename(wrapperFile)} (Wrapper) + ${jscName} (Bytecode)`);
}

function copyPreload(srcFile, destFile) {
  console.log(`  Kopiere:    ${path.basename(srcFile)} → ${path.basename(destFile)}`);
  fs.copyFileSync(srcFile, destFile);
  console.log(`  ✓ ${path.basename(destFile)} (Source, kein Bytecode)`);
}

console.log('\n[Protect] Starte Schutz...');

compileMain(
  path.join(ROOT, 'main.src.js'),
  path.join(ROOT, 'main.jsc')
);

copyPreload(
  path.join(ROOT, 'preload.src.js'),
  path.join(ROOT, 'preload.js')
);

console.log('[Protect] Fertig! main.jsc (Bytecode) + preload.js (Source).\n');
