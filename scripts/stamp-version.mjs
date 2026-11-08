// 배포 직전에 파일 주소 뒤에 ?v=<버전>을 붙여, 브라우저가 예전 JS·CSS·데이터를 캐시에서 꺼내 쓰지 않게 합니다.
// GitHub Pages는 모든 파일을 10분간 캐시하므로, 버전이 없으면 새로고침해도 예전 화면이 보일 수 있어요.
//
// 사용법: node scripts/stamp-version.mjs <dist 폴더> <버전>
// 배포 워크플로가 업로드 직전에 실행합니다. 저장소의 dist/ 원본은 고치지 않습니다.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const [dir, version] = process.argv.slice(2);
if (!dir || !/^[\w.-]{1,64}$/.test(version ?? '')) {
  console.error('사용법: node scripts/stamp-version.mjs <dist 폴더> <버전(영문·숫자)>');
  process.exit(1);
}

// './이름.js|.css|.json' 같은 같은 폴더의 상대 주소에만 버전을 붙입니다(이미지·외부 주소는 그대로).
const stamp = text => text.replace(/(["'])\.\/([\w-]+\.(?:js|css|json))\1/g, `$1./$2?v=${version}$1`);

const files = (await readdir(dir)).filter(name => /\.(?:html|js)$/.test(name));
for (const name of files) {
  const path = join(dir, name);
  const before = await readFile(path, 'utf8');
  const after = stamp(before);
  if (after !== before) {
    await writeFile(path, after);
    console.log(`버전 ${version} 적용: ${name}`);
  }
}
