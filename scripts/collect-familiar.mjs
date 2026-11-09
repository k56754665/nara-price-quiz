import { projectRoot,readJSON } from './curation.mjs';
import path from 'node:path';
import { createFamiliarSourceOperations } from './familiar-collection.mjs';
import { collectionPreset } from './collection-presets.mjs';
const limit=process.argv.find(arg=>arg.startsWith('--max-requests='))?.split('=')[1];
const topicId=process.argv.find(arg=>arg.startsWith('--topic='))?.split('=')[1];
let searches;
if(topicId){const plan=await readJSON(path.join(projectRoot,'content/familiar-item-topics.json'));const topic=plan.topics.find(topic=>topic.id===topicId);if(!topic)throw Error('목록에 없는 종류입니다.');searches=[[topic.id,topic.keywords[0]]];}
const result=await createFamiliarSourceOperations({maxRequests:process.argv.includes('--cache-only')?0:limit===undefined?collectionPreset().maxRequests:Number(limit),searches}).collect(projectRoot,progress=>console.log(JSON.stringify(progress)));
console.log(JSON.stringify(result,null,2));
