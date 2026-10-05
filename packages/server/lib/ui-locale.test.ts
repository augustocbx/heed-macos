import { expect, test } from "bun:test";
import { configuredUiLocale, supportedUiLocale } from "./ui-locale";
test("interface locales are explicit and unsupported or missing preferences fall back to English",()=>{
 for(const locale of ["en","pt-BR","fr","de"]) {expect(supportedUiLocale(locale)).toBe(true);expect(configuredUiLocale({ui_locale:locale})).toBe(locale);}
 for(const locale of [undefined,null,"es",123]) {expect(supportedUiLocale(locale)).toBe(false);expect(configuredUiLocale({ui_locale:locale})).toBe("en");}
});
test("UI preference does not consume or change the transcription language",()=>{
 const config={ui_locale:"fr",language:"pt",modelSize:"large-v3"};
 expect(configuredUiLocale(config)).toBe("fr");expect(config.language).toBe("pt");expect(config.modelSize).toBe("large-v3");
});

test("regional preferences resolve to a supported interface locale",()=>{
 for(const [value,expected] of [["pt","pt-BR"],["pt-PT","pt-BR"],["fr-CA","fr"],["de-DE","de"],["en-US","en"],["zh-CN","en"]]) expect(configuredUiLocale({ui_locale:value})).toBe(expected);
});
