import {expect,test} from "vitest";
import {CHAT_TRANSLATIONS} from "./translations-chat";
import {tr} from "./i18n";
test.each(["pt-BR","fr","de"] as const)("chat review and failure controls translate in %s while source content stays verbatim",locale=>{
 for(const key of Object.keys(CHAT_TRANSLATIONS)){expect(tr(key,locale)).not.toBe(key);}
 expect(tr("Reviewed {reviewed} of {total} transcript chunks.",locale,{reviewed:2,total:9})).not.toContain("{reviewed}");
 expect(tr("Ana: Vamos aprovar sexta-feira.",locale)).toBe("Ana: Vamos aprovar sexta-feira.");
});
