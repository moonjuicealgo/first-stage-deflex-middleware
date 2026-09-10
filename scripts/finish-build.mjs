import { writeFileSync } from 'node:fs'

// Node decides whether a .js file is ESM or CommonJS from the nearest package.json, so each
// build directory needs its own marker. Without this the ESM build would be read as
// CommonJS, and a consumer would end up with two copies of algosdk whose Transaction and
// Address classes fail every instanceof check the other side makes.
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2))
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2))
