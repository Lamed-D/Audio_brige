import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const outputNames = ['background', 'content', 'offscreen', 'sidepanel'];

await Promise.all(
  outputNames.flatMap((name) => [
    rm(resolve('extension', `${name}.js`), { force: true }),
    rm(resolve('extension', `${name}.js.map`), { force: true }),
  ]),
);
