import i18n from "i18next"
import { initReactI18next } from "react-i18next"
import en from "./en.json"
import ja from "./ja.json"

export const LANGUAGE_CODE_MAP: Record<string, string> = {
	English: "en",
	"Arabic - العربية": "ar",
	"Portuguese - Português (Brasil)": "pt-BR",
	"Czech - Čeština": "cs",
	"French - Français": "fr",
	"German - Deutsch": "de",
	"Hindi - हिन्दी": "hi",
	"Hungarian - Magyar": "hu",
	"Italian - Italiano": "it",
	"Japanese - 日本語": "ja",
	"Korean - 한국어": "ko",
	"Polish - Polski": "pl",
	"Portuguese - Português (Portugal)": "pt-PT",
	"Russian - Русский": "ru",
	"Simplified Chinese - 简体中文": "zh-CN",
	"Spanish - Español": "es",
	"Traditional Chinese - 繁體中文": "zh-TW",
	"Turkish - Türkçe": "tr",
}

i18n.use(initReactI18next).init({
	resources: {
		en: { translation: en },
		ja: { translation: ja },
	},
	lng: "en",
	fallbackLng: "en",
	interpolation: { escapeValue: false },
})

export default i18n
