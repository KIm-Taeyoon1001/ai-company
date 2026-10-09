// functions/src/engine.ts 를 웹으로 복사한다. 게임 규칙의 원본은 functions 쪽 하나뿐이다.
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../../functions/src/engine.ts", import.meta.url), "utf8");
writeFileSync(
  new URL("../lib/engine.ts", import.meta.url),
  "// functions/src/engine.ts 사본. 수정은 원본에서 하고 npm run sync-engine 으로 복사한다.\n" + src,
);
