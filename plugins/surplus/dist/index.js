// AntSeed CLI resolves dist/index.js directly instead of package.json exports.
// Keep this entrypoint identical to the reviewed source module.
export {default} from '../index.mjs';
export * from '../index.mjs';
