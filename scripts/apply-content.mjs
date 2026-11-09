import { projectRoot } from './curation.mjs';
import { createSourceOperations } from './source-operations.mjs';
console.log(await createSourceOperations().apply(projectRoot,p=>console.log(p.message)));
