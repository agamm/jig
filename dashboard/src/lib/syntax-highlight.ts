import { codeToHtml, type BundledLanguage, type BundledTheme } from "shiki/bundle/web";

const LANGUAGE: BundledLanguage = "typescript";
const THEME: BundledTheme = "github-dark";

export function highlightTypeScript(code: string): Promise<string> {
  return codeToHtml(code, {
    lang: LANGUAGE,
    theme: THEME,
  });
}
